import { describe, expect, it } from "vitest";
import { rate } from "./rate";
import type { TariffPlan } from "./types";

// Mirrors tariffs/default.yaml (v2 charge-selector model)
const plan: TariffPlan = {
  plan: "default",
  version: 1,
  currency: "USD",
  models: {
    classes: {
      frontier_lab: { match: ["gptbot", "claudebot", "google-extended"] },
      search_indexer: { match: ["googlebot", "bingbot"] },
      verified_agent: { match: ["verified:*"] },
      unknown: { match: ["*"] },
    },
    zones: { api: ["/api/*"], glossary: ["/glossary/*"], content: ["*"] },
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
      { id: "unknown-risk", when: { class: "unknown" }, price: 0.003 },
      { id: "default", when: {}, price: 0.001 },
    ],
  },
  tiers: [{ up_to: 100, multiplier: 1 }, { multiplier: 1.5 }],
  caps: { per_buyer_daily_usd: 5 },
};

const base = { path: "/article/x", contentAgeDays: 400, buyerRequestsToday: 1, buyerSpendTodayUsd: 0 };

describe("attribute resolution", () => {
  it("resolves class, zone, and freshness", () => {
    const d = rate(plan, { ...base, crawler: "GPTBot", verified: true, path: "/api/q", contentAgeDays: 3 });
    expect(d.attributes).toEqual({ class: "frontier_lab", zone: "api", freshness: "fresh" });
  });

  it("verified-but-unlisted → verified_agent; unverified → unknown", () => {
    expect(rate(plan, { ...base, crawler: "acme-agent", verified: true }).attributes.class).toBe("verified_agent");
    expect(rate(plan, { ...base, crawler: "curl/8.0", verified: false }).attributes.class).toBe("unknown");
  });
});

describe("charge selection (priority order, wildcards)", () => {
  it("search stays free regardless of zone/freshness", () => {
    const d = rate(plan, { ...base, crawler: "googlebot", verified: true, path: "/api/q", contentAgeDays: 1 });
    expect(d.selectorRow).toBe("search-free");
    expect(d.free).toBe(true);
  });

  it("frontier lab pays fresh-content premium on content zone", () => {
    const d = rate(plan, { ...base, crawler: "claudebot", verified: true, contentAgeDays: 2 });
    expect(d.selectorRow).toBe("lab-fresh");
    expect(d.price).toBe(0.05);
  });

  it("frontier lab on API zone falls through to lab-any (declared before api-any)", () => {
    const d = rate(plan, { ...base, crawler: "gptbot", verified: true, path: "/api/q" });
    expect(d.selectorRow).toBe("lab-any");
    expect(d.price).toBe(0.01);
  });

  it("verified agent on API zone hits api-any", () => {
    const d = rate(plan, { ...base, crawler: "acme-agent", verified: true, path: "/api/q" });
    expect(d.selectorRow).toBe("api-any");
    expect(d.price).toBe(0.005);
  });

  it("catch-all default row prices everything else", () => {
    const d = rate(plan, { ...base, crawler: "acme-agent", verified: true });
    expect(d.selectorRow).toBe("default");
    expect(d.price).toBe(0.001);
  });

  it("blocks with no-match when the selector has no catch-all", () => {
    const noCatchAll: TariffPlan = {
      ...plan,
      selector: { dimensions: ["class"], rows: [{ when: { class: "frontier_lab" }, price: 0.01 }] },
    };
    const d = rate(noCatchAll, { ...base, crawler: "acme-agent", verified: true });
    expect(d.blocked).toBe(true);
    expect(d.selectorRow).toBe("no-match");
  });
});

