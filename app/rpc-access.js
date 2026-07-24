"use strict";
/**
 * Self-service scoped-RPC access. Instead of an admin issuing a token per user,
 * ANY KYC-active address can mint its own scoped RPC URL by proving control of
 * the address with a wallet signature. The URL embeds the address plus an HMAC
 * (keyed by a server secret) so it can't be forged for someone else, and access
 * is re-checked live on every request against on-chain KYC status + an admin
 * revoke list. So: onboarding is automatic; the admin only ever revokes.
 */
const crypto = require("crypto");
let ethers = null;
try { ethers = require("ethers"); } catch (_) { /* verifyMessage will error if used */ }

// Stable, unforgeable token for an address: "<address>-<hmac(secret,address)>".
// Deterministic (same address → same token) but unguessable without the secret.
function deriveToken(address, secret) {
  const a = address.toLowerCase();
  const mac = crypto.createHmac("sha256", secret).update(a).digest("hex").slice(0, 32);
  return `${a}-${mac}`;
}

// Recover the address from a token iff its HMAC checks out; else null.
function addressFromToken(token, secret) {
  if (typeof token !== "string" || !token.includes("-")) return null;
  const i = token.indexOf("-");
  const a = token.slice(0, i);
  const mac = token.slice(i + 1);
  if (!/^0x[0-9a-f]{40}$/.test(a)) return null;
  const expected = crypto.createHmac("sha256", secret).update(a).digest("hex").slice(0, 32);
  if (mac.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  } catch (_) { return null; }
  return a;
}

// True iff `signature` over `message` was produced by `address`.
function verifySignature(address, message, signature) {
  if (!ethers) throw new Error("ethers unavailable for signature verification");
  try {
    return ethers.verifyMessage(message, signature).toLowerCase() === String(address).toLowerCase();
  } catch (_) { return false; }
}

module.exports = { deriveToken, addressFromToken, verifySignature };
