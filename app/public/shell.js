/**
 * Responsive header — collapses the navigation behind a menu button on phones.
 *
 * Eight links do not fit on a 390px screen. Left as a wrapping flex row they
 * became two cramped lines of small tap targets, which is worse than a menu:
 * hard to hit accurately, and it pushes the actual page content down.
 *
 * Two details that matter more than they look:
 *
 *  - "Connect wallet" stays OUTSIDE the collapsed panel, so the one action a
 *    visitor is most likely to want is never hidden behind a menu.
 *  - Links get a ~40px tap height when stacked. The desktop styling gives them
 *    about 22px, which is below what a thumb reliably hits.
 */
(function () {
  function mount() {
    const header = document.querySelector("header.site");
    const nav = header && header.querySelector("nav");
    if (!header || !nav || header.querySelector(".nav-toggle")) return;

    const btn = document.createElement("button");
    btn.className = "nav-toggle";
    btn.type = "button";
    btn.setAttribute("aria-label", "Menu");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", "csb-nav");
    btn.textContent = "☰";
    nav.id = nav.id || "csb-nav";
    header.insertBefore(btn, nav);

    const setOpen = (open) => {
      nav.classList.toggle("open", open);
      btn.setAttribute("aria-expanded", String(open));
      btn.textContent = open ? "✕" : "☰";
    };

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      setOpen(!nav.classList.contains("open"));
    });

    // Tapping outside, or following a link, closes it. Without the first, the
    // panel covers the page with no obvious way back.
    document.addEventListener("click", (e) => {
      if (!nav.contains(e.target) && e.target !== btn) setOpen(false);
    });
    nav.addEventListener("click", (e) => {
      if (e.target.tagName === "A") setOpen(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") setOpen(false);
    });
    // Returning to a wide layout must not leave stale state behind.
    window.addEventListener("resize", () => {
      if (window.innerWidth > 760) setOpen(false);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
