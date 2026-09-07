/**
 * AI copilot support — the domain knowledge and transfer schema that let ANY
 * model (BYOK: Anthropic, OpenAI-compatible, local) generate valid rate plans.
 *
 * Structured-output constraint: dynamic-key maps (Record<string, …>) are not
 * expressible with additionalProperties:false, so the AI exchanges an
 * ARRAY-based AiPlan which we convert to the canonical TariffPlan.
 */

import type { TariffPlan } from "./types";

// ---------- transfer shape (arrays instead of records) ----------

export interface AiPlan {
  plan: string;
  currency: "USD";
  classes: { name: string; match: string[] }[];
  zones: { name: string; patterns: string[] }[];
  freshness: { name: string; max_age_days?: number }[];
  dimensions: string[];
  rows: { id?: string; when: { dimension: string; value: string }[]; price: number }[];
  tiers: { up_to?: number; multiplier: number }[];
  cap_usd?: number;
}

export function aiPlanToTariff(ai: AiPlan, version?: number): TariffPlan {
  return {
    plan: ai.plan,
    ...(version !== undefined ? { version } : {}),
    currency: ai.currency,
    models: {
      classes: Object.fromEntries(ai.classes.map((c) => [c.name, { match: c.match }])),
      ...(ai.zones.length > 0
        ? { zones: Object.fromEntries(ai.zones.map((z) => [z.name, z.patterns])) }
        : {}),
      ...(ai.freshness.length > 0 ? { freshness: { bands: ai.freshness } } : {}),
    },
    selector: {
      dimensions: ai.dimensions,
      rows: ai.rows.map((r) => ({
        ...(r.id ? { id: r.id } : {}),
        when: Object.fromEntries(r.when.map((w) => [w.dimension, w.value])),
        price: r.price,
      })),
    },
    ...(ai.tiers.length > 0 ? { tiers: ai.tiers } : {}),
    ...(ai.cap_usd !== undefined ? { caps: { per_buyer_daily_usd: ai.cap_usd } } : {}),
  };
}

// ---------- JSON schema for structured output ----------

const AI_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["plan", "currency", "classes", "zones", "freshness", "dimensions", "rows", "tiers"],
  properties: {
    plan: { type: "string", description: "short plan name, kebab-case" },
    currency: { type: "string", enum: ["USD"] },
    classes: {
      type: "array",
      description: "subscriber classes in priority order of matching",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "match"],
        properties: {
          name: { type: "string" },
          match: {
            type: "array",
            items: { type: "string" },
            description: 'identity tokens (e.g. "gptbot"), "verified:*" for any verified bot, "*" catch-all',
          },
        },
      },
    },
    zones: {
      type: "array",
      description: "content zones over URL paths; first match wins; include a catch-all zone",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "patterns"],
        properties: {
          name: { type: "string" },
          patterns: { type: "array", items: { type: "string" }, description: '"/api/*" prefix or "*" catch-all' },
        },
      },
    },
    freshness: {
      type: "array",
      description: "content-age bands, ascending max_age_days; last band omits max_age_days (terminal)",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: {
          name: { type: "string" },
          max_age_days: { type: "integer" },
        },
      },
    },
    dimensions: {
      type: "array",
      items: { type: "string", enum: ["class", "zone", "freshness"] },
      description: "which attributes form the pricing-rule columns",
    },
    rows: {
      type: "array",
      description: "priority-ordered pricing rules; FIRST MATCH WINS; end with a catch-all row (empty when)",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "when", "price"],
        properties: {
          id: { type: "string", description: "short kebab-case rule id" },
          when: {
            type: "array",
            description: "conditions; omit a dimension to mean wildcard",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["dimension", "value"],
              properties: {
                dimension: { type: "string", enum: ["class", "zone", "freshness"] },
                value: { type: "string" },
              },
            },
          },
          price: { type: "number", description: "USD per request, >= 0" },
        },
      },
    },
    tiers: {
      type: "array",
      description: "per-buyer daily volume tiers; ascending up_to; last tier omits up_to",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["multiplier"],
        properties: {
          up_to: { type: "integer" },
          multiplier: { type: "number" },
        },
      },
    },
    cap_usd: { type: "number", description: "optional daily credit cap per buyer in USD" },
  },
} as const;

/** Wrapper: the model returns an explanation alongside the full plan. */
export const AI_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["explanation", "plan"],
  properties: {
    explanation: {
      type: "string",
      description: "2-5 sentences: what was created/changed and the pricing rationale",
    },
    plan: AI_PLAN_SCHEMA,
  },
} as const;

// ---------- the domain briefing (system prompt) ----------

export const RATING_KNOWLEDGE = `You are Meridian's rating copilot. Meridian is a rating engine for the
"agent web": websites and APIs that charge AI crawlers/agents per request over
the x402 payment protocol (HTTP 402). Your job: turn the owner's plain-language
pricing intent into a complete, valid rate plan. You have deep knowledge of
telco charging (rating, tariffing, credit control) — apply that discipline.

## The domain model
- A rateable EVENT is one HTTP request from a crawler/agent.
- SUBSCRIBER CLASSES group callers by identity: matchers are lowercase tokens
  found in the crawler identity (e.g. "gptbot", "claudebot", "googlebot"),
  "verified:*" (any verified bot not otherwise matched), "*" (catch-all).
  Well-known tokens: gptbot, claudebot, google-extended, meta-externalagent,
  bytespider (training crawlers); googlebot, bingbot (search); perplexitybot,
  amazonbot, ccbot.
- CONTENT ZONES group URLs: patterns like "/api/*" (prefix) or "*" (catch-all).
  First matching zone in list order wins.
- FRESHNESS BANDS bracket content age in days, ascending; the last band has no
  max_age_days (terminal/archive).
- The RATE MATRIX (a decision table) prices events: priority-ordered rows;
  each row has conditions on the declared dimensions (a missing dimension in
  "when" = wildcard) and a USD price per request. FIRST MATCH WINS — order
  rows most-specific first. A row with empty "when" is the catch-all.
  IMPORTANT: if no row matches, the request is BLOCKED (fail-closed) — always
  include a catch-all row unless the owner explicitly wants block-by-default.
- VOLUME TIERS multiply the matched price by the buyer's request count today
  (ascending up_to; last tier open-ended). CAP_USD hard-stops a buyer's daily
  spend (further requests blocked).

## Pricing judgment (defaults when the owner doesn't specify)
- Typical prices: $0.0005–$0.05 per request. Fresh/premium content and APIs at
  the top; archive at the bottom.
- Frontier-lab training crawlers typically pay 5–10x the base rate.
- Classic search indexers (googlebot, bingbot) are usually FREE (price 0) —
  they drive human traffic. Ask-worthy exception: owner says otherwise.
- Unverified/unknown traffic usually carries a risk premium (2–4x base).
- Keep plans SMALL and readable: 3–6 classes, 2–4 zones, 2–3 freshness bands,
  5–10 rows. Prefer wildcards over enumerating every combination.

## Rules for your output
- Always return the COMPLETE plan (not a diff), even for small edits to the
  current plan — start from the current plan and modify it.
- Preserve the owner's existing names/ids where the request doesn't change them.
- Every value referenced in a row's "when" must exist in the corresponding
  model (class names, zone names, freshness band names).
- Explain your pricing rationale briefly in "explanation".
- Note: owners can also define CUSTOM attributes (extra dimensions resolved
  from request headers) in the UI; you manage only the built-in dimensions
  (class, zone, freshness) — never remove custom dimensions you see in the
  current plan's selector; preserve them and their rules untouched.`;
