# How the Cyber Deck is hosted

Everything that faces the internet runs on Cloudflare, from this PC. Nothing at home is
exposed, and nothing needs to stay on at home.

| Address | What | Cloudflare Worker (config) |
|---|---|---|
| `https://deck.steamworkz.net` | the owner's Cyber Deck (behind a Cloudflare Access login) | `cyber-deck` (`wrangler.jsonc`) |
| `https://jack.steamworkz.net` | the same site for guests: only `guest.html`, its files and the game (`worker/site.js`) | `cyber-deck` |
| `https://relay.steamworkz.net` | the guest relay (`worker/relay`) | `cyber-rig-relay` |

There's no `workers.dev` address (turned off, so there's no way around the login).

## Day to day

```sh
npm run dev       # test on this PC: http://localhost:5173/ (phones: the Wi-Fi address it prints)
npm run deploy    # build, then deploy the site and the relay
```

`npm run deploy` needs `npx wrangler login` once on the PC. Test locally first; deploy
when it's right. While the deck runs on localhost, its guest links and QRs use the PC's
Wi-Fi address, so a phone on the same Wi-Fi can be a guest.

## The relay

A Worker plus one Durable Object per guest session. It passes messages between guests'
phones and the deck and stores nothing:

| Request | Meaning |
|---|---|
| `POST /<topic>` (text, at most 8 KB) | publish to everyone listening on that topic |
| `GET /<t1>,<t2>/sse` | listen (Server-Sent Events): an `open` event, then each message as `data: {"id","time","event":"message","topic","message"}`, a keepalive every 25 s |

Only the rig's topics are accepted: `cd` + 20 letters / digits (guests → deck), `-<16>`
(deck → one guest) or `-all` (deck → every guest), one session per request; anything else
gets `403`, too big `413`. Access codes and tokens are checked by the deck on the owner's
phone, never by the relay. `npx wrangler tail cyber-rig-relay` shows live traffic.
`tools/mock-relay.mjs` is a stand-in for scripted tests on the PC.

## The login (Cloudflare Access)

`deck.steamworkz.net` only: Zero Trust → Access → Applications → Self-hosted, domain
`deck.steamworkz.net`, session 1 month, login method One-time PIN, policy Allow → your
email. Leave `jack.` and `relay.` without it: guests can't log in.

## Cost

Both Workers fit the free plan for a party (check the current Workers / Durable Objects
limits). If it's ever outgrown, Workers Paid is $5 a month. Usage: Workers & Pages → the
Worker → Metrics.

## After changing hosting

Anything with a QR in it carries the guest site's address: re-save the badge's HOME and
SCORES screens from the deck.

## The afterparty deck: ap.steamworkz.net

A second, separate site: the deck plus the private plugins (`src/private/`), with guests
switched off. It has its own Worker (`cyber-deck-ap`, `wrangler.ap.jsonc`) and its own
Cloudflare Access app (owner + MFA), so the public deck never contains the private code.

    npm run build:ap      # dist-ap/ (check locally: npm run preview:ap)
    npm run deploy:ap     # builds, then deploys ap. only

The first deploy creates the `ap.` DNS record (a Worker custom domain). Make the Access
app for `ap.steamworkz.net` first, so it's never reachable without the login. It installs
on a phone as its own app ("Deck AP"); its settings are separate from the deck's.
