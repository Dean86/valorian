# @valorian/ppc-adapter — Valorian as a Cloudflare Pay Per Crawl pricing Worker

Cloudflare Pay Per Crawl runs the whole crawler-payment flow (the 402, crawler
auth, settlement). With **dynamic pricing** on, it lets *your* Worker set the
price per request via a `crawler-price` response header. Cloudflare's own example
is two lines that hardcode a price by URL path.

This is the real version: it loads the pricing plan you published from the
Valorian console and prices each request with the **same `rate()` engine** the
x402 gateway uses, by crawler class, content zone, and freshness. Same brain,
same plan; Cloudflare settles instead of x402.

## How it fits

```
console (UI) --publishes--> plan (KV) --read by--> both modes:
                                        |- packages/worker      (x402 gateway, settles on-chain)
                                        `- packages/ppc-adapter  (this: Cloudflare sets crawler-price)
```

Set your rates once in the console. Both modes rate under the same plan; only the
"apply price" step differs.

## Deploy

1. `npx wrangler deploy`
2. Bind the same `PLANS` KV namespace your console writes to (see `wrangler.toml`).
3. Run this Worker on your zone and enable Pay Per Crawl **dynamic (in-band)** pricing.
4. Each crawler request now carries a `crawler-price` set by Valorian. The
   `X-Rating-Trace` header shows the class, zone, and price decision.

## Notes

- Per-buyer volume/spend tiers need request counters Cloudflare doesn't expose in
  the pricing hook, so this v1 rates on class, zone, and freshness. `contentAgeDays`
  can be derived from `Last-Modified` or an origin header.
- The full engine, console, offers, and versioning live in the rest of this repo.

MIT.
