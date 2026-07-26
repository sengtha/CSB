/**
 * Public-good fund transparency data.
 *
 * This backs the one page on the app that is deliberately PUBLIC — no passcode,
 * no session. Everywhere else the app restricts each user to their own data
 * (see rpc-filter.js); here the whole point is the opposite. The fund is an
 * institutional account whose entire history should be readable by anyone, and
 * exposing it is the transparency claim being demonstrated rather than a hole
 * in the privacy model.
 *
 * It is still deliberately NARROW: it serves this one address's public data and
 * nothing else. It is not a general RPC passthrough, so it cannot be used to
 * read anybody else's balances or transactions.
 *
 * Two income streams, which arrive by completely different routes:
 *
 *   levy      — a flat charge per KHRt payment, moved by contract code. It emits
 *               a normal Transfer event, so each payment has a transaction hash
 *               and a payer, and can be listed.
 *   gas fees  — routed by the RewardManager precompile at block production. This
 *               is NOT a transaction: no tx hash, no log, no trace. The credit
 *               only shows up as the account's balance being higher than it was
 *               in the previous block. So the only honest way to show it is to
 *               diff the balance block by block, which is what scanGasIncome
 *               does — and why a native transfer into the fund has to be
 *               subtracted out, or it would be misreported as fee income.
 */

// Function selectors (hashed, not guessed — server.js has no ethers dependency).
const SEL = {
  balanceOf: "0x70a08231",
  totalLevied: "0x35b8f1d9",
  transferLevy: "0xc741844a",
  levyRecipient: "0x160b216d",
  decimals: "0x313ce567",
  symbol: "0x95d89b41",
  currentRewardAddress: "0xe915608b",
};
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const REWARD_MANAGER = "0x0200000000000000000000000000000000000004";

// Block-scan bounds. The chain only produces a block when there is something to
// include, so on a quiet chain this covers a long stretch of wall-clock time.
const DEFAULT_SCAN = 250;
// Each scanned block costs TWO node calls — eth_getBalance plus
// eth_getBlockByNumber with full transaction objects. `blocks` is caller-supplied
// on a PUBLIC endpoint, so the old ceiling of 2000 let anyone ask this server for
// 4000 calls against the node, repeatedly. 600 keeps the worst case at 1200.
const MAX_SCAN = 600;
const CACHE_MS = 15000;

let _cache = null;
// One scan at a time. The cache stops repeat work but not a stampede: several
// viewers arriving just after it expires would each start their own walk.
let _inflight = null;

function pad32(addr) {
  return "000000000000000000000000" + addr.toLowerCase().replace(/^0x/, "");
}

function makeRpc(rpcUrl) {
  let id = 0;
  return async function rpc(method, params = []) {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    const j = await res.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  };
}

const hexToBig = (h) => (typeof h === "string" && h !== "0x" ? BigInt(h) : 0n);
const addrFromWord = (w) => (typeof w === "string" && w.length >= 66 ? "0x" + w.slice(-40) : null);

/** Decode a solidity string return value (offset, length, bytes). */
function decodeString(hex) {
  try {
    const b = hex.replace(/^0x/, "");
    const len = Number(BigInt("0x" + b.slice(64, 128)));
    const bytes = b.slice(128, 128 + len * 2);
    return Buffer.from(bytes, "hex").toString("utf8");
  } catch (_) { return null; }
}

/** Format a base-unit integer with `decimals` places, without floating point. */
function units(v, decimals) {
  const d = BigInt(decimals);
  const base = 10n ** d;
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = d > 0n ? "." + frac.toString().padStart(Number(d), "0") : "";
  return (neg ? "-" : "") + whole.toString() + fracStr;
}

/**
 * Gas-fee income, reconstructed from per-block balance deltas.
 *
 * Any balance increase that is not explained by a native transfer into the
 * account is fee income. Subtracting the explicit transfers matters: without it
 * someone simply sending tRIEL to the fund would be presented as gas fees the
 * chain had collected, which would be a false claim on a page whose entire
 * purpose is to be trustworthy.
 */
