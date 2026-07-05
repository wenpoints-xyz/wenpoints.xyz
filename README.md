# wenpoints.xyz

$HELIXPOINT — THE POINTS TOKEN. Served in authentic 1997 Geocities style.

Live at [wenpoints.xyz](https://wenpoints.xyz).

## How it works

- Static site in [`site/`](site/), no build step, no dependencies. Notepad.exe energy.
- **Small changes**: commit to `main` — the deploy workflow publishes straight to wenpoints.xyz (~1 min).
- **Large changes**: open a PR — a live preview link (raw.githack.com, served from the PR branch) is commented on the PR automatically.

Hosting: GitHub Pages via **GitHub Actions** (`actions/deploy-pages`, not deploy-from-branch — avoids the slow legacy build). DNS: Cloudflare.
