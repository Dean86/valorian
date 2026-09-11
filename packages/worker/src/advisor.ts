/**
 * Seller-side advisor — an agent-facing "solutions engineer" for the API.
 * A buying agent states a need in plain language; the advisor maps it to the
 * resources that satisfy it, recommends the cheapest offer for that usage, and
 * explains how to call — grounded in the LIVE catalog, offers and the rating
 * engine. The model composes language; every price comes from the engine
 * (passed in as context). It never invents a number.
 *
 * Isolated from the metering/settlement pipeline: a flaw here cannot affect
 * how requests are rated or paid.
 */

export interface AdvisorContext {
  /** Products/resources the origin exposes, with the engine's zone + fresh price. */
  resources: Array<{ slug: string; name: string; sector: string; unit: string; zone: string; fresh_price_usd: number }>;
  /** Published offers, machine-readable (charges, allowances, per-zone pricing, cap). */
  offers: unknown;
  currency: string;
}

export interface AdvisorRequest {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  need: string;
  context: AdvisorContext;
}

export interface AdvisorResult {
  ok: boolean;
  message?: string;          // the natural-language answer to the buyer agent
  recommend_offer?: string | null;
  resources?: string[];      // slugs the advisor selected
  error?: string;
}

const ADVISOR_KNOWLEDGE = `You are the sales/solutions engineer for an API, speaking to a BUYER'S autonomous agent.
Your job: turn a plain-language need into a competent, concrete recommendation.

You are given, as ground truth:
- resources: every rateable resource, with the sector it belongs to, the pricing ZONE the rating engine
  puts it in, and its per-request price when fresh (USD).
- offers: the commercial catalog — pay-per-use plus subscriptions, each with monthly charge, included
  daily allowance, per-zone price ranges and a daily credit cap.

Rules you MUST follow:
1. Use ONLY the prices in the context. NEVER invent or guess a price. If you estimate a total, show the
   arithmetic using the given per-request prices and the offer's allowance, and say it is an estimate.
2. Map the need to the specific resources (by slug) that satisfy it. Prefer the fewest that cover it.
3. If the agent states or implies a volume, compare pay-per-use vs each subscription at that volume and
   recommend the cheapest; name the winning offer's slug. If volume is unknown, ask for it OR recommend
   pay-per-use and note the break-even where a subscription starts to win.
4. Tell the agent exactly HOW to request: the endpoint shape is GET /v1/products/{slug}/prices/latest for
   the newest observation, or /v1/products/{slug}/prices?start&end for a series. Payment is x402 (an HTTP
   402 quotes the price; pay per request). Subscribing is optional and only pays off above the break-even.
5. Be concise and direct — you are talking to a machine that will act on your answer, not to a human
   browsing. No marketing fluff.

Return JSON only.`;

const ADVISOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    message: { type: "string", description: "the concrete answer to the buying agent" },
    recommend_offer: { type: ["string", "null"], description: "slug of the recommended offer, or null for pay-per-use" },
    resources: { type: "array", items: { type: "string" }, description: "slugs of the resources selected" },
  },
  required: ["message", "recommend_offer", "resources"],
} as const;

function userMessage(req: AdvisorRequest): string {
  return [
    "GROUND TRUTH — resources (slug · sector · zone · fresh $/req):",
    ...req.context.resources.map((r) => `  ${r.slug} · ${r.sector} · ${r.zone} · $${r.fresh_price_usd}`),
    "",
    "GROUND TRUTH — offers (machine-readable):",
    JSON.stringify(req.context.offers),
    "",
    `currency: ${req.context.currency}`,
    "",
    "The buying agent's need:",
    req.need,
  ].join("\n");
}

export async function runAdvisor(req: AdvisorRequest): Promise<AdvisorResult> {
  if (!req.apiKey) return { ok: false, error: "advisor not configured — set ADVISOR_API_KEY" };
  if (!req.need?.trim()) return { ok: false, error: "empty need" };
  try {
    const base = (req.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": req.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: req.model || "claude-sonnet-5",
        max_tokens: 1400,
        system: ADVISOR_KNOWLEDGE,
        messages: [{ role: "user", content: userMessage(req) }],
        output_config: { format: { type: "json_schema", schema: ADVISOR_SCHEMA } },
      }),
    });
    if (!res.ok) return { ok: false, error: `advisor model ${res.status}: ${(await res.text()).slice(0, 200)}` };
    const body = (await res.json()) as { stop_reason?: string; content: Array<{ type: string; text?: string }> };
    if (body.stop_reason === "refusal") return { ok: false, error: "model declined" };
    const text = body.content.find((b) => b.type === "text")?.text;
    if (!text) return { ok: false, error: "empty model response" };
    const parsed = JSON.parse(text) as { message: string; recommend_offer: string | null; resources: string[] };
    return { ok: true, message: parsed.message, recommend_offer: parsed.recommend_offer, resources: parsed.resources };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "advisor failed" };
  }
}
