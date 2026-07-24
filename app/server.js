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
const { filterBody } = require("./rpc-filter");

const RPC_URL = process.env.CSB_RPC_URL ?? "http://127.0.0.1:8545";
const PORT = Number(process.env.PORT ?? process.env.DEMO_PORT ?? 8080);
const PASSCODE = process.env.EXPLORER_PASSCODE ?? "csb-demo";
const TOKEN = crypto.createHash("sha256").update(`csb:${PASSCODE}`).digest("hex");
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
function lookupToken(token) {
  const file = process.env.CSB_RPC_TOKENS_FILE ?? path.join(__dirname, "rpc-tokens.json");
  if (!token || !fs.existsSync(file)) return null;
  try {
    const entry = JSON.parse(fs.readFileSync(file, "utf8"))[token];
    if (entry && typeof entry.address === "string") return entry;
  } catch (_) { /* malformed file → treat as no match */ }
  return null;
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
    const entry = lookupToken(decodeURIComponent(url.pathname.slice(5)));
    if (!entry) { send(res, 401, { error: "invalid or unknown RPC token" }, cors); return; }
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
      const out = await filterBody(body, entry.address, forward);
      send(res, 200, out, cors);
    } catch (e) {
      send(res, 502, { error: `scoped RPC error: ${e.message}` }, cors);
    }
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

  if (url.pathname === "/config") {
    const file = process.env.CSB_DEPLOYMENTS_FILE ?? path.join(__dirname, "deployments.json");
    if (!fs.existsSync(file)) {
      send(res, 404, { error: "deployments.json missing — run scripts/deploy.js (and optionally scripts/seed-accounts.js)" });
      return;
    }
    send(res, 200, fs.readFileSync(file, "utf8"));
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
