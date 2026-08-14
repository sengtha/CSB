/**
 * Token and NFT data for the public asset viewer.
 *
 * Read-only, and either public information (what tokens exist on this chain) or
 * information about an address the CALLER supplied. It cannot enumerate holders,
 * cannot list who owns what, and cannot move anything — you can only look up an
 * address you already know, which is the same thing a block explorer would let
 * you do with an address someone gave you.
 *
 * That is a deliberate line. The chain's read-privacy model restricts a wallet
 * to its own data; a page that let anyone browse the full holder list would work
 * around the property the whole design exists to protect.
 */
const SEL = {
  // Hashed, not written from memory — a wrong selector here returns a plausible
  // zero rather than an error, which is the worst kind of wrong.
  name: "0x06fdde03",
  symbol: "0x95d89b41",
  decimals: "0x313ce567",
  totalSupply: "0x18160ddd",
  balanceOf: "0x70a08231",
  totalMinted: "0xa2309ff8",
  ownerOf: "0x6352211e",
  tokenURI: "0xc87b56dd",
  canMint: "0xc2ba4744",
  maxPerAddress: "0x639814e0",
  mintedCount: "0xfddcb5ea",
  paused: "0x5c975abb",
  minimumTier: "0xf1ebd5dd",
  approved: "0xd8b964e6",
  // mint(uint256) — Aave's MintableERC20 self-mint.
  mintSelf: "0xa0712d68",
};
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const MAX_TOKENS = 60; // a viewer, not an indexer
const LOG_WINDOW = 20000; // blocks; only used for collections too big to enumerate
const CACHE_MS = 8000;

let _cache = new Map();
// Requests in flight, keyed the same as the cache. Without this, N viewers
// arriving after the cache expires start N identical scans against one node —
// the cache protects the node from repeat work but not from a stampede.
const _inflight = new Map();

const hexToBig = (h) => (typeof h === "string" && h !== "0x" ? BigInt(h) : 0n);
const pad32 = (a) => "000000000000000000000000" + a.toLowerCase().replace(/^0x/, "");
/** A uint256 as a 32-byte ABI word. */
const pad32num = (v) => BigInt(v).toString(16).padStart(64, "0");
const word = (hex, i) => "0x" + hex.replace(/^0x/, "").slice(i * 64, (i + 1) * 64);
const addrFromWord = (w) => (typeof w === "string" && w.length >= 66 ? "0x" + w.slice(-40) : null);

function makeRpc(url) {
  let id = 0;
  return async (method, params = []) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    const j = await res.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  };
}

async function settle(p, fallback = null) {
  try { return await p; } catch (_) { return fallback; }
}

/** Decode a solidity `string` return value. */
function decodeString(hex) {
  try {
    const b = hex.replace(/^0x/, "");
    const off = Number(BigInt("0x" + b.slice(0, 64))) * 2;
    const len = Number(BigInt("0x" + b.slice(off, off + 64)));
    return Buffer.from(b.slice(off + 64, off + 64 + len * 2), "hex").toString("utf8");
  } catch (_) { return null; }
}

/** Decode `(bool, string)` — the shape every canX() helper returns. */
function decodeBoolString(hex) {
  try {
    const ok = hexToBig(word(hex, 0)) !== 0n;
    const b = hex.replace(/^0x/, "");
    const off = Number(BigInt("0x" + b.slice(64, 128))) * 2;
    const len = Number(BigInt("0x" + b.slice(off, off + 64)));
    const reason = Buffer.from(b.slice(off + 64, off + 64 + len * 2), "hex").toString("utf8");
    return { ok, reason };
  } catch (_) { return { ok: false, reason: "" }; }
}

function units(v, decimals) {
  const d = BigInt(decimals);
  const base = 10n ** d;
  const whole = v / base;
  const frac = d > 0n ? "." + (v % base).toString().padStart(Number(d), "0") : "";
  return whole.toString() + frac;
}

/**
 * Which tokens of `collection` does `owner` hold?
 *
 * Uses Transfer logs to find candidates, then confirms each against ownerOf —
 * logs say what moved, not what is still held, and a token received and passed
 * on would otherwise be reported as owned.
 */
