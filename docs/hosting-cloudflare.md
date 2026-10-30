# Private repo, site on Cloudflare

## Current setup (live since 2026-10-30)

| Address | What | Cloudflare Worker |
|---|---|---|
| `https://deck.steamworkz.net` | the Cyber Deck + guest page + viz (static files, `public/_headers`) | `cyber-deck` (`wrangler.jsonc`) |
| `https://relay.steamworkz.net` | the guest relay | `cyber-rig-relay` (`worker/relay`) |

**Deploying an update** (both, from this repo, after `npx wrangler login` once on that PC):

```sh
npm run deploy      # builds for the domain root, then deploys the site and the relay
```

The sections below were the original plan (Cloudflare *Pages* via its Git integration).
The site went up as a plain Worker deployed from the PC instead, which is simpler; step 3
(make the repo private) and step 4 still apply. If you started a Pages / Git project in
the dashboard while trying, it can be deleted (Workers & Pages → that project → Settings
→ Delete).

---

Goal: the **code is private** (GitHub), the **site stays public** (Cloudflare Pages), and
everything that serves guests lives on your Cloudflare account: the site and the guest
relay (`docs/relay-worker.md`).

A free GitHub account can't serve GitHub Pages from a private repo, so the site moves to
Cloudflare Pages first, **then** the repo goes private. In that order, the live site is
never down.

Already done in the repo:

- the build works at a domain's root (`BASE=/`), which Cloudflare Pages needs;
- `public/_headers` adds basic security headers on Cloudflare (no MIME sniffing, no
  framing by other sites, a strict referrer, and permissions limited to Bluetooth,
  camera and motion for this site);
- the GitHub Pages workflow skips itself once the repo is private, so no failing runs;
- the badge CARD's second QR is a **LINK QR** for your site or socials, set in
  SET → BADGE, instead of pointing at the repo;
- Issues, Wiki and Projects are off; the editor workspace file and stray Python bytecode
  aren't tracked any more;
- audit: no secrets (keys, tokens, Wi-Fi passwords, `settings.toml`) anywhere in the repo
  or its history.

---

## 1. Create the Cloudflare Pages project (repo still public)

Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**:

1. Connect GitHub and grant access to **only** `ModernDayHero/cyber-rig-controller`
   ("Only select repositories"). Cloudflare keeps that access after the repo goes private.
2. Project name: e.g. `cyber-deck` (gives `https://cyber-deck.pages.dev`).
3. Build settings:

   | Setting | Value |
   |---|---|
   | Framework preset | None |
   | Build command | `npm run build` |
   | Build output directory | `dist` |
   | Root directory | *(empty)* |
   | Environment variables | `BASE` = `/` and `NODE_VERSION` = `22` |

4. **Save and Deploy.** Every push to `main` now deploys there too.

Optional, once `steamworkz.net` is on Cloudflare: Pages project → **Custom domains** →
add `steamworkz.net` (or `deck.steamworkz.net`). Do this before step 2 if you can, so the
address you put on the badge is the one you'll keep.

## 2. Move the phone and the badge to the new address

The app's settings live per address, so on the new site:

1. Open `https://cyber-deck.pages.dev` (or your domain) on your phone and **Add to Home
   screen** (the PWA). Remove the old github.io one afterwards.
2. Re-connect the CLUE, hat, BOLT and badge (Chrome asks once per site).
3. Re-do the settings that matter: pattern colours (SET → PATTERNS), callsign + LINK QR
   (BADGE / SET → BADGE), **SET → GUESTS → RELAY** (your Worker, `docs/relay-worker.md`).
4. Re-save the badge screens: **LOGIN QR, CARD, SCORES**. Their QR codes contain the
   site address.
5. Quick rehearsal: GUESTS on → INVITE → a phone on mobile data scans the badge.

## 3. Make the repo private

```sh
gh repo edit ModernDayHero/cyber-rig-controller --visibility private --accept-visibility-change-consequences
```

(or GitHub → repo → Settings → General → Danger Zone → Change visibility). Then:

- GitHub → Settings → **Pages**: if it still shows a site, choose **Unpublish**. The old
  `moderndayhero.github.io/cyber-rig-controller` address stops working; anything still
  pointing there (an old badge QR) must be re-saved from the new site.
- Check Cloudflare still builds: push any small change, or Pages → Deployments → Retry.

## 4. A few more locks (optional, all free)

- **GitHub → Settings → Code security**: turn on Dependabot alerts (and secret scanning if
  offered for your plan).
- **Branch protection** on `main` isn't needed for a solo repo, but turn on "Require
  signed commits" or 2FA on your GitHub account if it isn't already.
- **Cloudflare → your Pages project → Settings → Access policy**: leave it **off**. Guests
  must reach the site without logging in. Lock the owner's controls with the in-app
  costume-mode lock instead (planned).
- Keep `worker/relay` and future Workers (AI portraits) on the same Cloudflare account. Any
  API keys go in Worker secrets (`npx wrangler secret put …`), never in the repo.

## What's public afterwards

| Thing | Where | Public? |
|---|---|---|
| Source code, firmware, docs | GitHub, private repo | no |
| The site (deck + guest page + viz) | Cloudflare Pages | yes: it has to be, for guests. Its JavaScript is visible to anyone who opens it, as with any website. |
| Guest relay | Cloudflare Worker | yes (it's how guests reach you); only accepts the rig's own topics, stores nothing |
| Your settings, runners log, tunes | your phone's browser storage | no |
