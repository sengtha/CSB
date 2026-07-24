"use strict";
/**
 * Per-user read filtering for the scoped RPC endpoint (`/rpc/<token>`).
 *
 * A KYC user connects any EVM wallet (MetaMask, Rabby, mobile) to a tokenized
 * URL; the token maps to their on-chain address. This module decides, per
 * JSON-RPC call, what that user is allowed to see — so they get a working
 * wallet (their balance, nonce, fees, their own history, send) WITHOUT being
 * able to read the whole ledger. That is "public within the country, private to
 * the world" enforced at the read layer, for wallets that can't authenticate
 * with a cookie.
 *
 * HONEST SCOPE — this is practical scoping, not cryptographic privacy:
 *  - It blocks bulk reads: logs, blocks and transactions are filtered to the
 *    caller, so nobody can index everyone's activity through this endpoint.
 *  - It blocks pointed lookups of other addresses' balance / KYC / freeze state
 *    through the known contracts (balanceOf, attestationOf, isActive, …).
 *  - It denies node-control and browsing namespaces (admin/debug/personal/
 *    txpool/miner/platform and index-by-position getters).
 * It is NOT a guarantee against every crafted eth_call to an arbitrary
 * contract. Treat it as "no casual or bulk access to others' data", not
 * "provable confidentiality". The node's own RPC stays private (localhost); the
 * app is the only door, and this scopes what each door-holder can read.
 */

// Forwarded unchanged — chain identity, fees, gas. None reveal another user.
const PASS_THROUGH = new Set([
  "eth_chainId", "net_version", "web3_clientVersion", "eth_protocolVersion",
  "eth_blockNumber", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory",
  "eth_estimateGas", "eth_getCode", "eth_syncing",
]);

// The address argument (params[0]) must equal the caller's own address.
const SELF_ADDR0 = new Set(["eth_getBalance", "eth_getTransactionCount", "eth_getStorageAt"]);

// eth_call selectors that read a specific address's data: require that address
// (first 32-byte word after the 4-byte selector) to be the caller. Aggregate /
// public reads (totalSupply, decimals, name, paused, tierTransferCap, …) are
// not listed and are allowed.
const ADDR0_SELECTORS = new Set([
  "0x70a08231", // balanceOf(address)
  "0xdd62ed3e", // allowance(address,address)  -> owner
  "0xe20e91d0", // attestationOf(address)
  "0xc8f74bb8", // tierOf(address)
  "0x9f8a13d7", // isActive(address)
  "0xe5839836", // isFrozen(address)
  "0x13bc6d4b", // isSystemContract(address)
]);

function rpcError(id, message, code = -32601) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function pad32(addr) {
  return "0x" + "000000000000000000000000" + String(addr).toLowerCase().replace(/^0x/, "");
}
function sameAddr(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}
// address encoded at 32-byte word `i` of eth_call data (after the 4-byte selector)
function wordAddr(data, i) {
  const start = 10 + i * 64;
  if (typeof data !== "string" || data.length < start + 64) return null;
  return "0x" + data.slice(start + 24, start + 64);
}
function logMentions(log, user) {
  const t = pad32(user);
  return Array.isArray(log?.topics) && log.topics.some((x) => typeof x === "string" && x.toLowerCase() === t);
}
function txInvolves(tx, user) {
  if (!tx) return false;
  return sameAddr(tx.from, user) || sameAddr(tx.to, user);
}

/**
 * Decide one JSON-RPC call. `forward(call)` sends it upstream and resolves to
 * the parsed response object. Returns the (possibly filtered) response.
 */
async function filterCall(call, user, forward) {
  const id = call?.id ?? null;
  const m = call?.method;
  if (typeof m !== "string") return rpcError(id, "invalid request", -32600);

  if (PASS_THROUGH.has(m)) return forward(call);

  // Submit: allowed. The chain's txAllowList precompile already authorizes only
  // the (KYC'd) signer; the raw tx is signed by the user's own key.
  if (m === "eth_sendRawTransaction") return forward(call);

  // Account-scoped reads — only about yourself.
  if (SELF_ADDR0.has(m)) {
    const addr = call?.params?.[0];
    if (!sameAddr(addr, user)) return rpcError(id, "scoped RPC: you may only query your own address", -32001);
    return forward(call);
  }

  // eth_call — allow, but block pointed lookups of other addresses via the
  // known sensitive read functions.
  if (m === "eth_call") {
    const data = call?.params?.[0]?.data ?? call?.params?.[0]?.input;
    const sel = typeof data === "string" ? data.slice(0, 10).toLowerCase() : "";
    if (ADDR0_SELECTORS.has(sel)) {
      const queried = wordAddr(data, 0);
      if (!sameAddr(queried, user)) return rpcError(id, "scoped RPC: you may only read your own account's data", -32001);
    }
    return forward(call);
  }

  // Logs — return only entries that mention the caller.
  if (m === "eth_getLogs") {
    const res = await forward(call);
    if (Array.isArray(res?.result)) res.result = res.result.filter((l) => logMentions(l, user));
    return res;
  }

  // Single tx / receipt — only if it involves the caller.
  if (m === "eth_getTransactionByHash") {
    const res = await forward(call);
    if (res?.result && !txInvolves(res.result, user)) res.result = null;
    return res;
  }
  if (m === "eth_getTransactionReceipt") {
    const res = await forward(call);
    const r = res?.result;
    if (r && !(sameAddr(r.from, user) || sameAddr(r.to, user) || (Array.isArray(r.logs) && r.logs.some((l) => logMentions(l, user))))) {
      res.result = null;
    }
    return res;
  }

  // Blocks — keep the header (needed for fees/number) but strip other users'
  // transactions. A wallet reads its own txs via receipts, not the block list.
  if (m === "eth_getBlockByNumber" || m === "eth_getBlockByHash") {
    const res = await forward(call);
    if (res?.result && Array.isArray(res.result.transactions)) {
      res.result.transactions = res.result.transactions.filter((t) => (typeof t === "object" ? txInvolves(t, user) : false));
    }
    return res;
  }

  // Everything else (admin_/debug_/personal_/txpool_/miner_/platform.*,
  // index-by-position getters, tx-by-block-index, etc.) is denied.
  return rpcError(id, `scoped RPC: method '${m}' is not permitted`, -32601);
}

/** Filter a whole request body (single call or batch). */
async function filterBody(body, user, forward) {
  if (Array.isArray(body)) return Promise.all(body.map((c) => filterCall(c, user, forward)));
  return filterCall(body, user, forward);
}

module.exports = { filterBody, filterCall };
