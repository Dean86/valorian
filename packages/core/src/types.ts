/**
 * Meridian Rating Engine — plan types (v2: charge-selector model).
 *
 * BRM heritage: the resource owner defines reference models (classes, zones,
 * freshness bands), then a CHARGE SELECTOR — a priority-ordered decision table
 * whose dimensions (columns) the owner chooses — maps resolved attributes to a
 * price. Volume tiers and credit caps apply after selection.
 */

/** Subscriber class: crawler identity matchers.
 *  Special matchers: "verified:*" (any verified bot), "*" (catch-all). */
export interface SubscriberClass {
  match: string[];
}

/** Freshness band (time-model analog over content age). Bands are ordered; a
 *  band with no max_age_days is the terminal (archive) band. */
export interface FreshnessBand {
  name: string;
  max_age_days?: number;
}

/** One pricing-rule rule. `when` maps dimension name → required resolved
 *  value, or a LIST of values (OR semantics); a missing dimension or "*"
 *  matches anything. Conditions across dimensions combine with AND.
 *  Rules are priority-ordered: first match wins. */
export interface SelectorRow {
  when: Record<string, string | string[]>;
  price: number;
  /** Optional stable id; defaults to the row index. Stamped into the CDR. */
  id?: string;
}

/** The charge selector: owner-chosen dimensions + priority-ordered rows. */
export interface ChargeSelector {
  /** Which resolved attributes form the rule columns, e.g. ["class","zone","freshness"].
   *  Must be a subset of the attribute catalog (built-in: class, zone, freshness). */
  dimensions: string[];
  rows: SelectorRow[];
}

export interface VolumeTier {
  up_to?: number;
  multiplier: number;
}

/** Owner-defined reference object: a custom attribute with its own value
 *  catalog, resolvable per request and usable as a pricing-rule dimension. */
export interface CustomAttribute {
  /** Allowed symbolic values (lowercase). */
  values: string[];
  /** Where the value comes from at request time. v1: an HTTP header. */
  source: { type: "header"; name: string };
  /** Fallback when the request carries no valid value. Defaults to "other". */
  default?: string;
}

export interface TariffPlan {
  plan: string;
  /** Plan version — immutable once published; stamped into every CDR. */
  version?: number;
  currency: "USD";
  models: {
    /** Class name → matchers. */
    classes: Record<string, SubscriberClass>;
    /** Zone name → path patterns (trailing "*" = prefix wildcard, "*" = catch-all).
     *  First match wins, in declaration order. */
    zones?: Record<string, string[]>;
    freshness?: { bands: FreshnessBand[] };
    /** Custom reference objects: attribute name → definition. */
    custom?: Record<string, CustomAttribute>;
  };
  selector: ChargeSelector;
  tiers?: VolumeTier[];
  caps?: { per_buyer_daily_usd?: number };
}

export interface RatingInput {
  /** Crawler identity, lowercase-insensitive (e.g. "GPTBot"). */
  crawler: string;
  /** Identity verified (Web Bot Auth / verified-bots list)? */
  verified: boolean;
  path: string;
  contentAgeDays: number;
  buyerRequestsToday: number;
  buyerSpendTodayUsd: number;
  /** Raw values for custom attributes, keyed by attribute name (e.g. from the
   *  configured headers). Core validates membership and applies defaults. */
  custom?: Record<string, string>;
}

export interface RatingDecision {
  price: number;
  currency: "USD";
  free: boolean;
  /** True when the credit cap refuses service. */
  blocked: boolean;
  /** Resolved attribute values, e.g. {class:"frontier_lab", zone:"api", freshness:"fresh"}. */
  attributes: Record<string, string>;
  /** Matched selector row id (or "row:<index>"); ≈ impact category. Stamp into the CDR. */
  selectorRow: string;
  /** Human-readable rating trace — every resolution and rule, in order. */
  trace: string[];
}
