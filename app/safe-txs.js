"use strict";
/**
 * Pending multisig transactions, and the signatures collected so far.
 *
 * Safe verifies a concatenation of ordinary ECDSA signatures over an EIP-712
 * hash. Nothing about that needs a server — owners could email each other 65
 * bytes. What a server buys is that they do not have to: a place to leave a
 * proposal, and a place to leave a signature, so the quorum never has to be in
 * the same room or the same hour.
 *
 * THIS STORE IS NOT AUTHORITATIVE, and the design depends on that.
 *
 * Every signature here is checked against the chain's current owner list and
 * against a hash THIS MODULE COMPUTES — never one the client supplied. So the
 * worst an attacker with write access to this file can do is delete pending
 * work or add signatures that were already valid. They cannot forge an approval,
 * cannot change what a signature authorises, and cannot make the chain accept
 * anything the owners did not sign. Losing the file costs convenience, not
 * safety. That is the same reason the wallet list is read from chain events
 * rather than remembered here (app/safes.js).
 *
 * WHY THE HASH IS RECOMPUTED, EVERY TIME. If the client sent both the fields and
 * the hash, an attacker could store fields that differ from the hash the owners
 * signed: the page would show everyone a harmless transfer while the collected
 * signatures authorised something else, and the signatures would be perfectly
 * valid for that something else. Recomputing is the only thing that ties what is
 * DISPLAYED to what is SIGNED.
 *
 * DELEGATECALL IS REFUSED HERE. Safe supports operation = 1, which runs the
 * target's code against this wallet's own storage and can rewrite its owners
 * outright. It has legitimate uses — batching through MultiSend is the usual one
 * — and none of them are things a council does from a web form. A proposal that
 * needs it can be built and signed with scripts/safe-exec.js by someone who can
 * say why.
 */
const fs = require("fs");
const path = require("path");

let ethers = null;
try { ethers = require("ethers"); } catch (_) { /* checked at call time */ }

const MAX_PENDING = 200;
const MAX_LABEL = 100;
const MAX_DATA = 2 * 1024 * 2 + 2;   // 2 KiB of calldata, as hex
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x([0-9a-fA-F]{2})*$/;

// Safe's EIP-712 domain has no name and no version — only these two fields.
const TYPES = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
};

function file() {
  return process.env.CSB_SAFE_TXS_FILE ?? path.join(__dirname, "safe-txs.json");
}
function readAll() {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) { return []; }
}
function writeAll(list) {
  fs.writeFileSync(file(), JSON.stringify(list, null, 2));
}

/** Canonical SafeTx from loose input. Throws with a readable reason. */
function normalise(body) {
  const to = String(body?.to ?? "");
  if (!ADDR.test(to)) throw new Error("`to` must be a valid 0x address");
  const data = String(body?.data ?? "0x");
  if (!HEX.test(data)) throw new Error("`data` must be 0x-prefixed hex with whole bytes");
  if (data.length > MAX_DATA) throw new Error("`data` is too large for a web proposal");

  let value;
  try { value = BigInt(body?.value ?? 0); } catch (_) { throw new Error("`value` must be an integer"); }
  if (value < 0n) throw new Error("`value` cannot be negative");

  let nonce;
  try { nonce = BigInt(body?.nonce ?? 0); } catch (_) { throw new Error("`nonce` must be an integer"); }
  if (nonce < 0n) throw new Error("`nonce` cannot be negative");

  const operation = Number(body?.operation ?? 0);
  if (operation !== 0) throw new Error("only plain calls can be proposed here, not delegatecall");

  // The refund fields exist for relayed execution, which CSB does not use: the
  // owner who submits pays gas directly. Fixing them at zero removes a way to
  // hide a payment to an attacker inside an otherwise ordinary-looking proposal.
  return {
    to, value, data, operation,
    safeTxGas: 0n, baseGas: 0n, gasPrice: 0n,
    gasToken: ethers.ZeroAddress,
    refundReceiver: ethers.ZeroAddress,
    nonce,
  };
}

/** The hash the owners will sign. Computed here, never accepted from a client. */
function hashOf(safe, chainId, tx) {
  return ethers.TypedDataEncoder.hash(
    { chainId: BigInt(chainId), verifyingContract: safe }, TYPES, tx);
}

/** JSON-safe copy — BigInt does not survive JSON.stringify. */
const plain = (tx) => ({
  to: tx.to, value: tx.value.toString(), data: tx.data, operation: tx.operation,
  safeTxGas: "0", baseGas: "0", gasPrice: "0",
  gasToken: tx.gasToken, refundReceiver: tx.refundReceiver, nonce: tx.nonce.toString(),
});

/**
 * Propose a transaction. `ownersOf(safe)` returns the current owner list from
 * the chain; this module never talks to a node itself.
 *
 * The proposer must be an owner and must sign — their signature becomes the
 * first one. Without that anyone could fill the queue, and worse, could put a
 * plausible-looking proposal in front of a quorum without holding a key at all.
 */
