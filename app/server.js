/**
 * CSB app server — serves the wallet / explorer / admin UIs and proxies
 * JSON-RPC to the chain node behind an access gate, so the browser never
 * needs direct node access ("public within the country": all chain access
 * is authenticated and auditable).
 *
 * Env:
 *   CSB_RPC_URL       upstream node RPC, e.g. http://127.0.0.1:9650/ext/bc/<id>/rpc
 *                     (default http://127.0.0.1:8545 — local Hardhat, for development)
 *   PORT              listen port (default 8080)
 *   EXPLORER_PASSCODE access passcode (default "csb-demo" — development only)
 *
 * Plain Node, no dependencies. Pilot-grade auth (shared passcode + cookie):
 * production uses the national identity login instead.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { stripSecrets } = require("./server-secrets");
const { filterBody } = require("./rpc-filter");
const { deriveToken, addressFromToken, verifySignature } = require("./rpc-access");
const { fundReport } = require("./fund");
const { nodeInfo } = require("./node-info");
const { assets } = require("./assets");
const { useCases, useCaseCheck } = require("./use-cases");
const grove = require("./grove");
const kyc = require("./kyc-requests");
const safeReq = require("./safe-requests");
const { safes, _internal: safeDecode } = require("./safes");
const safeTxs = require("./safe-txs");

const RPC_URL = process.env.CSB_RPC_URL ?? "http://127.0.0.1:8545";
const PORT = Number(process.env.PORT ?? process.env.DEMO_PORT ?? 8080);
const PASSCODE = process.env.EXPLORER_PASSCODE ?? "csb-demo";
const TOKEN = crypto.createHash("sha256").update(`csb:${PASSCODE}`).digest("hex");
// Secret that keys the self-service scoped-RPC tokens. Stable across restarts as
// long as the passcode is stable; override with SCOPED_RPC_SECRET to rotate all
// issued URLs at once.
const SCOPED_SECRET = process.env.SCOPED_RPC_SECRET ?? crypto.createHash("sha256").update(`csb-scoped-rpc:${PASSCODE}`).digest("hex");
// Set COOKIE_SECURE=1 once the app is always served over HTTPS (behind a TLS
// reverse proxy — see docs/ssl.md). Left off by default so plain-HTTP / SSH
// tunnel access still works during setup.
const COOKIE_SECURE = process.env.COOKIE_SECURE === "1" ? "; Secure" : "";

const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

const accessLog = [];

function authed(req) {
  const cookies = req.headers.cookie ?? "";
  return cookies.split(";").some((c) => c.trim() === `csb_session=${TOKEN}`);
}

// Scoped-RPC token registry: maps a per-user URL token to a KYC'd address, so a
// wallet (MetaMask etc.) at /rpc/<token> gets a read-filtered view of only that
// address's data. File format: { "<token>": { "address": "0x..", "label": ".." } }.
// Read per-request so newly issued tokens work without a restart. Gitignored.
function tokensFile() {
  return process.env.CSB_RPC_TOKENS_FILE ?? path.join(__dirname, "rpc-tokens.json");
}
function readTokens() {
  const f = tokensFile();
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return {}; }
}
function writeTokens(map) {
  fs.writeFileSync(tokensFile(), JSON.stringify(map, null, 2));
}
function lookupToken(token) {
  if (!token) return null;
  const entry = readTokens()[token];
  return entry && typeof entry.address === "string" ? entry : null;
}

// Admin revoke list for scoped RPC (denylist of lowercased addresses). Gitignored.
function revokedFile() {
  return process.env.CSB_RPC_REVOKED_FILE ?? path.join(__dirname, "rpc-revoked.json");
}
function readRevoked() {
  try { return new Set(JSON.parse(fs.readFileSync(revokedFile(), "utf8")).map((a) => String(a).toLowerCase())); }
  catch (_) { return new Set(); }
}
function writeRevoked(set) {
  fs.writeFileSync(revokedFile(), JSON.stringify([...set], null, 2));
}

// deployments.json, or null when it hasn't been generated yet. Re-read each
// time so a redeploy is picked up without restarting the app.
function loadDeployments() {
  try {
    const file = process.env.CSB_DEPLOYMENTS_FILE ?? path.join(__dirname, "deployments.json");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) { return null; }
}

// IdentityRegistry address from deployments.json (for live KYC checks).
function identityAddress() {
  return loadDeployments()?.contracts?.IdentityRegistry ?? null;
}

// Live on-chain KYC check: IdentityRegistry.isActive(address). Cached ~30s so a
// chatty wallet doesn't hammer the node. Fails closed (false) if unavailable.
const ISACTIVE_SELECTOR = "0x9f8a13d7";
const _kycCache = new Map();
// `fresh` skips the cache. Anywhere a person is watching for a change they just
// asked for, a 30-second-stale "no" is worse than a slightly slower answer: an
// address approved seconds ago would be told it is not registered, which reads
// as the approval having failed.
async function isKycActive(address, fresh = false) {
  const now = Date.now();
  const cached = _kycCache.get(address);
  if (!fresh && cached && now - cached.at < 30000) return cached.active;
  const identity = identityAddress();
  if (!identity) return false;
  const data = ISACTIVE_SELECTOR + "000000000000000000000000" + address.toLowerCase().replace(/^0x/, "");
  try {
    const up = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: identity, data }, "latest"] }),
    });
    const j = await up.json();
    const active = typeof j.result === "string" && j.result.length >= 3 && BigInt(j.result) !== 0n;
    _kycCache.set(address, { active, at: now });
    return active;
  } catch (_) { return false; }
}

// --- reading a Safe from the chain ---------------------------------------
//
// Owners, threshold and nonce are asked of the wallet itself on every request.
// They decide whether a signature counts and whether a proposal can still be
// executed, so caching them would mean an owner removed this morning still
// approving things this afternoon.
const SAFE_SEL = { getOwners: "0xa0e67e2b", getThreshold: "0xe75235b8", nonce: "0xaffed0e0" };

async function ethCall(to, data) {
  const up = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
  });
  const j = await up.json();
  if (j.error) throw new Error(j.error.message ?? "eth_call failed");
  return typeof j.result === "string" ? j.result : "0x";
}

let _chainId = null;
async function chainIdOf() {
  if (_chainId !== null) return _chainId;
  const up = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
  });
  const j = await up.json();
  if (typeof j.result !== "string") throw new Error("could not read the chain id");
  _chainId = BigInt(j.result);
  return _chainId;
}

// An address with no code, or one that is not a Safe, answers "0x" — reported as
// "no owners" so the caller can say "not a Safe on this chain" rather than
// showing a wallet with an empty owner list, which reads as a wallet nobody owns.
async function safeOwners(addr) {
  try { return safeDecode.decodeAddressArray(await ethCall(addr, SAFE_SEL.getOwners)); }
  catch (_) { return []; }
}
async function safeThreshold(addr) {
  try { const h = await ethCall(addr, SAFE_SEL.getThreshold); return h === "0x" ? 0 : Number(BigInt(h)); }
  catch (_) { return 0; }
}
async function safeNonce(addr) {
  const h = await ethCall(addr, SAFE_SEL.nonce);
  return h === "0x" ? 0n : BigInt(h);
}

// Can this address send a transaction on CSB at all? Distinct from KYC: the
// txAllowList precompile is what actually decides, and the two gates are
// independent (docs/architecture.md §4). A Safe owner who is not on this list
// holds a key that can never be used, because the Safe is a contract and never
// originates a transaction — an owner does.
const READ_ALLOWLIST_SELECTOR = "0xeb54dae1";
const TX_ALLOWLIST = "0x0200000000000000000000000000000000000002";
async function canTransact(address) {
  const data = READ_ALLOWLIST_SELECTOR + "000000000000000000000000"
    + address.toLowerCase().replace(/^0x/, "");
  try {
    const up = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call",
        params: [{ to: TX_ALLOWLIST, data }, "latest"] }),
    });
    const j = await up.json();
    if (j.error) return false;
    // THREE OUTCOMES, NOT TWO. A chain without the precompile — any local
    // Hardhat node — answers "0x" for a call to an address with no code, which
    // is not "this address may not transact". Reading it as a refusal makes the
    // request form permanently unusable off CSB, with an error message blaming
    // an allow list that does not exist. Absent means unrestricted.
    if (typeof j.result !== "string" || j.result === "0x" || j.result.length < 66) return true;
    return BigInt(j.result) !== 0n;   // 0 = None; 1/2/3 = enabled/admin/manager
  } catch (_) {
    // A node that cannot be reached must not silently turn into "this owner is
    // fine". Refusing is recoverable; queueing a wallet whose owners can never
    // sign is discovered much later, by someone who needs it to work.
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res, code, body, headers = {}) {
  res.writeHead(code, { "Content-Type": "application/json", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // URL login: visit any page with ?pw=<passcode> to authenticate without the
  // form field, e.g. https://host/explorer.html?pw=csbfuji2026 — sets the
  // session cookie and redirects to the same page without the query string.
  if (req.method === "GET" && url.searchParams.get("pw") !== null) {
    const ok = url.searchParams.get("pw") === PASSCODE;
    accessLog.push({ at: new Date().toISOString(), event: ok ? "login-url" : "login-denied", ip: req.socket.remoteAddress });
    url.searchParams.delete("pw");
    const dest = url.pathname + (url.searchParams.toString() ? "?" + url.searchParams.toString() : "");
    const headers = { Location: dest };
    if (ok) headers["Set-Cookie"] = `csb_session=${TOKEN}; HttpOnly; Path=/; SameSite=Strict${COOKIE_SECURE}`;
    res.writeHead(302, headers);
    res.end();
    return;
  }

  if (req.method === "POST" && url.pathname === "/login") {
    const body = JSON.parse((await readBody(req)).toString() || "{}");
    if (body.passcode === PASSCODE) {
      accessLog.push({ at: new Date().toISOString(), event: "login", ip: req.socket.remoteAddress });
      send(res, 200, { ok: true }, { "Set-Cookie": `csb_session=${TOKEN}; HttpOnly; Path=/; SameSite=Strict${COOKIE_SECURE}` });
    } else {
      accessLog.push({ at: new Date().toISOString(), event: "login-denied", ip: req.socket.remoteAddress });
      send(res, 401, { ok: false, error: "invalid passcode" });
    }
    return;
  }

  if (url.pathname === "/session") {
    send(res, 200, { authed: authed(req) });
    return;
  }

  // Node info — public chain facts. Same reasoning as /fund: these are public
  // identifiers already published in the repo's deployment notes, and a live
  // page beats a document that goes stale on every redeploy. It exposes nothing
  // actionable and is not an RPC passthrough.
  if (url.pathname === "/node-info") {
    try {
      send(res, 200, await nodeInfo(RPC_URL, loadDeployments()), { "Cache-Control": "public, max-age=10" });
    } catch (e) {
      send(res, 502, { error: e.message });
    }
    return;
  }

  // Token / NFT viewer data. Public, read-only, and scoped: it reports what
  // tokens exist on this chain, plus the holdings of an address the CALLER
  // names. It cannot enumerate holders — browsing who owns what would work
  // around the read-privacy model the chain exists to provide.
  if (url.pathname === "/assets") {
    try {
      send(res, 200, await assets(RPC_URL, loadDeployments(), {
        address: url.searchParams.get("address"),
      }), { "Cache-Control": "public, max-age=8" });
    } catch (e) {
      send(res, 502, { error: e.message });
    }
    return;
  }

  // Use-case demonstrations: live state, and rule checks anyone can run.
  // Read-only — every check is a canX() view the contracts already expose so a
  // wallet can explain a refusal before anyone signs. Nothing moves, and the
  // response is assembled field by field so the demo casts' private keys (which
  // sit beside them in deployments.json) cannot leak through it.
  if (url.pathname === "/use-cases") {
    try {
      send(res, 200, await useCases(RPC_URL, loadDeployments()), { "Cache-Control": "public, max-age=6" });
    } catch (e) {
      send(res, e.code === "NO_DEPLOYMENT" ? 404 : 502, { error: e.message });
    }
    return;
  }
  if (url.pathname === "/use-cases/check") {
    try {
      send(res, 200, await useCaseCheck(RPC_URL, loadDeployments(), {
        kase: url.searchParams.get("case"),
        to: url.searchParams.get("to"),
        amount: url.searchParams.get("amount"),
      }));
    } catch (e) {
      send(res, 502, { error: e.message });
    }
    return;
  }

  // Grove: the chain's half of a verified digital twin, for CamboVerse and
  // anyone else rendering one.
  //
  // Public, read-only, and CORS-open on purpose. A "verified" badge in a virtual
  // grove is worth nothing if the only way to check it is to ask the project
  // that drew it — the point is that a stranger with curl gets the same answer.
  // Everything here is an eth_call a reader could make against the RPC node
  // directly; this server computes nothing and signs nothing.
  //
  // The plot is a 32-byte hash, never the Grove plot string: a garden's name is
  // often its owner's name, and this chain is readable by a whole country.
  if (url.pathname === "/grove" || url.pathname === "/grove/plot") {
    const cors = { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=6" };
    if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
    try {
      const plot = url.searchParams.get("plot");
      const body = plot
        ? await grove.cached(`plot:${plot}`, () => grove.grovePlot(RPC_URL, loadDeployments(), plot))
        : await grove.cached("stats", () => grove.groveStats(RPC_URL, loadDeployments()));
      send(res, body?.error ? 400 : 200, body, cors);
    } catch (e) {
      send(res, e.code === "NO_DEPLOYMENT" ? 404 : 502, { error: e.message }, cors);
    }
    return;
  }

  // The demo grove behind the use-cases page — live state, not a screenshot.
  if (url.pathname === "/grove/demo") {
    const cors = { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=6" };
    if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
    try {
      send(res, 200, await grove.cached("demo", () => grove.groveDemo(RPC_URL, loadDeployments())) ?? null, cors);
    } catch (e) {
      send(res, 502, { error: e.message }, cors);
    }
    return;
  }

  // Registered grove titles, and what one address holds of each. Public in the
  // same shape as /assets: what EXISTS is checkable by anyone, holdings only for
  // an address the caller already knows.
  if (url.pathname === "/grove/titles") {
    const cors = { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=6" };
    if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
    try {
      const addr = url.searchParams.get("address");
      send(res, 200, await grove.cached(`titles:${addr ?? ""}`,
        () => grove.groveTitles(RPC_URL, loadDeployments(), { address: addr })), cors);
    } catch (e) {
      send(res, 502, { error: e.message }, cors);
    }
    return;
  }

  // One canX() question for the page's "Try it" panel. Read-only: these are the
  // same views a wallet calls to explain a refusal before anyone signs, so the
  // answer is the chain's, not this server's. Nothing moves.
  if (url.pathname === "/grove/check") {
    const cors = { "Access-Control-Allow-Origin": "*" };
    if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
    try {
      send(res, 200, await grove.groveCheck(RPC_URL, loadDeployments(), {
        kase: url.searchParams.get("case"),
        address: url.searchParams.get("address"),
        observationId: url.searchParams.get("observation"),
        pledgeId: url.searchParams.get("pledge"),
        milestone: url.searchParams.get("milestone"),
      }), cors);
    } catch (e) {
      send(res, 502, { error: e.message }, cors);
    }
    return;
  }

  // KYC requests. The SUBMIT side is public on purpose: someone who is not yet
  // verified cannot hold a passcode, so requiring one would mean only insiders
  // could ask. A wallet signature stands in for the login — it proves the
  // requester holds the address, which is the only claim worth queueing.
  // Reading and clearing the queue is admin-only.
  if (url.pathname === "/kyc-request/challenge" && req.method === "GET") {
    send(res, 200, { message: kyc.challenge() });
    return;
  }
  if (url.pathname === "/kyc-request" && req.method === "POST") {
    try {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      const out = await kyc.submit(body, (a) => isKycActive(a));
      if (out.error) { send(res, out.status ?? 400, { error: out.error }); return; }
      accessLog.push({ at: new Date().toISOString(), event: "kyc-request", ip: req.socket.remoteAddress });
      send(res, 200, out);
    } catch (e) {
      send(res, 400, { error: e.message });
    }
    return;
  }
  if (url.pathname === "/kyc-request/status") {
    const a = url.searchParams.get("address");
    if (!/^0x[0-9a-fA-F]{40}$/.test(a ?? "")) { send(res, 400, { error: "a valid 0x address is required" }); return; }
    send(res, 200, { ...kyc.statusOf(a), kyc: await isKycActive(a, true) });
    return;
  }
  // --- multisig wallets ---------------------------------------------------
  //
  // Public: what exists is checkable by anyone, which is the same rule the
  // assets endpoint follows. Who owns what is on the chain already; hiding it
  // here would only make the page less useful than a block explorer.
  if (url.pathname === "/safes") {
    try {
      send(res, 200, await safes(RPC_URL, loadDeployments(), {
        address: url.searchParams.get("address") ?? undefined,
      }));
    } catch (e) { send(res, 502, { error: e.message }); }
    return;
  }
  // Pending transactions for a wallet. The owner list and the nonce are read
  // from the CHAIN on every call, never taken from the caller — they are what
  // decides whether a signature counts and whether a proposal can still execute.
  if (url.pathname === "/safe-txs" && req.method === "GET") {
    const safe = url.searchParams.get("safe");
    if (!/^0x[0-9a-fA-F]{40}$/.test(safe ?? "")) { send(res, 400, { error: "a valid 0x safe address is required" }); return; }
    try {
      const [owners, nonce, threshold] = await Promise.all([
        safeOwners(safe), safeNonce(safe), safeThreshold(safe)]);
      if (!owners.length) { send(res, 404, { error: "not a Safe on this chain" }); return; }
      send(res, 200, { safe, owners, threshold, nonce: String(nonce), pending: safeTxs.list(safe, nonce) });
    } catch (e) { send(res, 502, { error: e.message }); }
    return;
  }
  if (url.pathname === "/safe-txs" && req.method === "POST") {
    try {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      const out = await safeTxs.propose(body, safeOwners, await chainIdOf());
      if (out.error) { send(res, out.status ?? 400, { error: out.error }); return; }
      accessLog.push({ at: new Date().toISOString(), event: "safe-tx-propose", ip: req.socket.remoteAddress });
      send(res, 200, out);
    } catch (e) { send(res, 400, { error: e.message }); }
    return;
  }
  if (url.pathname.startsWith("/safe-txs/") && req.method === "POST") {
    const hash = decodeURIComponent(url.pathname.slice("/safe-txs/".length)).replace(/\/sign$/, "");
    try {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      const out = await safeTxs.sign(hash, body, safeOwners);
      if (out.error) { send(res, out.status ?? 400, { error: out.error }); return; }
      send(res, 200, out);
    } catch (e) { send(res, 400, { error: e.message }); }
    return;
  }
  if (url.pathname.startsWith("/safe-txs/") && req.method === "DELETE") {
    // Discarding a proposal withdraws nothing from the chain — it only stops
    // this server offering it for signature. Anything already executed stays
    // executed, and a signature already given stays valid if someone kept it.
    if (!authed(req)) { send(res, 401, { error: "not authenticated" }); return; }
    const hash = decodeURIComponent(url.pathname.slice("/safe-txs/".length));
    const gone = safeTxs.remove(hash);
    send(res, gone ? 200 : 404, gone ? { ok: true } : { error: "no such pending transaction" });
    return;
  }

  if (url.pathname === "/safe-request/challenge" && req.method === "GET") {
    send(res, 200, { message: safeReq.challenge() });
    return;
  }
  if (url.pathname === "/safe-request" && req.method === "POST") {
    try {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      const out = await safeReq.submit(body, (a) => canTransact(a));
      if (out.error) { send(res, out.status ?? 400, { error: out.error }); return; }
      accessLog.push({ at: new Date().toISOString(), event: "safe-request", ip: req.socket.remoteAddress });
      send(res, 200, out);
    } catch (e) {
      send(res, 400, { error: e.message });
    }
    return;
  }
  if (url.pathname === "/safe-request/status") {
    const a = url.searchParams.get("address");
    if (!/^0x[0-9a-fA-F]{40}$/.test(a ?? "")) { send(res, 400, { error: "a valid 0x address is required" }); return; }
    send(res, 200, safeReq.statusOf(a));
    return;
  }
  // The queue. Admin only — it holds the label a requester typed.
  if (url.pathname === "/safe-requests" || url.pathname.startsWith("/safe-requests/")) {
    if (!authed(req)) { send(res, 401, { error: "not authenticated" }); return; }
    if (req.method === "GET") { send(res, 200, safeReq.list()); return; }
    if (req.method === "DELETE") {
      // Creating the wallet happens ON CHAIN, signed in the operator's browser
      // by a key with deployer rights — the server never holds one. This only
      // clears the queue entry once that has actually happened.
      const a = decodeURIComponent(url.pathname.slice("/safe-requests/".length));
      // Once — resolve() mutates. Calling it twice to pick a status code would
      // always take the second, failing branch.
      const removed = safeReq.resolve(a);
      send(res, removed ? 200 : 404, removed ? { ok: true } : { error: "no such request" });
      return;
    }
    send(res, 405, { error: "method not allowed" });
    return;
  }

  // The queue itself — who asked, and what they typed. Admin only.
  if (url.pathname === "/kyc-requests" || url.pathname.startsWith("/kyc-requests/")) {
    if (!authed(req)) { send(res, 401, { error: "not authenticated" }); return; }
    if (req.method === "GET") { send(res, 200, kyc.list()); return; }
    if (req.method === "DELETE") {
      const a = decodeURIComponent(url.pathname.slice("/kyc-requests/".length));
      // Approving happens ON CHAIN, signed in the admin's browser by the
      // authority key — the server never holds it. This only clears the queue
      // entry once that transaction has confirmed.
      const removed = kyc.resolve(a); // once: it is destructive, not a predicate
      send(res, removed ? 200 : 404, removed ? { ok: true } : { error: "no such request" });
      return;
    }
    send(res, 405, { error: "method not allowed" });
    return;
  }

  // Public-good fund — the one DELIBERATELY PUBLIC endpoint. No passcode, no
  // session: anyone can audit what the fund holds and where it came from, which
  // is the transparency claim itself rather than a gap in the gate. It is narrow
  // by construction — one address's public data, not an RPC passthrough — so it
  // cannot be used to read anyone else's balances or transactions.
  if (url.pathname === "/fund") {
    try {
      const data = await fundReport(RPC_URL, loadDeployments(), {
        blocks: url.searchParams.get("blocks"),
        address: /^0x[0-9a-fA-F]{40}$/.test(url.searchParams.get("address") ?? "")
          ? url.searchParams.get("address") : undefined,
      });
      send(res, 200, data, { "Cache-Control": "public, max-age=15" });
    } catch (e) {
      send(res, e.code === "NO_FUND" ? 404 : 502, { error: e.message });
    }
    return;
  }

  // Scoped per-user RPC: /rpc/<token>. Token-authenticated (no cookie — wallets
  // can't send one), read-filtered to the token's address. This is the door a
  // KYC user points MetaMask at; they see only their own data.
  if (url.pathname.startsWith("/rpc/")) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
    if (req.method !== "POST") { send(res, 405, { error: "POST only" }, cors); return; }
    const rawToken = decodeURIComponent(url.pathname.slice(5));
    // Self-service token (address embedded + HMAC): gate live on KYC status and
    // the admin revoke list, so access follows on-chain KYC automatically.
    let address = addressFromToken(rawToken, SCOPED_SECRET);
    if (address) {
      if (readRevoked().has(address)) { send(res, 403, { error: "scoped RPC access revoked by admin" }, cors); return; }
      if (!(await isKycActive(address))) { send(res, 403, { error: "address is not KYC-active" }, cors); return; }
    } else {
      // Fall back to a manually-issued stored token (optional override).
      const entry = lookupToken(rawToken);
      if (!entry) { send(res, 401, { error: "invalid or unknown RPC token" }, cors); return; }
      address = entry.address;
    }
    try {
      const body = JSON.parse((await readBody(req)).toString() || "null");
      const forward = async (call) => {
        const up = await fetch(RPC_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(call),
        });
        return up.json();
      };
      const out = await filterBody(body, address, forward);
      send(res, 200, out, cors);
    } catch (e) {
      send(res, 502, { error: `scoped RPC error: ${e.message}` }, cors);
    }
    return;
  }

  // Self-service scoped-RPC minting: a wallet proves control of its address with
  // a signature and gets its scoped URL. No admin, no cookie — the signature is
  // the auth. Access is still gated live (KYC + revoke) on every /rpc call.
  if (url.pathname === "/rpc-access/challenge" && req.method === "GET") {
    const message = `CSB scoped RPC access\nSign this to prove you control this address. It grants a read-only view of only your own data.\nnonce: ${Date.now()}`;
    send(res, 200, { message });
    return;
  }
  if (url.pathname === "/rpc-access/mint" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)).toString() || "{}");
    const { address, message, signature } = b;
    const m = /nonce: (\d+)/.exec(message || "");
    if (!m || Date.now() - Number(m[1]) > 10 * 60 * 1000) { send(res, 400, { error: "challenge expired — reload and sign again" }); return; }
    if (!/^0x[0-9a-fA-F]{40}$/.test(address || "") || !verifySignature(address, message, signature)) {
      send(res, 401, { error: "signature does not match the address" });
      return;
    }
    if (readRevoked().has(address.toLowerCase())) { send(res, 403, { error: "access revoked by admin" }); return; }
    if (!(await isKycActive(address))) { send(res, 403, { error: "this address is not KYC-active — complete KYC first" }); return; }
    send(res, 200, { path: `/rpc/${deriveToken(address, SCOPED_SECRET)}` });
    return;
  }

  // Admin revoke list management (cookie-gated).
  if (url.pathname === "/rpc-revoked" || url.pathname.startsWith("/rpc-revoked/")) {
    if (!authed(req)) { send(res, 401, { error: "not authenticated" }); return; }
    const set = readRevoked();
    if (req.method === "GET") { send(res, 200, [...set]); return; }
    if (req.method === "POST") {
      const b = JSON.parse((await readBody(req)).toString() || "{}");
      if (!/^0x[0-9a-fA-F]{40}$/.test(b.address ?? "")) { send(res, 400, { error: "a valid 0x address is required" }); return; }
      set.add(b.address.toLowerCase()); writeRevoked(set); send(res, 200, { ok: true });
      return;
    }
    if (req.method === "DELETE") {
      set.delete(decodeURIComponent(url.pathname.slice("/rpc-revoked/".length)).toLowerCase());
      writeRevoked(set); send(res, 200, { ok: true });
      return;
    }
    send(res, 405, { error: "method not allowed" });
    return;
  }

  // Admin convenience: compute the scoped URL for any address (to hand to a user
  // who can't self-serve). Cookie-gated; does not itself grant access.
  if (url.pathname === "/rpc-access/url-for" && req.method === "POST") {
    if (!authed(req)) { send(res, 401, { error: "not authenticated" }); return; }
    const b = JSON.parse((await readBody(req)).toString() || "{}");
    if (!/^0x[0-9a-fA-F]{40}$/.test(b.address ?? "")) { send(res, 400, { error: "a valid 0x address is required" }); return; }
    send(res, 200, { path: `/rpc/${deriveToken(b.address, SCOPED_SECRET)}` });
    return;
  }

  // Everything below the gate requires a session.
  if (url.pathname === "/rpc" || url.pathname === "/config" || url.pathname === "/access-log") {
    if (!authed(req)) {
      send(res, 401, { error: "not authenticated" });
      return;
    }
  }

  if (req.method === "POST" && url.pathname === "/rpc") {
    try {
      const body = await readBody(req);
      const upstream = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      send(res, upstream.status, await upstream.text());
    } catch (e) {
      send(res, 502, { error: `upstream RPC unreachable: ${e.message}` });
    }
    return;
  }

  // Scoped-RPC token management (admin only, cookie-gated). List / issue /
  // revoke the per-user tokens used by /rpc/<token>. These write app-level state
  // (rpc-tokens.json), not the chain.
  if (url.pathname === "/rpc-tokens" || url.pathname.startsWith("/rpc-tokens/")) {
    if (!authed(req)) { send(res, 401, { error: "not authenticated" }); return; }
    const map = readTokens();
    if (req.method === "GET") {
      const list = Object.entries(map)
        .filter(([, v]) => v && typeof v === "object" && typeof v.address === "string")
        .map(([token, v]) => ({ token, address: v.address, label: v.label ?? "" }));
      send(res, 200, list);
      return;
    }
    if (req.method === "POST") {
      const b = JSON.parse((await readBody(req)).toString() || "{}");
      if (!/^0x[0-9a-fA-F]{40}$/.test(b.address ?? "")) { send(res, 400, { error: "a valid 0x address is required" }); return; }
      const token = crypto.randomBytes(24).toString("hex");
      map[token] = { address: b.address, label: String(b.label ?? "").slice(0, 64) };
      writeTokens(map);
      send(res, 200, { token, address: b.address, label: map[token].label });
      return;
    }
    if (req.method === "DELETE") {
      const token = decodeURIComponent(url.pathname.slice("/rpc-tokens/".length));
      if (map[token]) { delete map[token]; writeTokens(map); send(res, 200, { ok: true }); }
      else { send(res, 404, { error: "token not found" }); }
      return;
    }
    send(res, 405, { error: "method not allowed" });
    return;
  }

  if (url.pathname === "/config") {
    const file = process.env.CSB_DEPLOYMENTS_FILE ?? path.join(__dirname, "deployments.json");
    if (!fs.existsSync(file)) {
      send(res, 404, { error: "deployments.json missing — run scripts/deploy.js (and optionally scripts/seed-accounts.js)" });
      return;
    }
    // deployments.json holds the pilot cast's PRIVATE KEYS, and this route used
    // to return the file verbatim to anyone who asked — no cookie, no passcode.
    // On a chain whose entire claim is that every participant is known, handing
    // out working keys for KYC'd, allow-listed accounts is worse than losing
    // test funds: an anonymous visitor acquires a verified identity.
    //
    // Contract addresses are genuinely public — the wallet needs them before
    // login — so the route still answers unauthenticated. The keys are the part
    // that must not travel, and they are only included for an authenticated
    // session, where they drive the demo's "act as Sokha" account picker.
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    send(res, 200, authed(req) ? parsed : stripSecrets(parsed));
    return;
  }

  if (url.pathname === "/access-log") {
    send(res, 200, accessLog.slice(-100));
    return;
  }

  // Static files
  let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, "");
  const full = path.join(PUBLIC_DIR, filePath);
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    send(res, 404, { error: "not found" });
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(full)] ?? "application/octet-stream" });
  res.end(fs.readFileSync(full));
});

server.listen(PORT, () => {
  console.log(`CSB app server on http://0.0.0.0:${PORT}  (RPC upstream: ${RPC_URL})`);
  console.log(`Passcode: ${PASSCODE === "csb-demo" ? "csb-demo (default — set EXPLORER_PASSCODE)" : "(from env)"}`);
});