async function scanGasIncome(rpc, fund, fromBlock, toBlock) {
  const entries = [];
  let total = 0n;
  let oldestScanned = null;
  let pruned = false;
  const target = fund.toLowerCase();

  const balanceAt = (n) => rpc("eth_getBalance", [fund, "0x" + Math.max(n, 0).toString(16)]);

  // Walk BACKWARDS from the newest block. A node that prunes state answers
  // "missing trie node" for old blocks, and walking forwards would hit that on
  // the very first call and yield nothing at all. Going backwards returns
  // whatever recent history the node still holds and stops cleanly at the edge
  // of the pruning window.
  let higher;
  try {
    higher = hexToBig(await balanceAt(toBlock));
  } catch (e) {
    return { entries, total, pruned: true, oldestScanned: null, reason: String(e.message ?? e) };
  }

  for (let n = toBlock; n >= fromBlock; n--) {
    let lower, block;
    try {
      [lower, block] = await Promise.all([
        balanceAt(n - 1).then(hexToBig),
        rpc("eth_getBlockByNumber", ["0x" + n.toString(16), true]),
      ]);
    } catch (e) {
      // State for this block is gone. Everything older is gone too.
      pruned = true;
      break;
    }
    oldestScanned = n;
    const delta = higher - lower;
    higher = lower;
    if (delta === 0n || !block) continue;

    let transferredIn = 0n;
    let sentOut = false;
    for (const tx of block.transactions ?? []) {
      if ((tx.to ?? "").toLowerCase() === target) transferredIn += hexToBig(tx.value);
      if ((tx.from ?? "").toLowerCase() === target) sentOut = true;
    }
    const fees = delta - transferredIn;
    const timestamp = Number(hexToBig(block.timestamp));

    if (transferredIn > 0n) {
      entries.push({ block: n, timestamp, kind: "transfer-in", amount: units(transferredIn, 18) });
    }
    if (fees > 0n) {
      total += fees;
      entries.push({
        block: n, timestamp, kind: "gas-fees",
        amount: units(fees, 18), txCount: (block.transactions ?? []).length,
      });
    } else if (fees < 0n && !sentOut) {
      entries.push({ block: n, timestamp, kind: "unexplained-decrease", amount: units(fees, 18) });
    }
  }
  return { entries, total, pruned, oldestScanned };
}

/** KHRt levy payments — real transfers, so each has a payer and a tx hash. */
async function scanLevyPayments(rpc, token, fund, fromBlock, toBlock, decimals) {
  const logs = await rpc("eth_getLogs", [{
    address: token,
    topics: [TRANSFER_TOPIC, null, "0x" + pad32(fund)],
    fromBlock: "0x" + fromBlock.toString(16),
    toBlock: "0x" + toBlock.toString(16),
  }]);
  const times = new Map();
  const out = [];
  for (const l of logs ?? []) {
    const bn = Number(hexToBig(l.blockNumber));
    if (!times.has(bn)) {
      const b = await rpc("eth_getBlockByNumber", [l.blockNumber, false]);
      times.set(bn, b ? Number(hexToBig(b.timestamp)) : null);
    }
    out.push({
      block: bn,
      timestamp: times.get(bn),
      txHash: l.transactionHash,
      from: addrFromWord(l.topics?.[1]),
      amount: units(hexToBig(l.data), decimals),
    });
  }
  return out;
}

/**
 * Everything the public fund page needs, in one call.
 * `deployments` is app/deployments.json (may be null).
 */
async function fundReport(rpcUrl, deployments, opts = {}) {
  const now = Date.now();
  if (!opts.noCache && _cache && now - _cache.at < CACHE_MS) return _cache.data;
  if (_inflight) return _inflight;
  _inflight = _fundReport(rpcUrl, deployments, opts, now).finally(() => { _inflight = null; });
  return _inflight;
}