async function propose(body, ownersOf, chainId) {
  if (!ethers) return { error: "ethers unavailable on the server", status: 500 };
  const safe = String(body?.safe ?? "");
  if (!ADDR.test(safe)) return { error: "`safe` must be a valid 0x address", status: 400 };

  let tx;
  try { tx = normalise(body); } catch (e) { return { error: e.message, status: 400 }; }

  const owners = (await ownersOf(safe)).map((o) => o.toLowerCase());
  if (!owners.length) return { error: "that address is not a Safe on this chain", status: 404 };

  const safeTxHash = hashOf(safe, chainId, tx);
  let who;
  try { who = ethers.verifyTypedData(
    { chainId: BigInt(chainId), verifyingContract: safe }, TYPES, tx, String(body?.signature ?? "")); }
  catch (_) { return { error: "the signature could not be read", status: 400 }; }
  if (!owners.includes(who.toLowerCase())) {
    return { error: `${who} is not an owner of this wallet`, status: 403 };
  }

  const list = readAll();
  const existing = list.findIndex((r) => r.safeTxHash === safeTxHash);
  if (existing >= 0) {
    // The same transaction proposed twice is the same transaction. Keep the
    // signatures already gathered rather than starting the count again.
    return { ok: true, safeTxHash, duplicate: true };
  }
  if (list.length >= MAX_PENDING) return { error: "the pending queue is full", status: 503 };

  list.push({
    safe, safeTxHash, chainId: String(chainId),
    tx: plain(tx),
    label: String(body?.label ?? "").trim().slice(0, MAX_LABEL),
    proposedBy: who,
    proposedAt: new Date().toISOString(),
    signatures: [{ owner: who, signature: body.signature, at: new Date().toISOString() }],
  });
  writeAll(list);
  return { ok: true, safeTxHash };
}

/** Add one owner's signature to an existing proposal. */
async function sign(safeTxHash, body, ownersOf) {
  if (!ethers) return { error: "ethers unavailable on the server", status: 500 };
  const list = readAll();
  const i = list.findIndex((r) => r.safeTxHash?.toLowerCase() === String(safeTxHash).toLowerCase());
  if (i < 0) return { error: "no such pending transaction", status: 404 };
  const rec = list[i];

  // Rebuild the typed data from the STORED fields, so a signature is always
  // checked against what the page displays rather than against anything the
  // signer's client claimed.
  const tx = {
    ...rec.tx,
    value: BigInt(rec.tx.value), nonce: BigInt(rec.tx.nonce),
    safeTxGas: 0n, baseGas: 0n, gasPrice: 0n,
  };
  const domain = { chainId: BigInt(rec.chainId), verifyingContract: rec.safe };

  let who;
  try { who = ethers.verifyTypedData(domain, TYPES, tx, String(body?.signature ?? "")); }
  catch (_) { return { error: "the signature could not be read", status: 400 }; }

  const owners = (await ownersOf(rec.safe)).map((o) => o.toLowerCase());
  if (!owners.includes(who.toLowerCase())) {
    return { error: `${who} is not an owner of this wallet`, status: 403 };
  }
  if (rec.signatures.some((s) => s.owner.toLowerCase() === who.toLowerCase())) {
    return { ok: true, already: true, owner: who, count: rec.signatures.length };
  }
  rec.signatures.push({ owner: who, signature: body.signature, at: new Date().toISOString() });
  list[i] = rec;
  writeAll(list);
  return { ok: true, owner: who, count: rec.signatures.length };
}

/**
 * Pending transactions for a wallet, newest last, with dead ones dropped.
 *
 * A Safe's nonce is sequential: once it executes nonce N, every proposal at N or
 * below can never execute again — including the ones that were never signed. Left
 * in place they accumulate as permanently un-executable rows that look pending,
 * so they are pruned against the live nonce here rather than displayed forever.
 */
function list(safe, currentNonce = null) {
  const all = readAll();
  const mine = all.filter((r) => r.safe.toLowerCase() === String(safe).toLowerCase());
  if (currentNonce === null) return mine;

  const n = BigInt(currentNonce);
  const dead = mine.filter((r) => BigInt(r.tx.nonce) < n);
  if (dead.length) {
    const deadHashes = new Set(dead.map((r) => r.safeTxHash));
    writeAll(all.filter((r) => !deadHashes.has(r.safeTxHash)));
  }
  return mine.filter((r) => BigInt(r.tx.nonce) >= n)
    .sort((a, b) => (BigInt(a.tx.nonce) < BigInt(b.tx.nonce) ? -1 : 1));
}

/** Discard a proposal. Removing it withdraws nothing already on chain. */
function remove(safeTxHash) {
  const all = readAll();
  const next = all.filter((r) => r.safeTxHash?.toLowerCase() !== String(safeTxHash).toLowerCase());
  if (next.length === all.length) return false;
  writeAll(next);
  return true;
}

module.exports = {
  propose, sign, list, remove,
  _internal: { normalise, hashOf, plain, readAll, writeAll, TYPES, MAX_PENDING },
};
