# Guest relay on Cloudflare Workers (recommended)

Guest mode needs a relay between guests' phones and yours. The free public **ntfy.sh** ran
out of daily messages after one day of testing (`429 daily message quota reached`), so
the party needs its own. This one runs **entirely on Cloudflare**:

- nothing to carry or keep awake;
- nothing at home exposed (no tunnel into the NAS);
- always on, HTTPS, a fixed address;
- the same place the AI-portrait Worker will live later.

It's `worker/relay/`: one Worker plus a Durable Object per guest session (~100 lines). It
speaks the same protocol the app already uses with ntfy, so the app doesn't change, only
**SET → GUESTS → RELAY**. (Self-hosting ntfy instead: `docs/relay-setup.md`.)

---

## What it does

| Request | Meaning |
|---|---|
| `POST /<topic>` (text body ≤ 8 KB) | publish a message to everyone listening on that topic |
| `GET /<t1>,<t2>/sse` | listen (Server-Sent Events): an `open` event, then each message as `data: {"id","time","event":"message","topic","message"}`; a keepalive every 25 s |

It only accepts the rig's topics: `cd` + 20 letters/digits, optionally `-<16>` (one
guest) or `-all`, and every topic in one request must belong to the same session.
Anything else gets `403`, and oversized messages get `413`. It stores nothing: a message
goes to whoever is listening at that moment. Passwords and tokens are checked by your
phone, never by the relay.

Tested locally (`wrangler dev`) with the app's real guest code: invites, operator turns,
permissions, live DEBUG, pictures and the runners log all work through it.

---

## Deploy (about 10 minutes)

Needs Node.js 18+ and your Cloudflare account.

```sh
cd worker/relay
npm install
npx wrangler login          # opens a browser: allow Wrangler on your Cloudflare account
npx wrangler deploy
```

`deploy` prints the address, e.g.

```
https://cyber-rig-relay.<your-subdomain>.workers.dev
```

If it asks you to choose a `workers.dev` subdomain first (new accounts), pick one in the
dashboard (**Workers & Pages → Overview**) and run `deploy` again.

### Optional: your own hostname

Once `steamworkz.net` (or another domain) is on Cloudflare: **Workers & Pages →
cyber-rig-relay → Settings → Domains & Routes → Add → Custom domain** →
`relay.steamworkz.net`. Use that address in the app instead. It never changes, even if
you redeploy.

## Test it

```sh
R=https://cyber-rig-relay.<your-subdomain>.workers.dev
curl $R/                                                   # "cyber rig relay"
curl -s -o /dev/null -w "%{http_code}\n" -d hi $R/hello      # 403: not a rig topic
curl -sN $R/cdtesttesttesttesttest/sse &                   # listen...
curl -d '{"t":"ping"}' $R/cdtesttesttesttesttest            # ...and the listener prints it
```

`npx wrangler tail` (in `worker/relay`) shows live requests and errors while you test.

## Point the app at it

1. In the live Cyber Deck on your phone: **SET → GUESTS → RELAY** → paste the Worker's
   `https://…` address → confirm. This sends any guests home, and the guest QR code changes.
2. **Re-save the badge screens**: BADGE tab → LOGIN QR → **SAVE AS LOGIN SCREEN**, CARD →
   **SAVE AS CARD**, SCORES → **SAVE AS SCORES**. All three QR codes include the relay.
3. Rehearse: GUESTS on → INVITE → a phone **on mobile data** scans the badge, joins, plays
   DEBUG, takes a turn as operator. Watch `npx wrangler tail` meanwhile.

Guest links for this relay look like `…/guest.html#cd<id>@cyber-rig-relay.<sub>.workers.dev`.
The part after `@` tells the guest page which relay to use.

---

## Cost and limits

Workers' **Free plan** should cover a party comfortably, but check the current numbers
(Cloudflare changes them) on the Workers and Durable Objects pricing pages:

- **Requests:** every message is one request. A busy party might reach a few thousand
  per hour; the free daily request allowance is far above that.
- **Durable Object time:** the session's object counts as active while phones are
  listening. One session open for a 6-hour party is well inside what I understand the free
  daily duration allowance to be. Turn GUESTS off when the night's over.
- If you ever exceed the free plan, Workers Paid is $5/month and lifts all of this.

Watch usage under **Workers & Pages → cyber-rig-relay → Metrics** after the rehearsal.

## Notes

- **Messages aren't kept.** ntfy.sh kept a short cache; this relay doesn't. The app
  doesn't rely on it: guests who reconnect re-announce themselves and your phone answers.
- **Updating:** edit `worker/relay/src/index.js`, then `npx wrangler deploy` again; the
  address stays the same.
- **Local testing:** `npm run dev` in `worker/relay` runs it on `http://localhost:8787`
  (Cloudflare's own runtime). The app's RELAY setting only takes `https://`, so local runs
  are for scripted tests (see `tools/mock-relay.mjs` for the same idea without Wrangler).
- **Falling back:** SET → GUESTS → RELAY back to `https://ntfy.sh` works until its daily
  quota runs out.