async function _fundReport(rpcUrl, deployments, opts, now) {

  const rpc = makeRpc(rpcUrl);

  // Prefer the chain's own answer for where fees go; fall back to deployments.
  let routedTo = null;
  try {
    routedTo = addrFromWord(await rpc("eth_call", [{ to: REWARD_MANAGER, data: SEL.currentRewardAddress }, "latest"]));
  } catch (_) { /* precompile absent */ }
  if (routedTo === "0x0000000000000000000000000000000000000000") routedTo = null;

  const fund = opts.address ?? routedTo ?? deployments?.pilot?.charity?.address ?? null;
  if (!fund) {
    const err = new Error("no public-good fund address configured on this chain");
    err.code = "NO_FUND";
    throw err;
  }

  const latest = Number(hexToBig(await rpc("eth_blockNumber")));
  const scan = Math.min(Math.max(Number(opts.blocks) || DEFAULT_SCAN, 1), MAX_SCAN);
  const fromBlock = Math.max(latest - scan + 1, 0);

  const trielRaw = hexToBig(await rpc("eth_getBalance", [fund, "latest"]));

  // --- token side (levy) --------------------------------------------------
  const token = deployments?.contracts?.KHRStablecoin ?? null;
  let tokenInfo = null;
  if (token) {
    try {
      const [balHex, leviedHex, levyHex, recipHex, decHex, symHex] = await Promise.all([
        rpc("eth_call", [{ to: token, data: SEL.balanceOf + pad32(fund) }, "latest"]),
        rpc("eth_call", [{ to: token, data: SEL.totalLevied }, "latest"]),
        rpc("eth_call", [{ to: token, data: SEL.transferLevy }, "latest"]),
        rpc("eth_call", [{ to: token, data: SEL.levyRecipient }, "latest"]),
        rpc("eth_call", [{ to: token, data: SEL.decimals }, "latest"]),
        rpc("eth_call", [{ to: token, data: SEL.symbol }, "latest"]).catch(() => null),
      ]);
      const decimals = Number(hexToBig(decHex));
      const recipient = addrFromWord(recipHex);
      tokenInfo = {
        address: token,
        symbol: (symHex && decodeString(symHex)) || "KHRt",
        decimals,
        balance: units(hexToBig(balHex), decimals),
        totalLevied: units(hexToBig(leviedHex), decimals),
        perTransfer: units(hexToBig(levyHex), decimals),
        active: hexToBig(levyHex) > 0n && recipient?.toLowerCase() === fund.toLowerCase(),
        recipient,
        _leviedRaw: hexToBig(leviedHex),
      };
    } catch (_) { tokenInfo = null; }
  }

  const [gas, levyPayments] = await Promise.all([
    scanGasIncome(rpc, fund, fromBlock, latest),
    tokenInfo ? scanLevyPayments(rpc, token, fund, fromBlock, latest, tokenInfo.decimals) : Promise.resolve([]),
  ]);

  // Both streams are riel-denominated (1 tRIEL = 1 riel = 1 KHRt), which is what
  // makes adding them meaningful rather than a category error.
  const trielRiel = Number(units(trielRaw, 18));
  const levyRiel = tokenInfo ? Number(units(tokenInfo._leviedRaw, tokenInfo.decimals)) : 0;
  if (tokenInfo) delete tokenInfo._leviedRaw;

  const data = {
    address: fund,
    label: deployments?.pilot?.charity?.label ?? "Public-good fund",
    disclaimer: "Illustrative demonstration on a test network. Valueless test tokens; "
      + "not affiliated with, endorsed by, or arranged with any real organisation.",
    triel: units(trielRaw, 18),
    gasFeesRouted: routedTo ? routedTo.toLowerCase() === fund.toLowerCase() : false,
    gasIncomeInWindow: units(gas.total, 18),
    // The per-block gas breakdown needs historical state. A pruning node keeps
    // only recent state, so the history stops at the pruning edge — the current
    // balance is still exact, only the breakdown is partial.
    gasHistory: {
      partial: gas.pruned === true,
      oldestBlock: gas.oldestScanned,
    },
    token: tokenInfo,
    totalRiel: (trielRiel + levyRiel).toFixed(2),
    activity: [...gas.entries, ...levyPayments.map((p) => ({ ...p, kind: "levy" }))]
      .sort((a, b) => b.block - a.block || (b.timestamp ?? 0) - (a.timestamp ?? 0)),
    window: {
      fromBlock: gas.oldestScanned ?? fromBlock,
      toBlock: latest,
      blocks: latest - (gas.oldestScanned ?? fromBlock) + 1,
      complete: (gas.oldestScanned ?? fromBlock) === 0 && gas.pruned !== true,
    },
    updatedAt: new Date().toISOString(),
  };

  _cache = { at: now, data };
  return data;
}

module.exports = { fundReport, units, _internal: { scanGasIncome, scanLevyPayments, decodeString } };
