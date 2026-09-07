/** Offers repository — the product catalog above the rate plans, and the
 *  subscriptions that put accounts on offers. */

export interface Allowance {
  amount: number;
  period: "day";
  zone?: string;
}

export interface Offer {
  slug: string;
  name: string;
  description: string;
  status: "draft" | "published" | "retired";
  plan_version: number | null;
  /** Named pricing-rules set this offer uses; null → the default set. */
  ruleset: string | null;
  monthly_usd: number;
  onetime_usd: number;
  /** Credit limit for accounts on this offer; null → plan's anonymous default. */
  daily_cap_usd: number | null;
  allowances: Allowance[];
  created_at: string;
  updated_at: string;
}

interface OfferRow extends Omit<Offer, "allowances"> { allowances: string }

const parse = (r: OfferRow): Offer => ({ ...r, allowances: JSON.parse(r.allowances || "[]") as Allowance[] });

export async function listOffers(db: D1Database, publishedOnly = false): Promise<Offer[]> {
  const sql = publishedOnly
    ? `SELECT * FROM offers WHERE status = 'published' ORDER BY monthly_usd, slug`
    : `SELECT * FROM offers ORDER BY status = 'published' DESC, slug`;
  const res = await db.prepare(sql).all<OfferRow>();
  return (res.results ?? []).map(parse);
}

export async function getOffer(db: D1Database, slug: string): Promise<Offer | null> {
  const row = await db.prepare(`SELECT * FROM offers WHERE slug = ?`).bind(slug).first<OfferRow>();
  return row ? parse(row) : null;
}

export async function upsertOffer(
  db: D1Database,
  o: Omit<Offer, "created_at" | "updated_at">,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO offers (slug, name, description, status, plan_version, ruleset, monthly_usd, onetime_usd, daily_cap_usd, allowances, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET name=excluded.name, description=excluded.description,
         status=excluded.status, plan_version=excluded.plan_version, ruleset=excluded.ruleset,
         monthly_usd=excluded.monthly_usd,
         onetime_usd=excluded.onetime_usd, daily_cap_usd=excluded.daily_cap_usd,
         allowances=excluded.allowances, updated_at=excluded.updated_at`,
    )
    .bind(o.slug, o.name, o.description, o.status, o.plan_version, o.ruleset ?? null, o.monthly_usd, o.onetime_usd,
          o.daily_cap_usd ?? null, JSON.stringify(o.allowances ?? []), now, now)
    .run();
}

export async function deleteOffer(db: D1Database, slug: string): Promise<void> {
  await db.prepare(`DELETE FROM offers WHERE slug = ?`).bind(slug).run();
  await db.prepare(`DELETE FROM subscriptions WHERE offer_slug = ?`).bind(slug).run();
}

/** The implicit default: pay-per-use on the current plan. Seeded once. */
export async function ensureDefaultOffer(db: D1Database): Promise<void> {
  const existing = await db.prepare(`SELECT slug FROM offers LIMIT 1`).first();
  if (existing) return;
  await upsertOffer(db, {
    slug: "pay-per-use",
    name: "Pay per use",
    description: "Every request rated individually by the charge matrix; price quoted in the 402, settled on-chain per call. The default — no subscription needed.",
    status: "published",
    plan_version: null,
    ruleset: null,
    monthly_usd: 0,
    onetime_usd: 0,
    daily_cap_usd: null,
    allowances: [],
  });
}

export interface Subscription { buyer_id: string; offer_slug: string; started_at: string }

export async function getSubscription(db: D1Database, buyerId: string): Promise<Subscription | null> {
  return await db.prepare(`SELECT * FROM subscriptions WHERE buyer_id = ?`).bind(buyerId).first<Subscription>();
}

export async function listSubscriptions(db: D1Database): Promise<Subscription[]> {
  const res = await db.prepare(`SELECT * FROM subscriptions`).all<Subscription>();
  return res.results ?? [];
}

export async function setSubscription(db: D1Database, buyerId: string, offerSlug: string | null): Promise<void> {
  if (!offerSlug) {
    await db.prepare(`DELETE FROM subscriptions WHERE buyer_id = ?`).bind(buyerId).run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO subscriptions (buyer_id, offer_slug, started_at) VALUES (?, ?, ?)
       ON CONFLICT(buyer_id) DO UPDATE SET offer_slug=excluded.offer_slug, started_at=excluded.started_at`,
    )
    .bind(buyerId, offerSlug, new Date().toISOString())
    .run();
}