async function ownedTokens(rpc, collection, owner) {
  const ids = new Set();
  const total = Number(hexToBig(await settle(
    rpc("eth_call", [{ to: collection, data: SEL.totalMinted }, "latest"]), "0x0")));

  if (total <= MAX_TOKENS) {
    // ENUMERATE, don't scan. This endpoint is public and unauthenticated, and
    // `eth_getLogs` from block 0 makes the node build the whole matching set in
    // memory — on a small VM that is enough to get avalanchego OOM-killed, which
    // takes the chain down for everyone because somebody opened a web page.
    // A demo collection is tens of tokens, so a handful of ownerOf calls answers
    // the same question for a bounded, predictable cost.
    for (let i = 1; i <= total; i++) ids.add(String(i));
  } else {
    // Large collection: a log scan is the only sane route, but over a BOUNDED
    // recent window rather than all of history. Older holdings are missed; that
    // is the honest trade against an endpoint anyone can call.
    try {
      const latest = Number(hexToBig(await rpc("eth_blockNumber")));
      const from = Math.max(0, latest - LOG_WINDOW);
      const logs = await rpc("eth_getLogs", [{
        address: collection,
        topics: [TRANSFER_TOPIC, null, "0x" + pad32(owner)],
        fromBlock: "0x" + from.toString(16),
        toBlock: "latest",
      }]);
      for (const l of logs ?? []) {
        if (l.topics?.[3]) ids.add(hexToBig(l.topics[3]).toString());
      }
    } catch (_) {
      for (let i = Math.max(1, total - MAX_TOKENS + 1); i <= total; i++) ids.add(String(i));
    }
  }

  const held = [];
  for (const idStr of [...ids].slice(0, MAX_TOKENS)) {
    const idHex = BigInt(idStr).toString(16).padStart(64, "0");
    const cur = addrFromWord(await settle(rpc("eth_call", [{ to: collection, data: SEL.ownerOf + idHex }, "latest"])));
    if (cur && cur.toLowerCase() === owner.toLowerCase()) held.push(Number(idStr));
  }
  return held.sort((a, b) => a - b);
}

async function tokenMeta(rpc, collection, tokenId) {
  const idHex = BigInt(tokenId).toString(16).padStart(64, "0");
  const raw = await settle(rpc("eth_call", [{ to: collection, data: SEL.tokenURI + idHex }, "latest"]));
  const uri = raw ? decodeString(raw) : null;
  let meta = null;
  // The metadata is a data URI produced on chain, so it is decoded here rather
  // than fetched. Nothing external is contacted to render this page.
  if (uri && uri.startsWith("data:application/json;base64,")) {
    try { meta = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString("utf8")); }
    catch (_) { /* leave null */ }
  }
  return { tokenId, image: meta?.image ?? null, name: meta?.name ?? `#${tokenId}`, uri: uri ? "on-chain" : null };
}

async function assets(rpcUrl, deployments, opts = {}) {
  const address = opts.address && /^0x[0-9a-fA-F]{40}$/.test(opts.address) ? opts.address : null;
  const key = address ? address.toLowerCase() : "_chain";
  const now = Date.now();
  const hit = _cache.get(key);
  if (!opts.noCache && hit && now - hit.at < CACHE_MS) return hit.data;
  const pending = _inflight.get(key);
  if (pending) return pending;
  const run = _assets(rpcUrl, deployments, address, key, now).finally(() => _inflight.delete(key));
  _inflight.set(key, run);
  return run;
}

