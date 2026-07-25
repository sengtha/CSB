/**
 * "Connect wallet" — a header widget available on every page, no login needed.
 *
 * It walks the whole path a newcomer needs, which is otherwise four manual steps
 * across two pages:
 *
 *   1. connect a wallet                     (eth_requestAccounts)
 *   2. prove the address is yours           (personal_sign of a server challenge)
 *   3. receive a scoped RPC URL             (server checks KYC, returns /rpc/<token>)
 *   4. add CSB to the wallet with that URL  (wallet_addEthereumChain)
 *
 * Step 3 is the part that makes CSB different and is worth understanding: the
 * node's own RPC is not open to the internet. What a wallet gets is a URL scoped
 * to one address, returning only that address's data. So "connect wallet" here
 * cannot mean "point at a public endpoint" — the URL has to be issued, and only
 * to an address the identity layer recognises.
 *
 * Being refused is therefore a normal outcome, not a bug: an address without an
 * active KYC attestation is turned away at step 3. The widget says so in plain
 * words rather than showing a failed request, because that refusal IS the
 * product demo.
 *
 * No dependencies — talks to window.ethereum directly.
 */
(function () {
  const PANEL_ID = "csb-connect-panel";
  let state = { address: null, rpcPath: null, chainIdHex: null, chainId: null };

  const css = `
    .csb-connect { position: relative; display: inline-flex; align-items: center; }
    /* In-body placement (phones): a full-width button at the top of the page.
       In the header it competed with the menu button for a strip of space that
       is not wide enough for a title and two controls. */
    .csb-connect.inbody { display: block; width: 100%; margin-bottom: 2px; }
    .csb-connect.inbody button.cw {
      width: 100%; padding: 12px; font-size: 15px; border-radius: 9px;
      background: var(--blue); border-color: var(--blue); color: #fff;
    }
    .csb-connect.inbody button.cw.on { background: #fff; color: var(--blue); border-color: var(--blue); }
    .csb-connect.inbody #${PANEL_ID} { left: 0; right: 0; width: auto; }
    .csb-connect button.cw {
      margin: 0; padding: 5px 12px; border-radius: 999px; border: 1px solid rgba(255,255,255,.5);
      background: rgba(255,255,255,.12); color: #fff; font-size: 13px; font-weight: 600;
      cursor: pointer; font-family: inherit;
    }
    .csb-connect button.cw:hover { background: rgba(255,255,255,.22); }
    .csb-connect button.cw.on { background: #fff; color: var(--blue); border-color: #fff; }
    #${PANEL_ID} {
      position: absolute; right: 0; top: calc(100% + 8px); width: min(360px, 88vw);
      background: #fff; color: var(--ink); border: 1px solid var(--line); border-radius: 10px;
      box-shadow: 0 10px 30px rgba(10,20,50,.18); padding: 14px 16px; z-index: 50; display: none;
      text-align: left;
    }
    #${PANEL_ID}.open { display: block; }
    #${PANEL_ID} h4 { font-size: 13px; color: var(--blue); margin-bottom: 8px; }
    #${PANEL_ID} p { font-size: 12.5px; color: var(--muted); line-height: 1.55; margin: 6px 0; }
    #${PANEL_ID} .addr {
      font-family: ui-monospace, Menlo, monospace; font-size: 12px; word-break: break-all;
      background: #f4f6fb; border-radius: 6px; padding: 7px 9px; color: var(--ink);
    }
    #${PANEL_ID} button.act {
      margin-top: 8px; width: 100%; padding: 8px 10px; border: 0; border-radius: 7px;
      background: var(--blue); color: #fff; font-size: 13px; font-weight: 600; cursor: pointer;
      font-family: inherit;
    }
    #${PANEL_ID} button.act.ghost { background: #e8ecf7; color: var(--blue); }
    #${PANEL_ID} button.act:disabled { opacity: .55; cursor: default; }
    #${PANEL_ID} .msg { font-size: 12.5px; border-radius: 7px; padding: 8px 10px; margin-top: 8px; line-height: 1.5; }
    #${PANEL_ID} .msg.err { background: #fdecec; border: 1px solid #f5c2c2; color: #8f1d1d; }
    #${PANEL_ID} .msg.ok { background: #e6f6ec; border: 1px solid #bfe5cd; color: #14532d; }
    #${PANEL_ID} .msg.info { background: #eef2fb; border: 1px solid #d3ddf5; color: #22365e; }
  `;

  function el(tag, attrs = {}, html) {
    const n = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v));
    if (html != null) n.innerHTML = html;
    return n;
  }
  const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

  function mount() {
    const header = document.querySelector("header.site");
    const nav = header && header.querySelector("nav");
    if (!header || !nav || document.querySelector(".csb-connect")) return;
    document.head.appendChild(el("style", {}, css));

    const wrap = el("div", { class: "csb-connect" });
    const btn = el("button", { class: "cw", type: "button" }, "Connect wallet");
    const panel = el("div", { id: PANEL_ID });
    wrap.append(btn, panel);

    // Where this lives depends on the screen. On a phone the header has room for
    // a title and ONE control; competing for that strip left the menu button
    // stranded on a row of its own. So the header keeps the menu, and this moves
    // to the top of the page as a full-width button — still the first thing seen,
    // and never hidden inside the collapsed nav.
    place(wrap);
    let t;
    window.addEventListener("resize", () => {
      clearTimeout(t);
      t = setTimeout(() => place(wrap), 150);
    });

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      panel.classList.toggle("open");
      if (panel.classList.contains("open")) render(panel, btn);
    });
    // Keep clicks inside the panel away from the close-on-outside-click handler.
    // Without this the panel shuts itself the moment anything in it is used:
    // a handler that re-renders the panel detaches the very element that was
    // clicked, so by the time the document listener runs, `wrap.contains(target)`
    // is false for a node that is no longer in the document — and the click
    // reads as "outside".
    panel.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", (e) => {
      if (!wrap.contains(e.target)) panel.classList.remove("open");
    });
  }

  function place(wrap) {
    const header = document.querySelector("header.site");
    const main = document.querySelector("main");
    const inBody = window.innerWidth <= 760 && !!main;
    const target = inBody ? main : header;
    if (!target) return;
    wrap.classList.toggle("inbody", inBody);
    if (wrap.parentElement === target) return;
    if (inBody) target.insertBefore(wrap, target.firstChild);
    else target.appendChild(wrap);
  }

  function say(panel, kind, html) {
    const old = panel.querySelector(".msg");
    if (old) old.remove();
    panel.appendChild(el("div", { class: `msg ${kind}` }, html));
  }

  async function chainParams() {
    if (state.chainIdHex) return;
    try {
      const r = await fetch("/node-info");
      const d = await r.json();
      state.chainId = d.chainId;
      state.chainIdHex = d.chainIdHex ?? (d.chainId ? "0x" + d.chainId.toString(16) : null);
    } catch (_) { /* falls back below */ }
  }

  function render(panel, btn) {
    panel.innerHTML = "";
    if (!window.ethereum) {
      panel.append(
        el("h4", {}, "No wallet detected"),
        el("p", {}, "Install a browser wallet such as MetaMask, then reload this page."),
      );
      return;
    }

    if (!state.address) {
      panel.append(
        el("h4", {}, "Connect a wallet"),
        el("p", {}, "CSB is permissioned. Your address needs an active KYC attestation before "
          + "it can transact, and a wallet gets an RPC URL scoped to that one address — "
          + "the node's own endpoint is not public."),
      );
      const go = el("button", { class: "act", type: "button" }, "Connect");
      go.addEventListener("click", () => connect(panel, btn, go));
      panel.appendChild(go);
      return;
    }

    panel.append(el("h4", {}, "Wallet connected"), el("div", { class: "addr" }, state.address));

    if (!state.rpcPath) {
      panel.appendChild(el("p", {}, "Next: prove the address is yours to receive a scoped RPC URL. "
        + "Signing costs nothing and sends no transaction."));
      const sign = el("button", { class: "act", type: "button" }, "Get RPC access");
      sign.addEventListener("click", () => mintAccess(panel, btn, sign));
      panel.appendChild(sign);
    } else {
      const full = location.origin + state.rpcPath;
      panel.appendChild(el("p", {}, "Your scoped RPC URL — it returns only your own data:"));
      panel.appendChild(el("div", { class: "addr" }, full));

      const add = el("button", { class: "act", type: "button" }, "Add CSB to this wallet");
      add.addEventListener("click", () => addNetwork(panel, full, add));
      panel.appendChild(add);

      const copy = el("button", { class: "act ghost", type: "button" }, "Copy RPC URL");
      copy.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(full); copy.textContent = "Copied"; }
        catch (_) { say(panel, "info", "Copy failed — select the URL above manually."); }
      });
      panel.appendChild(copy);
    }
  }

  async function connect(panel, btn, go) {
    go.disabled = true; go.textContent = "Connecting…";
    try {
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      state.address = accounts[0];
      btn.textContent = short(state.address);
      btn.classList.add("on");
      render(panel, btn);
    } catch (e) {
      go.disabled = false; go.textContent = "Connect";
      // 4001 is the user closing the prompt; not worth an error banner.
      if (e?.code !== 4001) say(panel, "err", e?.message ?? "Could not connect.");
    }
  }

  async function mintAccess(panel, btn, sign) {
    sign.disabled = true; sign.textContent = "Waiting for signature…";
    try {
      const chal = await (await fetch("/rpc-access/challenge")).json();
      const signature = await window.ethereum.request({
        method: "personal_sign",
        params: [chal.message, state.address],
      });
      const res = await fetch("/rpc-access/mint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: state.address, message: chal.message, signature }),
      });
      const out = await res.json();
      if (!res.ok) {
        sign.disabled = false; sign.textContent = "Get RPC access";
        // A refusal here is the compliance layer working, so explain it rather
        // than presenting it as a malfunction.
        if (res.status === 403 && /KYC/i.test(out.error ?? "")) {
          say(panel, "err", "<strong>This address has no active KYC attestation.</strong><br>"
            + "That is the chain refusing an unverified address, not a fault. An address must be "
            + "registered by the Identity Authority before it can transact on CSB.");
        } else {
          say(panel, "err", out.error ?? `Request failed (${res.status}).`);
        }
        return;
      }
      state.rpcPath = out.path;
      render(panel, btn);
      say(panel, "ok", "Access granted — this URL is scoped to your address only.");
    } catch (e) {
      sign.disabled = false; sign.textContent = "Get RPC access";
      if (e?.code !== 4001) say(panel, "err", e?.message ?? "Signing failed.");
    }
  }

  async function addNetwork(panel, rpcUrl, add) {
    await chainParams();
    if (!state.chainIdHex) { say(panel, "err", "Could not read the chain ID from this node."); return; }
    add.disabled = true;
    try {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: state.chainIdHex,
          chainName: "Cambodia Sovereign Blockchain",
          nativeCurrency: { name: "Tokenized Riel", symbol: "tRIEL", decimals: 18 },
          rpcUrls: [rpcUrl],
        }],
      });
      say(panel, "ok", "Network added. Your wallet now talks to CSB through your scoped URL.");
    } catch (e) {
      if (e?.code !== 4001) {
        say(panel, "err", (e?.message ?? "Could not add the network.")
          + "<br><span style='font-size:12px'>Some wallets refuse an http:// RPC URL. "
          + "Serving this site over HTTPS fixes it — see docs/ssl.md.</span>");
      }
    } finally {
      add.disabled = false;
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
