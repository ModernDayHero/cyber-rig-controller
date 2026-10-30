// A tiny ntfy-compatible relay for local tests: POST /<topic> (body = message),
// GET /<t1>,<t2>/sse (an "open" event, then message events). No limits, memory only.
//   node tools/mock-relay.mjs          (PORT=8099 by default)
// The deck's RELAY setting only takes https://, so point tests at it in code
// (host.relay = 'http://localhost:8099'), not through the app. See docs/relay-setup.md.
import { createServer } from 'node:http';

const subs = new Map();                 // topic -> Set(res)
let n = 0;
const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.end();
  const path = decodeURIComponent(req.url.split('?')[0]);
  const sse = path.match(/^\/([^/]+)\/sse$/);
  if (req.method === 'GET' && sse) {
    const topics = sse[1].split(',');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(`event: open\ndata: {"event":"open"}\n\n`);
    for (const t of topics) { if (!subs.has(t)) subs.set(t, new Set()); subs.get(t).add(res); }
    req.on('close', () => topics.forEach((t) => subs.get(t)?.delete(res)));
    return;
  }
  const pub = path.match(/^\/([-\w]+)$/);
  if (req.method === 'POST' && pub) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = { id: String(++n), time: Date.now() / 1000 | 0, event: 'message', topic: pub[1], message: body };
      for (const r of subs.get(pub[1]) || []) r.write(`data: ${JSON.stringify(msg)}\n\n`);
      res.end(JSON.stringify(msg));
    });
    return;
  }
  res.statusCode = 404;
  res.end();
});
server.listen(Number(process.env.PORT || 8099), () => console.log('mock relay on', server.address().port));
