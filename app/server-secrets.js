/**
 * Secret stripping for anything the app server hands to a browser.
 *
 * `deployments.json` carries the pilot cast's private keys alongside the
 * contract addresses the wallet needs. /config used to return that file
 * verbatim with no authentication, so any visitor could read working keys for
 * accounts that are KYC-verified and on the transaction allow list. On a chain
 * whose entire claim is that every participant is known, that is not a lost test
 * balance — it is an anonymous stranger acquiring a verified identity.
 *
 * Lives in its own module so it can be tested without starting a listener, and
 * so there is one obvious place to look when asking "what does the browser get".
 */

// Drop by name first: these are the fields deploy.js and seed-accounts.js
// actually write.
const SECRET_KEYS = /^(key|deployerKey|privateKey|private_key|mnemonic|secret|seed|passphrase)$/i;

// Then drop by SHAPE, which is the rule that matters. The name list can only
// cover fields that exist today; a future edit adding a key under some other
// name would sail through it. A 32-byte hex string in a deployments file is
// never an address (20 bytes) and has no business reaching a browser.
const LOOKS_LIKE_SECRET = /^(0x)?[0-9a-fA-F]{64}$/;

function stripSecrets(value) {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.test(k)) continue;
      out[k] = stripSecrets(v);
    }
    return out;
  }
  if (typeof value === "string" && LOOKS_LIKE_SECRET.test(value)) return undefined;
  return value;
}

module.exports = { stripSecrets, _internal: { stripSecrets } };
