/**
 * Meridian Rating Engine — core rating function (v2: charge-selector model).
 *
 * Two phases, PDC-style:
 *   1. Attribute resolution — raw request → symbolic values (class, zone,
 *      freshness band) via the plan's reference models.
 *   2. Charge selection — first matching row of the owner-defined,
 *      priority-ordered decision table sets the base price.
 * Then post-selection steps: volume tier multiplier, credit-cap check.
 *
 * Pure and dependency-free. The caller persists the decision (the CDR).
 */

import type { RatingDecision, RatingInput, TariffPlan } from "./types";

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

function resolveClass(plan: TariffPlan, input: RatingInput): string {
  const id = input.crawler.toLowerCase();
  let catchAll: string | undefined;
  let verifiedAny: string | undefined;
  for (const [name, cls] of Object.entries(plan.models.classes)) {
    for (const m of cls.match) {
      if (m === "*") catchAll ??= name;
      else if (m === "verified:*") verifiedAny ??= name;
      else if (id.includes(m.toLowerCase())) return name;
    }
  }
  if (input.verified && verifiedAny) return verifiedAny;
  return catchAll ?? "unmatched";
}

function zoneActive(plan: TariffPlan, name: string, today: string): boolean {
  const w = plan.models.zoneValidity?.[name];
  if (!w) return true;
  if (w.from && today < w.from) return false;
  if (w.to && today > w.to) return false;
  return true;
}

function resolveZone(plan: TariffPlan, path: string, today: string): string {
  const zones = plan.models.zones;
  if (!zones) return "default";
  let catchAll: string | undefined;
  for (const [name, patterns] of Object.entries(zones)) {
    if (!zoneActive(plan, name, today)) continue; // outside validity → skip, fall through
    for (const p of patterns) {
      if (p === "*") catchAll ??= name;
      else if (p.endsWith("*") ? path.startsWith(p.slice(0, -1)) : path === p) return name;
    }
  }
  return catchAll ?? "default";
}

function resolveFreshness(plan: TariffPlan, ageDays: number): string {
  const bands = plan.models.freshness?.bands;
  if (!bands) return "any";
  for (const b of bands) {
    if (b.max_age_days === undefined || ageDays <= b.max_age_days) return b.name;
  }
  return bands[bands.length - 1]?.name ?? "any";
}

function tierMultiplier(plan: TariffPlan, requestsToday: number): { mult: number; tier: string } {
  for (const t of plan.tiers ?? []) {
    if (t.up_to === undefined || requestsToday <= t.up_to) {
      return { mult: t.multiplier, tier: t.up_to ? `<=${t.up_to}/day` : "top" };
    }
  }
  return { mult: 1, tier: "none" };
}

/** Rate one request against a plan. Deterministic and side-effect free. */
export function rate(plan: TariffPlan, input: RatingInput): RatingDecision {
  const trace: string[] = [];

  // Phase 1 — attribute resolution
  const today = input.now ?? new Date().toISOString().slice(0, 10);
  const attributes: Record<string, string> = {
    class: resolveClass(plan, input),
    zone: resolveZone(plan, input.path, today),
    freshness: resolveFreshness(plan, input.contentAgeDays),
  };
  trace.push(
    `resolve: class=${attributes.class} (crawler="${input.crawler}", verified=${input.verified}), ` +
    `zone=${attributes.zone} (path=${input.path}), freshness=${attributes.freshness} (age=${input.contentAgeDays}d)`,
  );

  // Custom reference objects (owner-defined attributes)
  const customDefs = plan.models.custom ?? {};
  const customTraces: string[] = [];
  for (const [name, def] of Object.entries(customDefs)) {
    const raw = input.custom?.[name]?.toLowerCase().trim() ?? "";
    const resolved = def.values.includes(raw) ? raw : (def.default ?? "other");
    attributes[name] = resolved;
    customTraces.push(`${name}=${resolved}${raw && raw !== resolved ? ` (raw="${raw}")` : ""}`);
  }
  if (customTraces.length > 0) trace.push(`resolve custom: ${customTraces.join(", ")}`);

  // Phase 2 — pricing-rule selection (first matching rule wins)
  const dims = plan.selector.dimensions;
  const fmt = (v: string | string[]) => (Array.isArray(v) ? v.join("|") : v);
  let rowId = "no-match";
  let basePrice: number | undefined;
  for (let i = 0; i < plan.selector.rows.length; i++) {
    const row = plan.selector.rows[i];
    const matches = dims.every((d) => {
      const want = row.when[d] ?? "*";
      if (want === "*") return true;
      return Array.isArray(want) ? want.includes(attributes[d]) : want === attributes[d];
    });
    if (matches) {
      rowId = row.id ?? `row:${i}`;
      basePrice = row.price;
      const cond = dims.map((d) => `${d}=${fmt(row.when[d] ?? "*")}`).join(", ");
      trace.push(`rules: matched ${rowId} (${cond}) → base=${row.price}`);
      break;
    }
  }
  if (basePrice === undefined) {
    trace.push("rules: NO RULE MATCHED — refusing to price (add a catch-all rule)");
    return {
      price: 0, currency: plan.currency, free: false, blocked: true,
      attributes, selectorRow: rowId, trace,
    };
  }

  // Post-selection — volume tier, then credit cap
  const tier = tierMultiplier(plan, input.buyerRequestsToday);
  if (tier.tier !== "none") trace.push(`tier=${tier.tier} x${tier.mult} (requests today=${input.buyerRequestsToday})`);

  const price = round6(basePrice * tier.mult);
  trace.push(`price=${price} ${plan.currency}`);

  const cap = plan.caps?.per_buyer_daily_usd;
  const blocked = cap !== undefined && price > 0 && input.buyerSpendTodayUsd + price > cap;
  if (blocked) trace.push(`BLOCKED: daily cap ${cap} would be exceeded (spent=${input.buyerSpendTodayUsd})`);

  return {
    price,
    currency: plan.currency,
    free: price === 0,
    blocked,
    attributes,
    selectorRow: rowId,
    trace,
  };
}
