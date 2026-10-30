// The site Worker (wrangler.jsonc): serves dist/, but on jack.steamworkz.net, the guests'
// address with no login, only what the guest page needs. The owner's deck lives on
// deck.steamworkz.net behind Cloudflare Access, so it mustn't be reachable around it.

const GUEST_HOSTS = new Set(['jack.steamworkz.net']);
// What a guest's phone loads: the page, its code + styles, the game, icons.
const GUEST_OK = /^\/(guest\.html|assets\/.+|viz\/byte-vs-bug\.html|icons\/.+|octlet\.svg|favicon\.ico)$/;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (GUEST_HOSTS.has(url.hostname)) {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return Response.redirect(`${url.origin}/guest.html${url.search}`, 302);   // keeps the #… too
      }
      if (!GUEST_OK.test(url.pathname)) return new Response('Not found', { status: 404 });
    }
    return env.ASSETS.fetch(req);
  },
};
