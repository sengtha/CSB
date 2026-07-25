/**
 * Chain and node facts for the public Node info page.
 *
 * Everything here is a PUBLIC identifier — chain id, blockchain id, node ids,
 * contract addresses, the fee configuration. The same values are already in the
 * repository's deployment notes, so publishing them adds no exposure, and having
 * them in one live place beats a document that goes stale after every redeploy.
 *
 * What it deliberately does NOT serve: anything that would let a reader act on
 * the chain, or read somebody else's data. No keys, no passcode, no RPC
 * passthrough. The node's own API stays on localhost; this is a summary the app
 * assembles server-side.
 */
const REWARD_MANAGER = "0x0200000000000000000000000000000000000004";
const FEE_MANAGER = "0x0200000000000000000000000000000000000003";
const SEL_CURRENT_REWARD = "0xe915608b"; // currentRewardAddress()
const SEL_FEE_CONFIG = "0x5fbbc0d2"; // getFeeConfig() — hashed, not guessed
const BLACKHOLE = "0x0100000000000000000000000000000000000000";
const CACHE_MS = 10000;

let _cache = null;

const hexToBig = (h) => (typeof h === "string" && h !== "0x" ? BigInt(h) : 0n);

function makeRpc(url) {
  let id = 0;
  return async function call(method, params = [], path = null) {
    const res = await fetch(path ?? url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    const j = await res.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  };
}

/** The node's base URL, derived from the chain RPC URL. */
function nodeBase(rpcUrl) {
  const i = rpcUrl.indexOf("/ext/");
  return i === -1 ? rpcUrl : rpcUrl.slice(0, i);
}

/** Blockchain ID out of .../ext/bc/<id>/rpc. */
function blockchainIdFrom(rpcUrl) {
  const m = rpcUrl.match(/\/ext\/bc\/([^/]+)\//);
  return m ? m[1] : null;
}

async function settle(p, fallback = null) {
  try { return await p; } catch (_) { return fallback; }
}

/** Like settle, but keeps the reason so the page can show it. */
async function settleWhy(p) {
  try { return { value: await p, error: null }; }
  catch (e) { return { value: null, error: String(e?.message ?? e) }; }
}

async function nodeInfo(rpcUrl, deployments, opts = {}) {
  const now = Date.now();
  if (!opts.noCache && _cache && now - _cache.at < CACHE_MS) return _cache.data;

  const rpc = makeRpc(rpcUrl);
  const base = nodeBase(rpcUrl);
  const infoUrl = `${base}/ext/info`;

  // The AvalancheGo info API takes OBJECT params, unlike the EVM endpoints — and
  // some methods require fields. info.isBootstrapped needs the chain to ask
  // about; called with {} it errors, which previously turned into a silent dash
  // on the page rather than anything a reader could act on.
  const info = async (method, params = {}) => {
    const res = await fetch(infoUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const j = await res.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  };

  const chainKey = blockchainIdFrom(rpcUrl);
  const [chainIdHex, heightHex, gasPriceHex, block, nodeId, version, bootstrapped, peers] =
    await Promise.all([
      settle(rpc("eth_chainId")),
      settle(rpc("eth_blockNumber")),
      settle(rpc("eth_gasPrice")),
      settle(rpc("eth_getBlockByNumber", ["latest", false])),
      settleWhy(info("info.getNodeID")),
      settleWhy(info("info.getNodeVersion")),
      // Needs the chain to ask about; {} is an error, not a default.
      settleWhy(chainKey ? info("info.isBootstrapped", { chain: chainKey }) : Promise.reject(new Error("no blockchain id in the RPC URL"))),
      settleWhy(info("info.peers")),
    ]);

  // Fee floor, so the page can state the actual price of a payment rather than
  // repeating a policy that may have drifted from what the chain charges.
  let minBaseFee = null;
  const feeRes = await settle(rpc("eth_call", [{ to: FEE_MANAGER, data: SEL_FEE_CONFIG }, "latest"]));
  if (typeof feeRes === "string" && feeRes.length >= 2 + 64 * 3) {
    minBaseFee = hexToBig("0x" + feeRes.slice(2 + 64 * 2, 2 + 64 * 3));
  }

  let rewardAddress = null;
  const rewardRes = await settle(rpc("eth_call", [{ to: REWARD_MANAGER, data: SEL_CURRENT_REWARD }, "latest"]));
  if (typeof rewardRes === "string" && rewardRes.length >= 66) {
    rewardAddress = "0x" + rewardRes.slice(-40);
  }
  const feesBurned = rewardAddress != null
    && (rewardAddress.toLowerCase() === BLACKHOLE
        || rewardAddress === "0x0000000000000000000000000000000000000000");

  const baseFee = block?.baseFeePerGas != null ? hexToBig(block.baseFeePerGas) : null;
  const transferCost = (baseFee ?? minBaseFee) != null ? (baseFee ?? minBaseFee) * 21000n : null;

  const data = {
    network: "Avalanche Fuji (testnet)",
    chainId: chainIdHex ? Number(hexToBig(chainIdHex)) : null,
    chainIdHex: chainIdHex ?? null,
    blockchainId: blockchainIdFrom(rpcUrl),
    height: heightHex ? Number(hexToBig(heightHex)) : null,
    blockTime: block?.timestamp ? Number(hexToBig(block.timestamp)) : null,
    node: {
      nodeId: nodeId.value?.nodeID ?? null,
      version: version.value?.version ?? null,
      vmVersions: version.value?.vmVersions ?? null,
      bootstrapped: bootstrapped.value?.isBootstrapped ?? null,
      peers: peers.value?.numPeers != null ? Number(peers.value.numPeers) : null,
      // Say WHY a field is blank. A bare dash is indistinguishable from a node
      // that is unreachable, an API that is disabled, and a call made wrongly —
      // and the last of those was the actual cause here.
      unavailable: [
        nodeId.error && `node id: ${nodeId.error}`,
        version.error && `version: ${version.error}`,
        bootstrapped.error && `bootstrapped: ${bootstrapped.error}`,
        peers.error && `peers: ${peers.error}`,
      ].filter(Boolean),
    },
    gas: {
      minBaseFeeWei: minBaseFee != null ? minBaseFee.toString() : null,
      baseFeeWei: baseFee != null ? baseFee.toString() : null,
      suggestedWei: gasPriceHex ? hexToBig(gasPriceHex).toString() : null,
      // What an ordinary payment actually costs, which is the number that means
      // something to a reader — not the price per unit of gas.
      transferCostTriel: transferCost != null ? formatEther(transferCost) : null,
    },
    fees: {
      rewardAddress: feesBurned ? null : rewardAddress,
      burned: feesBurned,
    },
    contracts: deployments?.contracts ?? {},
    updatedAt: new Date().toISOString(),
  };

  _cache = { at: now, data };
  return data;
}

/** 18-decimal wei as a decimal string, without pulling in a big-number library. */
function formatEther(v) {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / 10n ** 18n;
  const frac = (abs % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
}

module.exports = { nodeInfo, _internal: { nodeBase, blockchainIdFrom, formatEther } };
