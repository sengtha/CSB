"use strict";
/**
 * The multisig wallets that exist on CSB, read from the chain.
 *
 * Every Safe on this chain is a proxy created by one factory, and that factory
 * emits ProxyCreation. So the list of wallets is derivable from logs, and each
 * wallet's owners and threshold are readable from the wallet itself. Nothing
 * needs to be remembered by this server, which is the point: a server-side
 * registry of who owns which wallet would be a second answer to a question the
 * chain already answers, and the two would disagree the first time this server
 * was restored from a backup.
 *
 * A viewer, not an indexer. It scans from the factory's deployment block, which
 * on a chain in the hundreds of blocks is one call; the cache below is what keeps
 * it from being one call per page load rather than what makes it viable.
 */
const CACHE_MS = 8000;

// ProxyCreation(address indexed proxy, address singleton)
const PROXY_CREATION = "0x4f51faf6c4561ff95f067657e43439f0f856d97c04d9ec9070a6199ad418e235";
const SEL = {
  getOwners: "0xa0e67e2b",
  getThreshold: "0xe75235b8",
  nonce: "0xaffed0e0",
};

let _cache = null;

function makeRpc(url) {
  let id = 1;
  return async function rpc(method, params = []) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message ?? "rpc error");
    return j.result;
  };
}

const settle = (p, fallback = null) => p.catch(() => fallback);
const hexToBig = (h) => (h && h !== "0x" ? BigInt(h) : 0n);
const addrFromWord = (w) => "0x" + w.slice(-40);

/** Decode an ABI `address[]` return. */
function decodeAddressArray(hex) {
  if (!hex || hex === "0x") return [];
  const body = hex.slice(2);
  // [0] offset, [1] length, then one word each. The offset is always 0x20 for a
  // single dynamic return, but it is read rather than assumed.
  const offset = Number(BigInt("0x" + body.slice(0, 64))) * 2;
  const len = Number(BigInt("0x" + body.slice(offset, offset + 64)));
  const out = [];
  for (let i = 0; i < len; i++) {
    const at = offset + 64 + i * 64;
    out.push(addrFromWord(body.slice(at, at + 64)));
  }
  return out;
}

/**
 * @param {string} rpcUrl
 * @param {object|null} deployments  app/deployments.json
 * @param {object} opts  { address } to mark which wallets that address owns
 */
async function safes(rpcUrl, deployments, opts = {}) {
  const now = Date.now();
  if (!opts.noCache && _cache && now - _cache.at < CACHE_MS) return withOwner(_cache.data, opts.address);

  const factory = deployments?.safe?.safeProxyFactory ?? null;
  if (!factory) {
    // Distinguish "not deployed" from "none created" — they look identical from
    // an empty list and mean entirely different things to whoever is looking.
    return { deployed: false, factory: null, singleton: null, wallets: [],
      note: "Safe is not deployed on this chain yet." };
  }

  const rpc = makeRpc(rpcUrl);
  const logs = await settle(rpc("eth_getLogs", [{
    fromBlock: "0x0", toBlock: "latest", address: factory, topics: [PROXY_CREATION],
  }]), []);

  const wallets = [];
  for (const log of logs ?? []) {
    // proxy is indexed, so it is in topics[1] rather than in data.
    const addr = addrFromWord(log.topics[1]);
    const [ownersHex, thresholdHex, nonceHex] = await Promise.all([
      settle(rpc("eth_call", [{ to: addr, data: SEL.getOwners }, "latest"])),
      settle(rpc("eth_call", [{ to: addr, data: SEL.getThreshold }, "latest"])),
      settle(rpc("eth_call", [{ to: addr, data: SEL.nonce }, "latest"])),
    ]);
    const owners = decodeAddressArray(ownersHex);
    // A proxy that answers nothing is either not a Safe or was created against a
    // different singleton. Listed anyway, marked, rather than hidden — a wallet
    // that exists and cannot be read is exactly what someone needs to be told.
    wallets.push({
      address: addr,
      owners,
      threshold: Number(hexToBig(thresholdHex)),
      nonce: Number(hexToBig(nonceHex)),
      block: Number(hexToBig(log.blockNumber)),
      readable: owners.length > 0,
    });
  }
  wallets.sort((a, b) => a.block - b.block);

  const data = {
    deployed: true,
    factory,
    singleton: deployments.safe.safeL2 ?? null,
    fallbackHandler: deployments.safe.compatibilityFallbackHandler ?? null,
    version: deployments.safe.version ?? null,
    wallets,
  };
  _cache = { at: now, data };
  return withOwner(data, opts.address);
}

/** Mark which wallets an address owns, without re-reading the chain. */
function withOwner(data, address) {
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return data;
  const me = address.toLowerCase();
  return {
    ...data,
    wallets: data.wallets.map((w) => ({
      ...w, yours: w.owners.some((o) => o.toLowerCase() === me),
    })),
  };
}

module.exports = { safes, _internal: { decodeAddressArray, PROXY_CREATION } };
