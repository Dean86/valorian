/**
 * The canonical default plan as a typed constant.
 * KEEP IN LOCKSTEP with ../../../tariffs/default.yaml — the YAML is the
 * human-readable mirror; a core test asserts the two stay identical.
 */

import type { TariffPlan } from "./types";

export const defaultPlan: TariffPlan = {
  plan: "default",
  version: 1,
  currency: "USD",
  models: {
    classes: {
      frontier_lab: { match: ["gptbot", "claudebot", "google-extended", "meta-externalagent", "bytespider"] },
      search_indexer: { match: ["googlebot", "bingbot"] },
      verified_agent: { match: ["verified:*"] },
      unknown: { match: ["*"] },
    },
    zones: {
      api: ["/api/*"],
      glossary: ["/glossary/*"],
      content: ["*"],
    },
    freshness: {
      bands: [
        { name: "fresh", max_age_days: 7 },
        { name: "recent", max_age_days: 90 },
        { name: "archive" },
      ],
    },
  },
  selector: {
    dimensions: ["class", "zone", "freshness"],
    rows: [
      { id: "search-free", when: { class: "search_indexer" }, price: 0 },
      { id: "lab-fresh", when: { class: "frontier_lab", zone: "content", freshness: "fresh" }, price: 0.05 },
      { id: "lab-recent", when: { class: "frontier_lab", zone: "content", freshness: "recent" }, price: 0.02 },
      { id: "lab-any", when: { class: "frontier_lab" }, price: 0.01 },
      { id: "api-any", when: { zone: "api" }, price: 0.005 },
      { id: "glossary-any", when: { zone: "glossary" }, price: 0.0005 },
      { id: "unknown-risk", when: { class: "unknown" }, price: 0.003 },
      { id: "default", when: {}, price: 0.001 },
    ],
  },
  tiers: [{ up_to: 100, multiplier: 1 }, { multiplier: 1.5 }],
  caps: { per_buyer_daily_usd: 5.0 },
};
