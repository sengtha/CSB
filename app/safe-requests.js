"use strict";
/**
 * Self-service requests for a multisig wallet.
 *
 * A visitor names the owners and the threshold they want; an operator creates it
 * from the admin console. Between those two moments the request lives HERE, in a
 * file on the app server, and not on the chain.
 *
 * WHY THERE IS A QUEUE AT ALL, RATHER THAN A BUTTON THAT DEPLOYS.
 *
 * Subnet-EVM checks **tx.origin** against `contractDeployerAllowList` when a
 * contract is created — not the caller of CREATE. The Avalanche documentation is
 * explicit that this is deliberate, "to provide a great UX with factory
 * contracts". The consequence for CSB is the opposite of great UX: putting
 * SafeProxyFactory on the allow list achieves nothing, and a visitor pressing
 * "create" in their own browser is refused by the precompile before any contract
 * runs. Contract creation on CSB is restricted to vetted deployers, and a Safe is
 * a contract.
 *
 * Three ways out were considered. Granting every requester deployer rights would
 * let them deploy anything at all, turning one of the five precompile controls
 * into a formality. Having the server relay the creation would mean the app
 * server holding a private key, which it does not today and which is the reason
 * server-secrets.js exists. So: a queue, and an operator whose wallet already has
 * the right, signing in their own browser — exactly how KYC approval already
 * works here. The server never holds a key in either flow.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT STORE. The created wallet's address is not
 * recorded here. Safes are discovered from the factory's ProxyCreation events and
 * their owners read from the chain (see app/safes.js), so the list of who owns
 * what has exactly one source of truth and it is not this file. A server-side
 * registry of wallet ownership would be a second answer to that question, and the
 * two would disagree the first time this file was lost or restored.
 */
const fs = require("fs");
const path = require("path");
const { verifySignature } = require("./rpc-access");

// Public and writes to disk, so it needs a ceiling.
const MAX_PENDING = 100;
const MAX_LABEL = 80;
const MAX_OWNERS = 20;          // Safe has no limit; a queue reviewed by humans does
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const ADDR = /^0x[0-9a-fA-F]{40}$/;

function file() {
  return process.env.CSB_SAFE_REQUESTS_FILE ?? path.join(__dirname, "safe-requests.json");
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

/** The message a requester signs. Says plainly what it does and does not do. */
function challenge() {
  return "CSB — request a multisig wallet\n"
    + "Signing this proves you control this address and asks an operator to create a Safe.\n"
    + "It is free, sends no transaction, and creates nothing by itself.\n"
    + `nonce: ${Date.now()}`;
}

/**
 * Validate and queue a request. Returns { ok, … } or { error, status }.
 *
 * `canTransact` is an async predicate the caller supplies, so this module never
 * talks to a node itself — same contract as kyc-requests.js.
 */
async function submit(body, canTransact) {
  const { address, message, signature, threshold } = body ?? {};
  const label = String(body?.label ?? "").trim().slice(0, MAX_LABEL);
  const owners = Array.isArray(body?.owners) ? body.owners.map((o) => String(o).trim()) : [];

  if (!ADDR.test(address ?? "")) {
    return { error: "a valid 0x address is required", status: 400 };
  }
  if (!owners.length) return { error: "list at least one owner", status: 400 };
  if (owners.length > MAX_OWNERS) {
    return { error: `at most ${MAX_OWNERS} owners`, status: 400 };
  }
  for (const o of owners) {
    if (!ADDR.test(o)) return { error: `"${o}" is not a valid address`, status: 400 };
  }
  const lowerOwners = owners.map((o) => o.toLowerCase());
  if (new Set(lowerOwners).size !== lowerOwners.length) {
    return { error: "the same owner is listed twice — Safe rejects that", status: 400 };
  }
  // Requesting a wallet you have no part in is either a mistake or a way to make
  // an operator create wallets for strangers. Neither is worth queueing.
  if (!lowerOwners.includes(address.toLowerCase())) {
    return { error: "the requesting address must be one of the owners", status: 400 };
  }
  const t = Number(threshold);
  if (!Number.isInteger(t) || t < 1 || t > owners.length) {
    return { error: `threshold must be a whole number between 1 and ${owners.length}`, status: 400 };
  }

  const m = /nonce: (\d+)/.exec(message ?? "");
  if (!m || Date.now() - Number(m[1]) > CHALLENGE_TTL_MS) {
    return { error: "this request expired — reload the page and sign again", status: 400 };
  }
  if (!verifySignature(address, message, signature)) {
    return { error: "the signature does not match that address", status: 401 };
  }

  // An owner who cannot send a transaction on CSB holds a signing key that can
  // never be used: the Safe is a contract and never originates a transaction, an
  // owner does. Caught here, while it is a sentence on a form, rather than as a
  // bare "execution reverted" the first time the wallet is needed.
  const blocked = [];
  for (const o of owners) {
    if (!(await canTransact(o))) blocked.push(o);
  }
  if (blocked.length) {
    return {
      error: `${blocked.length === 1 ? "an owner is" : "these owners are"} not on the `
        + `transaction allow list, so ${blocked.length === 1 ? "it" : "they"} could never `
        + `co-sign: ${blocked.join(", ")}. Request KYC for ${blocked.length === 1 ? "it" : "them"} first.`,
      status: 409,
    };
  }

  const list = readAll();
  const existing = list.findIndex((r) => r.address.toLowerCase() === address.toLowerCase());
  if (existing === -1 && list.length >= MAX_PENDING) {
    return { error: "the request queue is full — try again later", status: 503 };
  }
  const entry = {
    address,
    label,
    owners,
    threshold: t,
    requestedAt: new Date().toISOString(),
  };
  // A repeat from the same address replaces its pending request rather than
  // piling up — the same rule the KYC queue uses.
  if (existing >= 0) {
    entry.firstRequestedAt = list[existing].firstRequestedAt ?? list[existing].requestedAt;
    list[existing] = entry;
  } else {
    list.push(entry);
  }
  writeAll(list);
  return { ok: true, queued: existing >= 0 ? "updated" : "new", position: list.length };
}

/** Pending requests. Admin only — the caller enforces that. */
function list() {
  return readAll();
}

/** Drop a request once a wallet has been created for it, or it has been refused. */
function resolve(address) {
  const lower = String(address).toLowerCase();
  const all = readAll();
  const next = all.filter((r) => r.address.toLowerCase() !== lower);
  if (next.length === all.length) return false;
  writeAll(next);
  return true;
}

/** Is this address already queued? Used by the public page to show status. */
function statusOf(address) {
  const lower = String(address).toLowerCase();
  const found = readAll().find((r) => r.address.toLowerCase() === lower);
  return found
    ? { pending: true, requestedAt: found.requestedAt, owners: found.owners, threshold: found.threshold }
    : { pending: false };
}

module.exports = {
  challenge, submit, list, resolve, statusOf,
  _internal: { readAll, writeAll, MAX_PENDING, MAX_OWNERS },
};
