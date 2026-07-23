/**
 * CSB demo server — serves the wallet / explorer / admin UIs and proxies
 * JSON-RPC to the chain node behind an access gate, so the browser never
 * needs direct node access ("public within the country": all chain access
 * is authenticated and auditable).
 *
 * Env:
 *   CSB_RPC_URL       upstream node RPC (default http://127.0.0.1:8545 — Hardhat;
 *                     for an Avalanche L1 use http://127.0.0.1:9650/ext/bc/<id>/rpc)
 *   DEMO_PORT         listen port (default 8080)
 *   EXPLORER_PASSCODE access passcode (default "csb-demo")
 *
 * Plain Node, no dependencies. Demo-grade auth (shared passcode + cookie):
 * production uses the national identity login instead.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const RPC_URL = process.env.CSB_RPC_URL ?? "http://127.0.0.1:8545";
const PORT = Number(process.env.DEMO_PORT ?? 8080);
const PASSCODE = process.env.EXPLORER_PASSCODE ?? "csb-demo";
const TOKEN = crypto.createHash("sha256").update(`csb:${PASSCODE}`).digest("hex");

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

  if (req.method === "POST" && url.pathname === "/login") {
    const body = JSON.parse((await readBody(req)).toString() || "{}");
    if (body.passcode === PASSCODE) {
      accessLog.push({ at: new Date().toISOString(), event: "login", ip: req.socket.remoteAddress });
      send(res, 200, { ok: true }, { "Set-Cookie": `csb_session=${TOKEN}; HttpOnly; Path=/; SameSite=Strict` });
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
      send(res, 404, { error: "deployments.json missing — run scripts/deploy.js and scripts/seed-demo.js" });
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
  console.log(`CSB demo server on http://0.0.0.0:${PORT}  (RPC upstream: ${RPC_URL})`);
  console.log(`Passcode: ${PASSCODE === "csb-demo" ? "csb-demo (default — set EXPLORER_PASSCODE)" : "(from env)"}`);
});
