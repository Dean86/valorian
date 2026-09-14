/**
 * Valorian — Cloudflare Pay Per Crawl pricing adapter.
 *
 * Cloudflare's dynamic pricing lets a Worker set the price per request via a
 * `crawler-price` response header (Cloudflare's own example hardcodes a price by
 * URL path). This plugs the real Valorian rating engine into that hook: it loads
 * the pricing plan you published from the console, and prices each crawler
 * request by class, zone, and freshness — the SAME engine and the SAME plan the
 * x402 gateway uses. Only settlement differs: here Cloudflare settles; in gateway
 * mode Valorian settles on-chain over x402.
 *
 * Deploy this on the zone you want to price, bind the same PLANS KV the console
 * writes to, and enable Pay Per Crawl dynamic (in-band) pricing on that zone.
 */
import { rate, type TariffPlan } from "@valorian/rating-core";
import { defaultPlan } from "@valorian/rating-core/defaultPlan";

export interface Env {
  /** The same KV namespace the console publishes the plan to. */
  PLANS: KVNamespace;
  /** Which named ruleset anonymous crawler traffic rates under (default "viridian"). */
  DEFAULT_RULESET?: string;
}

// UA → crawler token (mirrors the gateway's identify step).
const KNOWN = [
  "gptbot", "claudebot", "google-extended", "meta-externalagent", "bytespider",
  "googlebot", "bingbot", "ccbot", "perplexitybot", "amazonbot", "applebot",
];
function extractCrawler(ua: string): string {
  const s = ua.toLowerCase();
  for (const t of KNOWN) if (s.includes(t)) return t;
  return s.slice(0, 64) || "unknown";
}

// Read the published plan from the shared store (falls back to the default plan).
async function loadPlan(env: Env): Promise<TariffPlan> {
  const set = env.DEFAULT_RULESET ?? "viridian";
  const stored =
    ((await env.PLANS.get(`ruleset:${set}:published`, "json")) as TariffPlan | null) ??
    ((await env.PLANS.get("plan:published", "json")) as TariffPlan | null);
  return stored ?? defaultPlan;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Serve the content first, and let Cloudflare cache it.
    let response = await fetch(request, { cf: { cacheEverything: true } });

    // Only price when Cloudflare has in-band (dynamic) pricing enabled.
    const mode = request.headers.get("CF-Pay-Per-Crawl") ?? "";
    if (!/\bpricing=in-band\b/.test(mode)) return response;

    const plan = await loadPlan(env);
    const cf = (request as Request & { cf?: { verifiedBotCategory?: string } }).cf;

    // Same rating call the x402 gateway makes — class · zone · freshness → price.
    const decision = rate(plan, {
      crawler: extractCrawler(request.headers.get("user-agent") ?? ""),
      verified: Boolean(cf?.verifiedBotCategory),
      path: new URL(request.url).pathname,
      contentAgeDays: 0,       // extend: derive from Last-Modified or an origin header
      buyerRequestsToday: 0,   // per-buyer volume tiers need CF-side counters; v1 skips
      buyerSpendTodayUsd: 0,
    });

    response = new Response(response.body, response); // make headers mutable
    response.headers.set("Crawler-Price", `USD ${decision.price.toFixed(4)}`);
    response.headers.set(
      "X-Rating-Trace",
      `${decision.attributes.class} · ${decision.attributes.zone} · $${decision.price.toFixed(4)}`,
    );
    return response;
  },
};
