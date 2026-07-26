"use strict";
/**
 * Self-service KYC requests.
 *
 * A visitor with a wallet asks to be registered; an authority approves it in the
 * admin console. Between those two moments the request lives HERE — in a file on
 * the app server — and not on the chain.
 *
 * That split is the whole design:
 *
 *   - A request is not an attestation. Nothing about it is on chain, so an
 *     unapproved request confers nothing and costs nothing to discard.
 *   - The label a visitor types is free text they chose. It stays in this file
 *     and is shown to the approver only. It is NEVER written on chain — the
 *     chain stores a commitment hash and a tier, never a name. A "request KYC"
 *     form is exactly where personal data would leak onto a ledger if nobody
 *     drew the line, so it is drawn here.
 *
 * Every request must carry a signature from the address it names. Without that,
 * anyone could file requests for addresses they do not control: an approver
 * would be registering strangers, and a bored visitor could fill the queue with
 * other people's addresses. The signature makes a request mean "I hold this key
 * and I am asking", which is the only claim worth queueing.
 */
const fs = require("fs");
const path = require("path");
const { verifySignature } = require("./rpc-access");

// This endpoint is public and writes to disk, so it needs a ceiling. One pending
// request per address (a repeat replaces it), and a hard cap on the queue.
const MAX_PENDING = 200;
const MAX_LABEL = 80;
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const VALID_TIERS = [1, 2, 3, 4];

function file() {
  return process.env.CSB_KYC_REQUESTS_FILE ?? path.join(__dirname, "kyc-requests.json");
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

/** The message a requester signs. Says plainly what it authorises. */
function challenge() {
  return "CSB — request KYC verification\n"
    + "Signing this proves you control this address and asks an authority to review it.\n"
    + "It is free, sends no transaction, and grants nothing by itself.\n"
    + `nonce: ${Date.now()}`;
}

/**
 * Validate and queue a request. Returns { ok } or { error, status }.
 * `isRegistered` is an async predicate so the caller decides how to ask the
 * chain — this module never talks to a node itself.
 */
async function submit(body, isRegistered) {
  const { address, message, signature } = body ?? {};
  const label = String(body?.label ?? "").trim().slice(0, MAX_LABEL);
  const tier = Number(body?.tier);

  if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? "")) {
    return { error: "a valid 0x address is required", status: 400 };
  }
  if (!VALID_TIERS.includes(tier)) {
    return { error: "choose a tier between 1 and 4", status: 400 };
  }
  const m = /nonce: (\d+)/.exec(message ?? "");
  if (!m || Date.now() - Number(m[1]) > CHALLENGE_TTL_MS) {
    return { error: "this request expired — reload the page and sign again", status: 400 };
  }
  if (!verifySignature(address, message, signature)) {
    return { error: "the signature does not match that address", status: 401 };
  }
  // Already verified on chain: say so rather than queueing work that is done.
  if (await isRegistered(address)) {
    return { error: "this address already has an active KYC attestation", status: 409 };
  }

  const list = readAll();
  const lower = address.toLowerCase();
  const existing = list.findIndex((r) => r.address.toLowerCase() === lower);
  if (existing === -1 && list.length >= MAX_PENDING) {
    return { error: "the review queue is full — try again later", status: 503 };
  }
  const entry = {
    address,
    label,
    tier,
    requestedAt: new Date().toISOString(),
  };
  // A repeat request from the same address updates it rather than piling up.
  if (existing >= 0) list[existing] = { ...entry, firstRequestedAt: list[existing].firstRequestedAt ?? list[existing].requestedAt };
  else list.push(entry);
  writeAll(list);
  return { ok: true, queued: existing >= 0 ? "updated" : "new", position: list.length };
}

/** Pending requests, newest last. Admin-only — the caller enforces that. */
function list() {
  return readAll();
}

/** Drop a request once it has been approved or refused on chain. */
function resolve(address) {
  const lower = String(address).toLowerCase();
  const list = readAll();
  const next = list.filter((r) => r.address.toLowerCase() !== lower);
  if (next.length === list.length) return false;
  writeAll(next);
  return true;
}

/** Is this address already queued? Used by the public page to show status. */
function statusOf(address) {
  const lower = String(address).toLowerCase();
  const found = readAll().find((r) => r.address.toLowerCase() === lower);
  return found ? { pending: true, requestedAt: found.requestedAt, tier: found.tier } : { pending: false };
}

module.exports = { challenge, submit, list, resolve, statusOf, _internal: { readAll, writeAll, MAX_PENDING } };