describe("post-selection steps", () => {
  it("applies the volume step-up above the tier boundary", () => {
    const d = rate(plan, { ...base, crawler: "acme-agent", verified: true, buyerRequestsToday: 101 });
    expect(d.price).toBe(0.0015);
  });

  it("blocks when the daily credit cap would be exceeded", () => {
    const d = rate(plan, { ...base, crawler: "gptbot", verified: true, buyerSpendTodayUsd: 4.995 });
    expect(d.blocked).toBe(true);
  });

  it("emits resolution + selector + price in the trace", () => {
    const d = rate(plan, { ...base, crawler: "gptbot", verified: true, contentAgeDays: 3 });
    expect(d.trace.some((l) => l.startsWith("resolve:"))).toBe(true);
    expect(d.trace.some((l) => l.startsWith("rules: matched lab-fresh"))).toBe(true);
    expect(d.trace.some((l) => l.startsWith("price="))).toBe(true);
  });
});

describe("OR value lists and custom attributes", () => {
  it("matches when the attribute is in a rule's value list (OR semantics)", () => {
    const orPlan: TariffPlan = {
      ...plan,
      selector: {
        dimensions: ["class"],
        rows: [
          { id: "bots", when: { class: ["frontier_lab", "verified_agent"] }, price: 0.02 },
          { id: "default", when: {}, price: 0.001 },
        ],
      },
    };
    expect(rate(orPlan, { ...base, crawler: "gptbot", verified: true }).selectorRow).toBe("bots");
    expect(rate(orPlan, { ...base, crawler: "acme", verified: true }).selectorRow).toBe("bots");
    expect(rate(orPlan, { ...base, crawler: "curl", verified: false }).selectorRow).toBe("default");
  });

  it("resolves custom attributes with default fallback and rates on them", () => {
    const customPlan: TariffPlan = {
      ...plan,
      models: {
        ...plan.models,
        custom: {
          channel: { values: ["partner", "internal"], source: { type: "header", name: "X-Channel" }, default: "other" },
        },
      },
      selector: {
        dimensions: ["class", "channel"],
        rows: [
          { id: "partner-rate", when: { channel: "partner" }, price: 0.0001 },
          { id: "default", when: {}, price: 0.001 },
        ],
      },
    };
    const partner = rate(customPlan, { ...base, crawler: "acme", verified: true, custom: { channel: "Partner" } });
    expect(partner.attributes.channel).toBe("partner");
    expect(partner.selectorRow).toBe("partner-rate");
    const unknown = rate(customPlan, { ...base, crawler: "acme", verified: true, custom: { channel: "weird" } });
    expect(unknown.attributes.channel).toBe("other");
    expect(unknown.selectorRow).toBe("default");
    const missing = rate(customPlan, { ...base, crawler: "acme", verified: true });
    expect(missing.attributes.channel).toBe("other");
  });
});

describe("zone validity", () => {
  const plan = {
    plan: "t", version: 1, currency: "USD" as const,
    models: {
      classes: { any: { match: ["*"] } },
      zones: { premium: ["/x*"], base: ["*"] },
      zoneValidity: { premium: { from: "2026-09-01", to: "2026-09-30" } },
    },
    selector: { dimensions: ["zone"], rows: [
      { id: "prem", when: { zone: "premium" }, price: 0.02 },
      { id: "base", when: {}, price: 0.001 },
    ] },
  };
  const input = (now: string) => ({
    crawler: "bot", verified: false, path: "/x/y", contentAgeDays: 0,
    buyerRequestsToday: 1, buyerSpendTodayUsd: 0, now,
  });
  it("applies the premium zone inside its window", () => {
    const d = rate(plan as never, input("2026-09-15"));
    expect(d.attributes.zone).toBe("premium");
    expect(d.price).toBe(0.02);
  });
  it("falls through to base after the window closes", () => {
    const d = rate(plan as never, input("2026-10-05"));
    expect(d.attributes.zone).toBe("base");
    expect(d.price).toBe(0.001);
  });
  it("falls through before the window opens", () => {
    expect(rate(plan as never, input("2026-08-20")).attributes.zone).toBe("base");
  });
});
