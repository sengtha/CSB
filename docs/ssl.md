# Enabling HTTPS (TLS) for the CSB app

The app server (`app/server.js`) speaks plain HTTP on port 8080 — fine for localhost and SSH tunnels, but a shared link should be HTTPS so the passcode and RPC traffic are encrypted. The server itself stays HTTP; you put a **TLS-terminating reverse proxy** in front of it. Two paths, pick one.

## Option A — Elestio's built-in reverse proxy (easiest, no cert work)

Elestio already serves a valid certificate for your `*.elestio.app` hostname. You just point its proxy at the app's port.

1. Elestio dashboard → your `csb-u70984` service → the reverse-proxy / "exposed ports" (sometimes *Config → Reverse Proxy* or *Ports*) panel.
2. Add a rule mapping the public HTTPS port **443** to the app container/host port **8080** (protocol HTTP upstream, HTTPS downstream).
3. Save; Elestio reloads its proxy. Your app is now at **`https://csb-u70984.vm.elestio.app`** (no `:8080`).
4. In the firewall panel you can then **close public 8080** — only 443 (proxy) and 9651 (validator P2P) need to be world-reachable.

This is the quickest route and needs zero certificate management. Exact menu names drift between Elestio versions; look for wherever a public port maps to an internal one (`docs/elestio.md` §B covers the same mapping).

## Option B — Caddy reverse proxy (custom domain, automatic Let's Encrypt)

Use this if you own a domain (e.g. `csb.example.gov`) and want a real certificate on it. Caddy fetches and renews Let's Encrypt certs automatically.

1. **DNS:** point an `A` record for your domain at the VM's public IP.
2. **Open 80 and 443** in the Elestio firewall (Caddy needs 80 for the ACME challenge, 443 for HTTPS). Keep 8080 **closed** to the world — only Caddy talks to it, on localhost.
3. Install Caddy and drop in the config (`infra/Caddyfile` in this repo — replace the domain):

```bash
# on the VM
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy

sudo cp /opt/csb/infra/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/csb.example.gov/YOUR-REAL-DOMAIN/' /etc/caddy/Caddyfile
sudo systemctl restart caddy
```

Caddy provisions the certificate on first request. Your app is then at `https://YOUR-REAL-DOMAIN` (Caddy → `localhost:8080`).

## After enabling TLS — tighten the app

Once HTTPS terminates in front, set the session cookie to TLS-only by launching the app with `COOKIE_SECURE=1`:

```bash
EXPLORER_PASSCODE='<strong>' CSB_RPC_URL=$RPC COOKIE_SECURE=1 nohup node app/server.js > /tmp/app.log 2>&1 &
```

(Default is off so plain-HTTP / SSH-tunnel access works during setup. Turn it on only when the app is always reached over HTTPS — otherwise the browser drops the cookie and login appears to fail.)

Also, whichever option you choose:

- **Set a strong `EXPLORER_PASSCODE`** — never leave it at the `csb-demo` default on a public URL.
- **Close public port 8080** once the proxy fronts it; the proxy reaches the app over localhost.
- The node RPC (9650) must **never** be exposed — the gated app is the only public door to chain data. That is the "public within the country, private to the world" boundary in operational form.

## Reminder: this is still a testnet demo gate

The passcode + cookie is pilot-grade access control. Production replaces it with national digital-identity login and per-user audit logging (see `docs/architecture.md` §9). TLS protects the transport; it does not upgrade the auth model.
