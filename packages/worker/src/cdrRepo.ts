/**
 * CDR repository — every rating decision is persisted, no exceptions.
 * Daily buyer counters are derived from the CDR table itself (paid+free
 * requests and paid spend), which keeps one source of truth. A Durable
 * Object can replace the counter query if precision under high concurrency
 * becomes necessary.
 */

import type { RatingDecision } from "@valorian/rating-core/types";

export interface CdrRow {
  ts: string;
  day: string;
  buyerId: string;
  crawler: string;
  path: string;
  planVersion: number;
  decision: "quoted" | "paid" | "free" | "blocked";
  paymentMode: "none" | "simulated" | "x402";
  txRef: string | null;
  /** Buyer wallet address (x402 settlements) — the persistent account id. */
  payer?: string | null;
  rating: RatingDecision;
}

export async function insertCdr(db: D1Database, row: CdrRow): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO cdr (ts, day, buyer_id, crawler, class, zone, freshness, path,
                        plan_version, selector_row, price, currency, decision,
                        payment_mode, tx_ref, payer, trace)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.ts,
      row.day,
      row.buyerId,
      row.crawler,
      row.rating.attributes.class ?? "?",
      row.rating.attributes.zone ?? "?",
      row.rating.attributes.freshness ?? "?",
      row.path,
      row.planVersion,
      row.rating.selectorRow,
      row.rating.price,
      row.rating.currency,
      row.decision,
      row.paymentMode,
      row.txRef,
      row.payer ?? null,
      JSON.stringify(row.rating.trace),
    )
    .run();
  return Number(result.meta.last_row_id ?? 0);
}

/** serve-first strategy: stamp the settlement reference once it lands. */
export async function updateCdrTxRef(db: D1Database, id: number, txRef: string): Promise<void> {
  await db.prepare(`UPDATE cdr SET tx_ref = ? WHERE id = ?`).bind(txRef, id).run();
}

export interface BuyerCounters {
  requestsToday: number;
  spendTodayUsd: number;
}

/** Served requests today (free + paid) and money actually charged today. */
export async function buyerCounters(db: D1Database, buyerId: string, day: string): Promise<BuyerCounters> {
  const row = await db
    .prepare(
      `SELECT
         COUNT(CASE WHEN decision IN ('paid','free') THEN 1 END) AS requests,
         COALESCE(SUM(CASE WHEN decision = 'paid' THEN price END), 0) AS spend
       FROM cdr WHERE buyer_id = ? AND day = ?`,
    )
    .bind(buyerId, day)
    .first<{ requests: number; spend: number }>();
  return { requestsToday: row?.requests ?? 0, spendTodayUsd: row?.spend ?? 0 };
}

export interface ClassStats {
  class: string;
  quoted: number;
  paid: number;
  free: number;
  blocked: number;
  revenueUsd: number;
}

export async function statsByClass(db: D1Database, sinceDay: string): Promise<ClassStats[]> {
  const res = await db
    .prepare(
      `SELECT class,
              COUNT(CASE WHEN decision='quoted' THEN 1 END) AS quoted,
              COUNT(CASE WHEN decision='paid' THEN 1 END) AS paid,
              COUNT(CASE WHEN decision='free' THEN 1 END) AS free,
              COUNT(CASE WHEN decision='blocked' THEN 1 END) AS blocked,
              COALESCE(SUM(CASE WHEN decision='paid' THEN price END), 0) AS revenue
       FROM cdr WHERE day >= ?
       GROUP BY class ORDER BY revenue DESC`,
    )
    .bind(sinceDay)
    .all<{ class: string; quoted: number; paid: number; free: number; blocked: number; revenue: number }>();
  return (res.results ?? []).map((r) => ({
    class: r.class,
    quoted: r.quoted,
    paid: r.paid,
    free: r.free,
    blocked: r.blocked,
    revenueUsd: Math.round(r.revenue * 1e6) / 1e6,
  }));
}

export async function recentCdrs(db: D1Database, limit: number, buyerId?: string) {
  const res = buyerId
    ? await db.prepare(`SELECT * FROM cdr WHERE buyer_id = ? ORDER BY id DESC LIMIT ?`).bind(buyerId, Math.min(limit, 200)).all()
    : await db.prepare(`SELECT * FROM cdr ORDER BY id DESC LIMIT ?`).bind(Math.min(limit, 200)).all();
  return res.results ?? [];
}

export interface BuyerSummary {
  buyerId: string;
  crawler: string;
  class: string;
  payer: string | null;
  quoted: number;
  paid: number;
  free: number;
  blocked: number;
  spendUsd: number;
  spendTodayUsd: number;
  firstSeen: string;
  lastSeen: string;
}

/** Billing-care view: one row per customer (buyer), lifetime aggregates. */
export async function buyersSummary(db: D1Database, today: string): Promise<BuyerSummary[]> {
  const res = await db
    .prepare(
      `SELECT buyer_id, MAX(crawler) AS crawler, MAX(class) AS class, MAX(payer) AS payer,
              COUNT(CASE WHEN decision='quoted' THEN 1 END) AS quoted,
              COUNT(CASE WHEN decision='paid' THEN 1 END) AS paid,
              COUNT(CASE WHEN decision='free' THEN 1 END) AS free,
              COUNT(CASE WHEN decision='blocked' THEN 1 END) AS blocked,
              COALESCE(SUM(CASE WHEN decision='paid' THEN price END), 0) AS spend,
              COALESCE(SUM(CASE WHEN decision='paid' AND day = ? THEN price END), 0) AS spend_today,
              MIN(ts) AS first_seen, MAX(ts) AS last_seen
       FROM cdr GROUP BY buyer_id ORDER BY spend DESC, last_seen DESC`,
    )
    .bind(today)
    .all<{ buyer_id: string; crawler: string; class: string; payer: string | null; quoted: number; paid: number; free: number; blocked: number; spend: number; spend_today: number; first_seen: string; last_seen: string }>();
  return (res.results ?? []).map((r) => ({
    buyerId: r.buyer_id,
    crawler: r.crawler,
    class: r.class,
    payer: r.payer,
    quoted: r.quoted,
    paid: r.paid,
    free: r.free,
    blocked: r.blocked,
    spendUsd: Math.round(r.spend * 1e6) / 1e6,
    spendTodayUsd: Math.round(r.spend_today * 1e6) / 1e6,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
  }));
}
