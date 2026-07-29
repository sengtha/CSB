# Posters — CSB in one landscape image

Two versions, both 1920×1080.

- **`csb-diagram.html`** — the one to post. A picture: people → their own private
  door → the ledger → one guarded exit, then icon cards for why it fits and what
  it is ready for. Roughly 90 words in total, nothing smaller than 17px, because
  most people will see it on a phone at a third of this size.
- **`csb-architecture.html`** — the wordy version. Keeps the full reasoning and
  the honest caveats in prose. Better as a linked image or a slide than as a
  feed post; on a phone the body text is unreadable.

If you are choosing: post the diagram. Text that cannot be read at thumbnail
size is not communication, it is decoration.

It is a plain self-contained HTML file, so it is edited like any page and
re-rendered with a headless browser:

```bash
npx playwright screenshot \
  --viewport-size=1920,1080 \
  docs/poster/csb-architecture.html csb-architecture.png
```

Any headless-Chromium screenshot tool works; the page is exactly 1920×1080 with
`overflow: hidden`, so anything that does not fit is CLIPPED rather than
scrolled. After editing, check `document.body.scrollHeight === 1080` before
trusting the output — a poster that silently lost its last bullet looks fine
until someone reads it.

Render at a device scale factor of 2 for a crisp 3840×2160 file; social
platforms downscale it themselves.

## Keep it honest

The disclaimers in the header and footer are not decoration. This is a personal
prototype, the institutions are placeholders, and the quantum section says
"readiness, not proof" because that is the truth — post-quantum signatures are
not deployed here or anywhere else yet. Do not quietly drop those lines to make
the image cleaner.

The same applies to the "not yet in the deployment" qualifiers added to the
multisig, split-powers, recovery and account-abstraction bullets. They are there
because the poster previously asserted, in the present tense, four things this
deployment does not do: multisig-held roles (one deployer key holds every role),
separated powers in practice (same), general key recovery (land titles only),
and account abstraction (none). A poster is read faster and trusted more than a
document, so it is the worst place to overstate. Current state:
`docs/deployment-status.md`.