async function _assets(rpcUrl, deployments, address, key, now) {

  const rpc = makeRpc(rpcUrl);
  const c = deployments?.contracts ?? {};

  // --- fungible tokens on this chain ------------------------------------
  const tokens = [];
  const native = {
    kind: "native",
    symbol: "tRIEL",
    name: "Tokenized Riel (native)",
    decimals: 18,
    address: null,
    note: "Pays gas and is the unit every tokenized riel converts through.",
  };
  if (address) native.balance = units(hexToBig(await settle(rpc("eth_getBalance", [address, "latest"]), "0x0")), 18);
  tokens.push(native);

  for (const [label, addr] of [["KHRStablecoin", c.KHRStablecoin]]) {
    if (!addr) continue;
    const [nm, sym, dec, sup] = await Promise.all([
      settle(rpc("eth_call", [{ to: addr, data: SEL.name }, "latest"])),
      settle(rpc("eth_call", [{ to: addr, data: SEL.symbol }, "latest"])),
      settle(rpc("eth_call", [{ to: addr, data: SEL.decimals }, "latest"])),
      settle(rpc("eth_call", [{ to: addr, data: SEL.totalSupply }, "latest"])),
    ]);
    const decimals = dec ? Number(hexToBig(dec)) : 2;
    const t = {
      kind: "erc20",
      address: addr,
      name: (nm && decodeString(nm)) || label,
      symbol: (sym && decodeString(sym)) || "KHRt",
      decimals,
      totalSupply: units(hexToBig(sup ?? "0x0"), decimals),
      note: "A tokenized riel. Transfers require both parties to hold active KYC.",
    };
    if (address) {
      const bal = await settle(rpc("eth_call", [{ to: addr, data: SEL.balanceOf + pad32(address) }, "latest"]), "0x0");
      t.balance = units(hexToBig(bal), decimals);
    }
    tokens.push(t);
  }

  // --- assets that came from outside, or stand in for one ----------------
  //
  // Kept OUT of `tokens` on purpose. That list is the two tiers of riel, and the
  // page's own copy calls them "the same money in two forms" — appending a dollar
  // to it would make that sentence false and, worse, would file an ungated asset
  // beside a KYC-gated one as though they were the same kind of thing.
  //
  // They are not. KHRt checks the identity registry inside its transfer hook, so
  // a revoked address cannot hold it. These carry no such hook: no identity
  // check, no freeze, no confiscate. What gates them is the chain itself —
  // txAllowList decides who may send any transaction at all — which is a real
  // control but a different one, and the page says so rather than letting a
  // shared list imply otherwise. See docs/architecture.md §7.1.
  const foreign = [];
  for (const [key, b] of Object.entries(deployments?.bridged ?? {})) {
    if (!b?.address) continue;
    // The stand-in dollar, kept on chain but no longer presented as one of this
    // chain's assets: an unguarded mint() made its supply arbitrary and every
    // price quoted against it arbitrary too. CSB issues its own foreign currency
    // now. `standIn` is set at deployment, `retired` by scripts/retire-usdx.js —
    // either is enough, so hiding it does not wait on an operator running
    // anything. Nothing is deleted; the address stays in deployments.json.
    if (b.retired || b.standIn) continue;
    // deployments.json spans both sides of the bridge, and a Fuji address read
    // against CSB answers 0x for every call — which would render as a token
    // named "" with a supply of 0 rather than as the absent thing it is.
    const onChain = await settle(rpc("eth_getCode", [b.address, "latest"]), "0x");
    if (!onChain || onChain === "0x") {
      foreign.push({ key, address: b.address, symbol: b.symbol ?? key,
        name: b.name ?? key, missing: true, standIn: !!b.standIn, note: b.note ?? null });
      continue;
    }
    const [nm, sym, dec, sup] = await Promise.all([
      settle(rpc("eth_call", [{ to: b.address, data: SEL.name }, "latest"])),
      settle(rpc("eth_call", [{ to: b.address, data: SEL.symbol }, "latest"])),
      settle(rpc("eth_call", [{ to: b.address, data: SEL.decimals }, "latest"])),
      settle(rpc("eth_call", [{ to: b.address, data: SEL.totalSupply }, "latest"])),
    ]);
    // The chain is the authority on all of this; the file is only where to look.
    const decimals = dec ? Number(hexToBig(dec)) : (b.decimals ?? 6);
    const t = {
      kind: "erc20",
      key,
      address: b.address,
      name: (nm && decodeString(nm)) || b.name || key,
      symbol: (sym && decodeString(sym)) || b.symbol || key,
      decimals,
      totalSupply: units(hexToBig(sup ?? "0x0"), decimals),
      standIn: !!b.standIn,
      note: b.note ?? null,
    };
    if (address) {
      const bal = await settle(rpc("eth_call",
        [{ to: b.address, data: SEL.balanceOf + pad32(address) }, "latest"]), "0x0");
      t.balance = units(hexToBig(bal), decimals);
    }

    // Can anyone mint this? The stand-in dollar is a test token whose mint() has
    // no access control, so the page can offer a faucet — but only where that is
    // actually true. KHRt's issuance is role-gated and must never appear to offer
    // the same thing, so this asks the chain rather than trusting a flag in the
    // deployments file.
    t.mintable = (await settle(
      rpc("eth_call", [{ to: b.address, data: SEL.mintSelf + pad32num(0n) }, "latest"]),
      null)) !== null;

    foreign.push(t);
  }

  // --- the 1:1 converter between the two tiers of money ------------------
  // Public because it is the claim itself: anyone can check that the tRIEL
  // minted here is matched by KHRt locked in the contract. A backing figure
  // nobody can verify is worth nothing.
  let converter = null;
  if (c.RielConverter && c.KHRStablecoin) {
    const khr = c.KHRStablecoin;
    const [ok, locked, dec] = await Promise.all([
      settle(rpc("eth_call", [{ to: c.RielConverter, data: SEL.approved + pad32(khr) }, "latest"]), "0x0"),
      settle(rpc("eth_call", [{ to: khr, data: SEL.balanceOf + pad32(c.RielConverter) }, "latest"]), "0x0"),
      settle(rpc("eth_call", [{ to: khr, data: SEL.decimals }, "latest"])),
    ]);
    const decimals = dec ? Number(hexToBig(dec)) : 2;
    converter = {
      address: c.RielConverter,
      token: khr,
      symbol: "KHRt",
      approved: hexToBig(ok) !== 0n,
      // KHRt held by the converter IS the backing for tRIEL it has minted.
      lockedCollateral: units(hexToBig(locked), decimals),
      rate: "1:1",
    };
  }

  // --- the NFT collection ------------------------------------------------
  let collection = null;
  const nftAddr = c.CSBCollectible;
  if (nftAddr) {
    const [nm, sym, total, maxPer, isPaused, minTier] = await Promise.all([
      settle(rpc("eth_call", [{ to: nftAddr, data: SEL.name }, "latest"])),
      settle(rpc("eth_call", [{ to: nftAddr, data: SEL.symbol }, "latest"])),
      settle(rpc("eth_call", [{ to: nftAddr, data: SEL.totalMinted }, "latest"]), "0x0"),
      settle(rpc("eth_call", [{ to: nftAddr, data: SEL.maxPerAddress }, "latest"]), "0x0"),
      settle(rpc("eth_call", [{ to: nftAddr, data: SEL.paused }, "latest"]), "0x0"),
      settle(rpc("eth_call", [{ to: nftAddr, data: SEL.minimumTier }, "latest"]), "0x0"),
    ]);
    collection = {
      address: nftAddr,
      name: (nm && decodeString(nm)) || "CSB Collectible",
      symbol: (sym && decodeString(sym)) || "CSBC",
      totalMinted: Number(hexToBig(total)),
      maxPerAddress: Number(hexToBig(maxPer)),
      paused: hexToBig(isPaused) !== 0n,
      minimumTier: Number(hexToBig(minTier)),
      recent: [],
    };

    // A few of the newest, so the page has something to show before anyone
    // connects a wallet.
    const newest = [];
    for (let i = collection.totalMinted; i > 0 && newest.length < 6; i--) newest.push(i);
    collection.recent = (await Promise.all(newest.map((id) => tokenMeta(rpc, nftAddr, id))))
      .filter((t) => t.image);

    if (address) {
      const ids = await ownedTokens(rpc, nftAddr, address);
      collection.owned = await Promise.all(ids.map((id) => tokenMeta(rpc, nftAddr, id)));
      const can = await settle(rpc("eth_call", [{ to: nftAddr, data: SEL.canMint + pad32(address) }, "latest"]));
      collection.canMint = can ? decodeBoolString(can) : { ok: false, reason: "could not check" };
      const minted = await settle(rpc("eth_call", [{ to: nftAddr, data: SEL.mintedCount + pad32(address) }, "latest"]), "0x0");
      collection.mintedByYou = Number(hexToBig(minted));
    }
  }

  const data = { address, tokens, foreign, converter, collection, updatedAt: new Date().toISOString() };
  _cache.set(key, { at: now, data });
  if (_cache.size > 200) _cache = new Map([[key, { at: now, data }]]); // bound the cache
  return data;
}

module.exports = { assets, _internal: { decodeString, decodeBoolString, units, ownedTokens } };
