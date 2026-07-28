/**
 * The site header: one navigation definition, rendered into every page.
 *
 * It used to be twelve links copy-pasted into thirteen HTML files. Adding a page
 * meant editing thirteen files and, in practice, missing some — several pages
 * were already carrying different link sets. Twelve flat links also gave a
 * visitor no sense of what the site is for: "Anchor" and "Verify" sat beside
 * "Admin" and "Node info" with nothing to say which of them a citizen wants.
 *
 * So the nav now lives here, grouped by what someone is trying to DO, and every
 * page gets the same one. Pages keep an empty <nav> as the mount point.
 *
 * Two behaviours worth keeping if this is ever rewritten:
 *
 *  - "Connect wallet" is never inside the collapsed mobile panel. The one action
 *    a visitor is most likely to want should not be behind a menu.
 *  - Stacked links get a ~40px tap height. The desktop styling gives about 22px,
 *    which is below what a thumb reliably hits.
 */
(function () {
  // Ordered by who needs them: a citizen's daily use first, operator tools last.
  const NAV = [
    { label: "Home", href: "index.html" },
    {
      label: "Wallet",
      items: [
        ["wallet.html", "Wallet", "Pay, swap, and see your balance"],
        ["assets.html", "Tokens & NFTs", "Everything you hold"],
        ["fund.html", "Public-good fund", "Where the fees go"],
      ],
    },
    {
      label: "Bridge",
      items: [
        ["bridge.html", "Bridge to Fuji", "Send KHRt outside the perimeter"],
      ],
    },
    {
      label: "DeFi",
      items: [
        ["defi.html", "Liquidity pool", "Unmodified Uniswap V2 on CSB"],
        ["lend.html", "Lending", "Unmodified Aave V3 — supply, borrow, repay"],
        ["wallet.html#swap", "Swap KHRt ⇄ tRIEL", "The governed converter"],
      ],
    },
    {
      label: "Use Cases",
      items: [
        ["use-cases.html", "Try a use case", "Run the demonstrations yourself"],
        ["anchor.html", "Anchor a record", "Timestamp a document hash"],
        ["verify.html", "Verify a record", "Check an anchor"],
      ],
    },
    {
      label: "Identity",
      items: [
        ["kyc-request.html", "Get verified", "Request KYC — no passcode needed"],
      ],
    },
    {
      label: "Network",
      items: [
        ["explorer.html", "Explorer", "Blocks and transactions"],
        ["validator.html", "Validators", "Who secures the chain"],
        ["node.html", "Node info", "Chain status and RPC"],
        ["rpc-access.html", "RPC access", "Your own scoped endpoint"],
      ],
    },
    { label: "Admin", href: "admin.html" },
  ];

  const page = (location.pathname.split("/").pop() || "index.html").toLowerCase();
  const isCurrent = (href) => href.split("#")[0].toLowerCase() === page;

  function render(nav) {
    nav.innerHTML = "";
    for (const entry of NAV) {
      if (entry.href) {
        const a = document.createElement("a");
        a.href = entry.href;
        a.textContent = entry.label;
        if (isCurrent(entry.href)) a.className = "active";
        nav.appendChild(a);
        continue;
      }

      const group = document.createElement("div");
      group.className = "nav-group";
      // A group counts as active when any page inside it is current, so the
      // header still says where you are once you are one level down.
      const active = entry.items.some(([href]) => isCurrent(href));

      // A <span>, not a <button>. A button's content box does not centre text
      // the way an anchor's does — measured, the group labels sat exactly 6px
      // below Home and Admin no matter how the flex alignment was expressed,
      // which is the ragged row people notice. Making the trigger the same kind
      // of element as the links makes them lay out identically by construction.
      // role/tabindex/keydown restore everything the button gave us.
      const btn = document.createElement("span");
      btn.className = "nav-group-btn" + (active ? " active" : "");
      btn.setAttribute("role", "button");
      btn.setAttribute("tabindex", "0");
      btn.setAttribute("aria-expanded", "false");
      btn.innerHTML = `<span class="lbl"></span><span class="caret" aria-hidden="true">▾</span>`;
      btn.querySelector(".lbl").textContent = entry.label;

      const panel = document.createElement("div");
      panel.className = "nav-menu";
      for (const [href, label, hint] of entry.items) {
        const a = document.createElement("a");
        a.href = href;
        if (isCurrent(href)) a.className = "active";
        a.innerHTML = `<span class="l"></span>` + (hint ? `<span class="h"></span>` : "");
        // textContent, not innerHTML, for the labels: they are ours today, but a
        // nav definition is exactly the kind of thing that later gets fed from a
        // config file.
        a.querySelector(".l").textContent = label;
        if (hint) a.querySelector(".h").textContent = hint;
        panel.appendChild(a);
      }

      btn.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); btn.click(); }
      });
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const open = group.classList.contains("open");
        // One group open at a time, or the panels overlap each other.
        nav.querySelectorAll(".nav-group.open").forEach((g) => {
          g.classList.remove("open");
          g.querySelector(".nav-group-btn").setAttribute("aria-expanded", "false");
        });
        group.classList.toggle("open", !open);
        btn.setAttribute("aria-expanded", String(!open));
      });

      group.appendChild(btn);
      group.appendChild(panel);
      nav.appendChild(group);
    }
  }

  function mount() {
    const header = document.querySelector("header.site");
    const nav = header && header.querySelector("nav");
    if (!header || !nav || header.querySelector(".nav-toggle")) return;

    render(nav);

    const btn = document.createElement("button");
    btn.className = "nav-toggle";
    btn.type = "button";
    btn.setAttribute("aria-label", "Menu");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", "csb-nav");
    btn.textContent = "☰";
    nav.id = nav.id || "csb-nav";
    header.insertBefore(btn, nav);

    const closeGroups = () => {
      nav.querySelectorAll(".nav-group.open").forEach((g) => {
        g.classList.remove("open");
        g.querySelector(".nav-group-btn").setAttribute("aria-expanded", "false");
      });
    };
    const setOpen = (open) => {
      nav.classList.toggle("open", open);
      btn.setAttribute("aria-expanded", String(open));
      btn.textContent = open ? "✕" : "☰";
      if (!open) closeGroups();
    };

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      setOpen(!nav.classList.contains("open"));
    });

    // Tapping outside, or following a link, closes it. Without the first, the
    // panel covers the page with no obvious way back.
    document.addEventListener("click", (e) => {
      if (!nav.contains(e.target) && e.target !== btn) { setOpen(false); closeGroups(); }
      else if (nav.contains(e.target) && e.target.closest("a")) setOpen(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { setOpen(false); closeGroups(); }
    });
    // Returning to a wide layout must not leave stale state behind.
    window.addEventListener("resize", () => {
      if (window.innerWidth > 760) { setOpen(false); closeGroups(); }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
