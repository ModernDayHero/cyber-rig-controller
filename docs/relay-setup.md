# Guest relay: self-hosted ntfy on the NAS

The Cyber Deck's guest mode needs a relay: a small server that passes messages between
guests' phones and your phone. Everything works with the public **ntfy.sh**, but its free
tier stops after a daily message quota. On 2026-10-30, one day of testing was enough to
get `429 daily message quota reached`. A party uses far more: invites, operator turns,
live DEBUG hits, BOLT driving. So run your own **ntfy** server on the NAS and reach it
through the Cloudflare tunnel you already have.

Nothing in the app changes except one setting: **SET → GUESTS → RELAY**.

---

## What the app needs from the relay

| Need | Why |
|---|---|
| `POST https://<relay>/<topic>` with a text body | guests and your phone publish small JSON messages |
| `GET https://<relay>/<t1>,<t2>/sse` (Server-Sent Events) | your phone and each guest listen live |
| CORS open to the web app's origin | the app runs on GitHub Pages, the relay is another domain |
| HTTPS | the app is HTTPS; browsers block plain-HTTP calls from it |
| No login | guests are anonymous web pages; security is the one-time password, checked by your phone |
| Generous rate limits | many messages per minute during a party, often from the same venue IP |

ntfy does all of this out of the box. Its web endpoints allow cross-origin requests.

Topic names the app uses (all start with `cd`, a random 20-character id):

- `cd<id>`: guests → your phone
- `cd<id>-<guest>`: your phone → one guest
- `cd<id>-all`: your phone → every guest (firewall / hacked / driving news)

That `cd` prefix lets the server allow anonymous access to the rig's topics only (step 3).

---

## 1. Run ntfy in Docker on the NAS

Make a folder on the NAS, e.g. `/volume1/docker/ntfy`, with this `docker-compose.yml`:

```yaml
services:
  ntfy:
    image: binwiederhier/ntfy:latest
    container_name: ntfy
    command: serve
    environment:
      - TZ=Asia/Taipei            # your timezone
    volumes:
      - ./etc:/etc/ntfy           # server.yml goes here
      - ./cache:/var/cache/ntfy   # message cache + attachments
      - ./lib:/var/lib/ntfy       # user / access database
    ports:
      - "8095:80"                 # NAS port 8095 -> ntfy; pick any free port
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "wget -q --tries=1 http://localhost:80/v1/health -O - | grep -Eo '\"healthy\"\\s*:\\s*true' || exit 1"]
      interval: 60s
      timeout: 10s
      retries: 3
```

Pin a version tag instead of `latest` once it works, so an update can't change it the
week of the party.

## 2. `etc/server.yml`

```yaml
# Public address of the relay (the Cloudflare hostname from step 4)
base-url: "https://relay.example.com"
listen-http: ":80"

# Cloudflare tunnel is in front: trust its forwarded-for header for visitor IPs
behind-proxy: true

# Keep messages briefly so a phone that blinks offline catches up
cache-file: "/var/cache/ntfy/cache.db"
cache-duration: "12h"

# Access control: nothing open by default; the rig's topics opened in step 3
auth-file: "/var/lib/ntfy/user.db"
auth-default-access: "deny-all"

# For the coming photo pipeline (guest selfies, portraits)
attachment-cache-dir: "/var/cache/ntfy/attachments"
attachment-total-size-limit: "2G"
attachment-file-size-limit: "15M"
attachment-expiry-duration: "3h"

# Party-sized limits. Everyone at the venue may share one public IP, so the
# per-visitor defaults (made for a public service) are far too tight here.
visitor-request-limit-burst: 1000
visitor-request-limit-replenish: "100ms"
visitor-message-daily-limit: 0          # 0 = no daily cap
visitor-subscription-limit: 200
visitor-attachment-total-size-limit: "500M"

# SSE keepalive well under Cloudflare's idle timeout (~100 s)
keepalive-interval: "30s"

enable-signup: false
enable-login: false
```

