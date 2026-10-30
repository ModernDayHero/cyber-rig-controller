// Guest relay for the Cyber Deck: a tiny ntfy-compatible server on Cloudflare (a Worker +
// one Durable Object per guest session), so nothing at home has to be reachable. It
// speaks the same protocol the app uses with ntfy (src/guests.js, src/guest.js):
//   POST /<topic>          body = the message (text, at most 8 KB)
//   GET  /<t1>,<t2>/sse    Server-Sent Events: an "open" event, then each message as
//                          data: {"id","time","event":"message","topic","message"}
// Only the rig's topics, and one session per request:
//   cd<20>                 guests -> the owner's phone
//   cd<20>-<16>            the owner's phone -> one guest
//   cd<20>-all             the owner's phone -> every guest
// Nothing is stored: a message goes to whoever is listening right then, like ntfy without
// its cache. The one-time passwords and tokens are checked by the owner's phone, not here.

const TOPIC = /^(cd[a-z0-9]{20})(?:-(?:[a-z0-9]{16}|all))?$/;
const MAX_BODY = 8192;
const KEEPALIVE_MS = 25000;          // well under Cloudflare's idle timeout for a stream
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};
const enc = new TextEncoder();

/** "/cdabc,cdabc-all/sse" -> { topics, sse } (or null if it isn't one of ours). */
function route(req) {
  const parts = new URL(req.url).pathname.slice(1).split('/');
  const sse = req.method === 'GET' && parts.length === 2 && parts[1] === 'sse';
  const pub = req.method === 'POST' && parts.length === 1;
  if (!sse && !pub) return null;
  const topics = decodeURIComponent(parts[0]).split(',');
  if (topics.length > (sse ? 3 : 1)) return null;
  const sessions = new Set(topics.map((t) => TOPIC.exec(t)?.[1]));
  if (sessions.has(undefined) || sessions.size !== 1) return null;
  return { topics, sse, session: [...sessions][0] };
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (new URL(req.url).pathname === '/') return new Response('cyber rig relay\n', { headers: CORS });
    const r = route(req);
    if (!r) return new Response('not a rig topic\n', { status: 403, headers: CORS });
    // Every topic of a session lives in the same Durable Object, so they meet there.
    return env.SESSIONS.get(env.SESSIONS.idFromName(r.session)).fetch(req);
  },
};

export class Session {
  constructor() {
    this.subs = new Map();           // topic -> Set of stream writers
    this.n = 0;
  }

  async fetch(req) {
    const r = route(req);
    if (!r) return new Response('not a rig topic\n', { status: 403, headers: CORS });
    if (r.sse) return this.subscribe(r.topics);
    const body = await req.text();
    if (body.length > MAX_BODY) return new Response('too big\n', { status: 413, headers: CORS });
    const topic = r.topics[0];
    const msg = { id: `${Date.now().toString(36)}${(++this.n).toString(36)}`, time: Math.floor(Date.now() / 1000),
      event: 'message', topic, message: body };
    const line = enc.encode(`data: ${JSON.stringify(msg)}\n\n`);
    for (const w of [...(this.subs.get(topic) || [])]) w.write(line).catch(() => w.drop());
    return Response.json(msg, { headers: CORS });
  }

  subscribe(topics) {
    const { readable, writable } = new TransformStream();
    const w = writable.getWriter();
    const keepalive = setInterval(() => {
      w.write(enc.encode('event: keepalive\ndata: {"event":"keepalive"}\n\n')).catch(() => w.drop());
    }, KEEPALIVE_MS);
    // A listener that went away shows up as a failed write (a message or the keepalive).
    w.drop = () => {
      clearInterval(keepalive);
      for (const t of topics) {
        const set = this.subs.get(t);
        set?.delete(w);
        if (set && !set.size) this.subs.delete(t);
      }
      w.close().catch(() => {});
    };
    for (const t of topics) {
      if (!this.subs.has(t)) this.subs.set(t, new Set());
      this.subs.get(t).add(w);
    }
    w.write(enc.encode('event: open\ndata: {"event":"open"}\n\n')).catch(() => w.drop());
    return new Response(readable, {
      headers: { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform' },
    });
  }
}
