/**
 * A pricing Worker for Cloudflare Pay Per Crawl.
 *
 * Cloudflare Pay Per Crawl gives you a hook for dynamic pricing. When in-band
 * pricing is enabled, Cloudflare adds a `cf-pay-per-crawl` header to origin
 * requests, and whatever you put in a `crawler-price` response header is what the
 * crawler is charged for that request.
 *
 * Cloudflare's own example is two lines that hardcode a price by URL path. This
 * is the real version: it prices each request by WHO is asking (crawler class)
 * and WHAT they touch (content zone), and it extends cleanly to freshness,
 * volume, and value. That is the differentiated rating Cloudflare leaves to you.
 *
 * The ruleset below is deliberately tiny and readable. The full engine (named
 * rulesets, freshness bands, volume tiers, value-based rules, versioning, and a
 * console) lives in this repo under packages/.
 */

// 1. Who is asking: user-agent -> crawler class.
function classify(ua) {
  ua = (ua || "").toLowerCase();
  if (/googlebot|bingbot|applebot|duckduckbot/.test(ua)) return "search";   // indexers
  if (/gptbot|claudebot|bytespider|ccbot|perplexitybot|google-extended/.test(ua)) return "frontier"; // model builders
  return "unknown";
}

// 2. What they touch: path -> content zone.
function zoneOf(pathname) {
  if (/^\/(premium|research|data|api)\//.test(pathname)) return "premium";
  if (/^\/(blog|docs|articles|news)\//.test(pathname)) return "standard";
  return "meta"; // home, nav, misc
}

// 3. The tariff: first matching rule wins (a telco-style charge selector).
//    price is USD per request; null means "use the zone default price".
const TARIFF = [
  { when: { cls: "search" },                     price: 0.0000 }, // let search index for free
  { when: { cls: "frontier", zone: "premium" },  price: 0.0500 }, // your best data, to model builders
  { when: { cls: "frontier", zone: "standard" }, price: 0.0200 },
  { when: { zone: "premium" },                   price: 0.0300 },
  { when: { zone: "meta" },                      price: 0.0000 }, // don't charge for nav
  { when: {},                                    price: 0.0100 }, // default
];

function priceFor(cls, zone) {
  for (const rule of TARIFF) {
    const w = rule.when;
    if ((!w.cls || w.cls === cls) && (!w.zone || w.zone === zone)) return rule.price;
  }
  return null;
}

export default {
  async fetch(request) {
    // Fetch the content first, and let Cloudflare cache it.
    let response = await fetch(request, { cf: { cacheEverything: true } });

    // Only price when Cloudflare has in-band (dynamic) pricing enabled.
    const mode = request.headers.get("CF-Pay-Per-Crawl") || "";
    if (!/\bpricing=in-band\b/.test(mode)) return response;

    const cls = classify(request.headers.get("user-agent"));
    const zone = zoneOf(new URL(request.url).pathname);
    const price = priceFor(cls, zone);

    if (price !== null) {
      response = new Response(response.body, response); // make headers mutable
      response.headers.set("Crawler-Price", `USD ${price.toFixed(4)}`);
      response.headers.set("X-Rating-Trace", `${cls} · ${zone} · $${price.toFixed(4)}`);
    }
    return response;
  },
};
