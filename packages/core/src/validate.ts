/**
 * Plan validation — used by the publish flow and the UI.
 * Returns typed issues instead of throwing; "error" blocks publish,
 * "warning" is surfaced but allowed.
 */

import type { TariffPlan } from "./types";

export interface ValidationIssue {
  level: "error" | "warning";
  message: string;
}

/** Built-in attributes; custom reference objects extend this per plan. */
export const ATTRIBUTE_CATALOG = ["class", "zone", "freshness"] as const;

export function validatePlan(input: unknown): { plan?: TariffPlan; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const err = (message: string) => issues.push({ level: "error", message });
  const warn = (message: string) => issues.push({ level: "warning", message });

  if (typeof input !== "object" || input === null) {
    err("plan must be an object");
    return { issues };
  }
  const p = input as Partial<TariffPlan>;

  if (!p.plan || typeof p.plan !== "string") err("`plan` (name) is required");
  if (p.currency !== "USD") err('`currency` must be "USD" (only USD supported in v0.1)');
  if (p.version !== undefined && (!Number.isInteger(p.version) || p.version < 1)) {
    err("`version` must be a positive integer");
  }

  // ---------- reference models ----------
  const classNames = Object.keys(p.models?.classes ?? {});
  if (classNames.length === 0) err("models.classes must define at least one subscriber class");
  for (const [name, cls] of Object.entries(p.models?.classes ?? {})) {
    if (!Array.isArray(cls.match) || cls.match.length === 0) err(`class "${name}" has no matchers`);
  }
  const hasClassCatchAll = Object.values(p.models?.classes ?? {}).some((c) => (c.match ?? []).includes("*"));
  if (!hasClassCatchAll) warn('no class has a "*" matcher — unmatched crawlers resolve to class "unmatched"');

  const zoneNames = Object.keys(p.models?.zones ?? {});
  const freshnessNames = (p.models?.freshness?.bands ?? []).map((b) => b.name);

  const bands = p.models?.freshness?.bands ?? [];
  if (bands.length > 0 && bands[bands.length - 1].max_age_days !== undefined) {
    warn("freshness bands have no terminal (no max_age_days) band — old content falls into the last band anyway");
  }
  for (let i = 1; i < bands.length; i++) {
    const prev = bands[i - 1].max_age_days;
    const cur = bands[i].max_age_days;
    if (prev !== undefined && cur !== undefined && cur <= prev) {
      err(`freshness bands out of order: "${bands[i].name}" (${cur}d) must exceed "${bands[i - 1].name}" (${prev}d)`);
    }
  }

  // Custom reference objects
  const customDefs = p.models?.custom ?? {};
  const customNames = Object.keys(customDefs);
  for (const [name, def] of Object.entries(customDefs)) {
    if ((ATTRIBUTE_CATALOG as readonly string[]).includes(name)) {
      err(`custom attribute "${name}" shadows a built-in attribute`);
    }
    if (!Array.isArray(def.values) || def.values.length === 0) {
      err(`custom attribute "${name}" has no values`);
    }
    if (def.source?.type !== "header" || !def.source?.name) {
      err(`custom attribute "${name}" needs a source (v0.1: {type: "header", name: "X-..."})`);
    }
    if (def.default !== undefined && !def.values.includes(def.default) && def.default !== "other") {
      warn(`custom attribute "${name}": default "${def.default}" is not in its value list`);
    }
  }

  // ---------- pricing rules ----------
  const dims = p.selector?.dimensions ?? [];
  const allowedDims = [...ATTRIBUTE_CATALOG, ...customNames];
  if (dims.length === 0) err("the pricing rules must declare at least one dimension");
  for (const d of dims) {
    if (!allowedDims.includes(d)) {
      err(`pricing-rule dimension "${d}" is neither built-in (${ATTRIBUTE_CATALOG.join(", ")}) nor a custom attribute`);
    }
  }
  const known: Record<string, string[]> = {
    class: classNames,
    zone: zoneNames,
    freshness: freshnessNames,
    ...Object.fromEntries(customNames.map((n) => [n, [...(customDefs[n].values ?? []), customDefs[n].default ?? "other"]])),
  };

  const rows = p.selector?.rows ?? [];
  if (rows.length === 0) err("the pricing rules must contain at least one rule");
  const seenIds = new Set<string>();
  let hasCatchAllRow = false;
  rows.forEach((row, i) => {
    const label = row.id ?? `row:${i}`;
    if (row.id) {
      if (seenIds.has(row.id)) err(`duplicate rule id "${row.id}"`);
      seenIds.add(row.id);
    }
    if (typeof row.price !== "number" || !Number.isFinite(row.price) || row.price < 0) {
      err(`rule "${label}" has an invalid price (must be a finite number >= 0)`);
    }
    for (const [k, v] of Object.entries(row.when ?? {})) {
      if (!dims.includes(k)) {
        err(`rule "${label}" conditions on "${k}", which is not a declared dimension`);
        continue;
      }
      const values = Array.isArray(v) ? v : [v];
      if (Array.isArray(v) && v.length === 0) err(`rule "${label}": ${k} has an empty value list`);
      for (const one of values) {
        if (one !== "*" && known[k] && known[k].length > 0 && !known[k].includes(one)) {
          err(`rule "${label}": ${k}="${one}" does not exist in the ${k} model`);
        }
      }
    }
    const allWild = dims.every((d) => (row.when?.[d] ?? "*") === "*");
    if (allWild) hasCatchAllRow = true;
  });
  if (!hasCatchAllRow) {
    warn("the pricing rules has no catch-all rule — unmatched traffic will be BLOCKED (fail-closed)");
  }

  // ---------- tiers & caps ----------
  const tiers = p.tiers ?? [];
  for (let i = 1; i < tiers.length; i++) {
    const prev = tiers[i - 1].up_to;
    const cur = tiers[i].up_to;
    if (prev === undefined) err("only the last volume tier may omit up_to");
    else if (cur !== undefined && cur <= prev) err("volume tiers must have increasing up_to values");
  }
  if (tiers.length > 0 && tiers[tiers.length - 1].up_to !== undefined) {
    warn("last volume tier has up_to — traffic above it gets multiplier 1");
  }
  for (const t of tiers) {
    if (typeof t.multiplier !== "number" || !Number.isFinite(t.multiplier) || t.multiplier < 0) {
      err("volume tier multiplier must be a finite number >= 0");
    }
  }

  const cap = p.caps?.per_buyer_daily_usd;
  if (cap !== undefined && (!Number.isFinite(cap) || cap <= 0)) {
    err("caps.per_buyer_daily_usd must be a positive number");
  }

  const hasErrors = issues.some((i) => i.level === "error");
  return { plan: hasErrors ? undefined : (p as TariffPlan), issues };
}