These option names are from memory of ntfy's config reference. Check each one against
the "Config options" table in the ntfy docs for the version you install, since a few
limits have been renamed over time. If one isn't recognised, ntfy refuses to start and
names it, so you'll know.

Start it:

```sh
cd /volume1/docker/ntfy
docker compose up -d
docker logs ntfy            # should end with "Listening on :80"
```

## 3. Open just the rig's topics to anonymous users

```sh
docker exec -it ntfy ntfy access everyone 'cd*' rw
docker exec -it ntfy ntfy access            # lists rules; expect: everyone  cd*  read-write
```

Everything else stays `deny-all`, so nobody can use your relay as a free public ntfy.

## 4. Cloudflare tunnel: a public hostname

In the Cloudflare dashboard: **Zero Trust → Networks → Tunnels → (your NAS tunnel) →
Public Hostname → Add**:

| Field | Value |
|---|---|
| Subdomain | `relay` |
| Domain | the domain your tunnel already uses (e.g. `steamworkz.net` once it's live) |
| Service | `HTTP` → `<NAS LAN IP>:8095` |

Leave **Cloudflare Access off** for this hostname. Guests' browsers can't log in to it,
and the app's own one-time passwords are the gate. If you like, add a Cloudflare WAF rate
rule later as a backstop (e.g. 600 requests/minute per IP on `relay.*`).

Then put the same hostname in `base-url` (step 2) and `docker compose restart`.

## 5. Test it

From any computer:

```sh
# publish
curl -d "hello" https://relay.example.com/cdtest
# read back what's cached
curl -s "https://relay.example.com/cdtest/json?poll=1"
# a topic that isn't the rig's must be refused (403)
curl -s -o /dev/null -w "%{http_code}\n" -d "nope" https://relay.example.com/other
```

Live stream (leave it running, publish from another window, the line appears at once):

```sh
curl -sN https://relay.example.com/cdtest/sse
```

If the stream arrives only in bursts or after a delay, something is buffering. Check that
nothing else (another reverse proxy on the NAS) sits between cloudflared and ntfy.

## 6. Point the app at it

1. Open the live Cyber Deck on your phone: **SET → GUESTS → RELAY** →
   `https://relay.example.com` and confirm. This disconnects any guests, and the guest QR
   code changes.
2. **Re-save the badge screens** (BADGE tab → LOGIN QR → SAVE AS LOGIN SCREEN, then CARD →
   SAVE AS CARD), since both QR codes now include the new relay.
3. Flip GUESTS on, INVITE, scan from a phone on **mobile data** (a real outside network),
   join, play DEBUG, try a pattern as operator. Watch `docker logs -f ntfy` while you do.

Guest links for your own relay look like `…/guest.html#cd<id>@relay.example.com`. The part
after `@` tells the guest page which relay to use.

## 7. Party checklist

- [ ] NAS and tunnel up; `curl` test passes from outside your home network
- [ ] `docker logs ntfy` shows no rate-limit warnings during a 10-minute rehearsal with
      2–3 phones (turns, DEBUG, driving)
- [ ] Badge LOGIN QR and CARD re-saved from the live app after switching relay
- [ ] Your home internet and NAS stay on all night. The relay lives at home; if it goes
      down, guests can't reach you, but the rig itself keeps working from your phone.
- [ ] Fallback: SET → GUESTS → RELAY back to `https://ntfy.sh` (works until its quota runs
      out, and on a different IP than the one used for testing)

---

## Testing without any relay limits

`tools/mock-relay.mjs` is a tiny stand-in that speaks the same protocol on your PC:

```sh
node tools/mock-relay.mjs        # listens on http://localhost:8099
```

The app's RELAY setting only accepts `https://`, so it's for scripted tests: set
`host.relay = 'http://localhost:8099'` in the test, and publish / subscribe to
`http://localhost:8099/...`. It keeps nothing and has no limits or access control. It's
not for the party.
