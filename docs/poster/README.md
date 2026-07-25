# Poster — CSB architecture, one landscape image

`csb-architecture.html` renders to a 1920×1080 image for sharing: the
architecture, why the shape may suit Cambodia, and how it prepares for
AI-driven attack and quantum computers.

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
