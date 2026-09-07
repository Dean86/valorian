/**
 * Meridian Rating Worker — the enforcement point.
 *
 * Pipeline per request: identify → resolve+rate (core) → 402 quote / verify
 * payment → serve → log CDR. Admin/API routes under /meridian/*.
 */

import { Hono } from "hono";
import { rate, type TariffPlan } from "@meridian/rating-core";
import { defaultPlan } from "@meridian/rating-core/defaultPlan";
import { validatePlan } from "@meridian/rating-core/validate";
import { identifyCaller } from "./identify";
import { USDC_BY_NETWORK, buildRequirements, checkPayment, facilitatorUrl, settlePayment, verifyPayment } from "./x402";
import { contentAgeDays, contentAgeFromRequest, findDemoResource } from "./content";
import { buyerCounters, buyersSummary, insertCdr, recentCdrs, statsByClass, updateCdrTxRef, type CdrRow } from "./cdrRepo";
import { deleteOffer, ensureDefaultOffer, getOffer, getSubscription, listOffers, listSubscriptions, setSubscription, upsertOffer, type Offer } from "./offersRepo";

export interface Env {
  DB: D1Database;
  PLANS: KVNamespace;
  SETTLE_MODE: string;
  PAY_TO: string;
  NETWORK: string;
  ORIGIN?: string;
  /** Service binding to the origin worker — required on Cloudflare when the
   *  origin is another *.workers.dev worker (same-zone fetches are blocked). */
  ORIGIN_SERVICE?: Fetcher;
  DEFAULT_AGE_DAYS?: string;
  ADMIN_TOKEN?: string;
  /** Optional facilitator override; defaults by NETWORK (Sepolia = x402.org). */
  FACILITATOR_URL?: string;
  /** Name of the pricing-rules set anonymous traffic rates under. */
  DEFAULT_RULESET?: string;
  /** "true" (demo) exposes matched row + rating trace in 402s; anything else
   *  redacts them — rating logic stays private, buyers see only the price. */
  EXPOSE_TRACE?: string;
  /** "settle-first" (default: hash in CDR before data leaves) or
   *  "serve-first" (respond after verify; settle+stamp async — lower latency,
   *  tiny served-but-unsettled window, visible as tx_ref="pending..."). */
  SETTLE_STRATEGY?: string;
}

const app = new Hono<{ Bindings: Env }>();

const PLAN_KEY = "plan:published"; // legacy single-set key (default set fallback)
const SET_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const setKey = (name: string) => `ruleset:${name}:published`;
const defaultSet = (env: Env) => env.DEFAULT_RULESET ?? "viridian";

// The pricing brain is private: every /meridian/* read and write requires the
// admin token (health excepted). The public surface is /v1/* and the 402s.
app.use("/meridian/*", async (c, next) => {
  if (c.req.path === "/meridian/health") return next();
  if (c.env.ADMIN_TOKEN && c.req.header("authorization") !== `Bearer ${c.env.ADMIN_TOKEN}`) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
});

/** Live rules of a named set; the default set falls back to the legacy key. */
async function loadPlanNamed(env: Env, name: string): Promise<TariffPlan> {
  const stored = (await env.PLANS.get(setKey(name), "json")) as TariffPlan | null;
  if (stored) return stored;
  if (name === defaultSet(env)) {
    const legacy = (await env.PLANS.get(PLAN_KEY, "json")) as TariffPlan | null;
    if (legacy) return legacy;
  }
  return defaultPlan;
}

async function loadPlan(env: Env): Promise<TariffPlan> {
  return loadPlanNamed(env, defaultSet(env));
}

async function loadPlanVersion(env: Env, name: string, version: number): Promise<TariffPlan | null> {
  const row = await env.DB
    .prepare(`SELECT body FROM rulesets WHERE name = ? AND version = ?`)
    .bind(name, version)
    .first<{ body: string }>();
  return row ? (JSON.parse(row.body) as TariffPlan) : null;
}

/** Per-zone price summary — lets a shopping agent compare offers without
 *  seeing the matrix itself (prices, not logic). */
function zoneSummary(plan: TariffPlan): Array<{ zone: string; free_possible: boolean; min_usd: number; max_usd: number }> {
  return Object.keys(plan.models.zones ?? {}).map((z) => {
    const prices = (plan.selector?.rows ?? [])
      .filter((r) => { const w = r.when?.zone; return w === undefined || w === z || (Array.isArray(w) && w.includes(z)); })
      .map((r) => r.price);
    const paid = prices.filter((p) => p > 0);
    return { zone: z, free_possible: prices.some((p) => p === 0),
             min_usd: paid.length ? Math.min(...paid) : 0, max_usd: paid.length ? Math.max(...paid) : 0 };
  });
}

// ---------- Meridian API ----------

app.get("/meridian/plan", async (c) =>
  c.json(await loadPlanNamed(c.env, c.req.query("set") ?? defaultSet(c.env))));

// Named pricing-rule sets: tailored rules per situation, each versioned.
app.get("/meridian/rulesets", async (c) => {
  const res = await c.env.DB
    .prepare(`SELECT name, MAX(version) AS latest, COUNT(*) AS versions, MAX(created_at) AS updated
              FROM rulesets GROUP BY name ORDER BY name`)
    .all<{ name: string; latest: number; versions: number; updated: string }>();
  const def = defaultSet(c.env);
  return c.json((res.results ?? []).map((r) => ({ ...r, is_default: r.name === def })));
});

// Rename a set: migrates all versions (incl. the name embedded in each body),
// the live KV copy, and every offer referencing it. The default set's name is
// fixed by config (anonymous traffic routes to it by name).
app.post("/meridian/rulesets/rename", async (c) => {
  const { from, to } = (await c.req.json()) as { from: string; to: string };
  if (!SET_RE.test(to)) return c.json({ error: "new name must be kebab-case" }, 400);
  if (from === defaultSet(c.env)) return c.json({ error: `'${from}' is the default set — its name is fixed by meter config` }, 400);
  const exists = await c.env.DB.prepare(`SELECT 1 FROM rulesets WHERE name = ? LIMIT 1`).bind(to).first();
  if (exists) return c.json({ error: `set '${to}' already exists` }, 400);
  const has = await c.env.DB.prepare(`SELECT 1 FROM rulesets WHERE name = ? LIMIT 1`).bind(from).first();
  if (!has) return c.json({ error: `unknown set '${from}'` }, 404);

  await c.env.DB
    .prepare(`UPDATE rulesets SET name = ?, body = json_set(body, '$.plan', ?) WHERE name = ?`)
    .bind(to, to, from)
    .run();
  await c.env.DB.prepare(`UPDATE offers SET ruleset = ? WHERE ruleset = ?`).bind(to, from).run();
  const live = (await c.env.PLANS.get(setKey(from), "json")) as TariffPlan | null;
  if (live) {
    await c.env.PLANS.put(setKey(to), JSON.stringify({ ...live, plan: to }));
    await c.env.PLANS.delete(setKey(from));
  }
  return c.json({ renamed: true, from, to });
});

app.post("/meridian/plan", async (c) => {
  const body = await c.req.json();
  const { plan, issues } = validatePlan(body);
  if (!plan) return c.json({ published: false, issues }, 400);

  const name = plan.plan;
  if (!SET_RE.test(name)) return c.json({ published: false, issues: [{ level: "error", message: "plan name must be kebab-case (it names the pricing-rules set)" }] }, 400);
  const maxRow = await c.env.DB
    .prepare(`SELECT MAX(version) AS v FROM rulesets WHERE name = ?`)
    .bind(name)
    .first<{ v: number | null }>();
  const version = (maxRow?.v ?? 0) + 1;
  const next = { ...plan, version };
  const now = new Date().toISOString();
  await c.env.DB
    .prepare(`INSERT INTO rulesets (name, version, status, created_at, body) VALUES (?, ?, 'published', ?, ?)`)
    .bind(name, version, now, JSON.stringify(next))
    .run();
  await c.env.PLANS.put(setKey(name), JSON.stringify(next));
  if (name === defaultSet(c.env)) await c.env.PLANS.put(PLAN_KEY, JSON.stringify(next)); // legacy mirror
  return c.json({ published: true, set: name, version, issues });
});

app.get("/meridian/stats", async (c) => {
  const sinceDay = c.req.query("since") ?? new Date().toISOString().slice(0, 10);
  const classes = await statsByClass(c.env.DB, sinceDay);
  const totals = classes.reduce(
    (t, s) => ({
      quoted: t.quoted + s.quoted,
      paid: t.paid + s.paid,
      free: t.free + s.free,
      blocked: t.blocked + s.blocked,
      revenueUsd: Math.round((t.revenueUsd + s.revenueUsd) * 1e6) / 1e6,
    }),
    { quoted: 0, paid: 0, free: 0, blocked: 0, revenueUsd: 0 },
  );
  const conversion = totals.quoted > 0 ? Math.round((totals.paid / totals.quoted) * 1000) / 10 : null;
  return c.json({ sinceDay, totals, conversionPct: conversion, byClass: classes });
});

app.get("/meridian/cdrs", async (c) => {
  const limit = Number(c.req.query("limit") ?? 50);
  return c.json(await recentCdrs(c.env.DB, limit, c.req.query("buyer") || undefined));
});

// Live USDC balances for the demo wallets strip: seller (PAY_TO) always,
// plus any ?also=0x…,0x… watch addresses. Two eth_call RPCs, no keys involved.
app.get("/meridian/wallets", async (c) => {
  const usdc = USDC_BY_NETWORK[c.env.NETWORK] ?? USDC_BY_NETWORK.base;
  const rpc = c.env.NETWORK === "base" ? "https://mainnet.base.org" : "https://sepolia.base.org";
  const extra = (c.req.query("also") ?? "").split(",").map((a) => a.trim()).filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
  const addrs = [...new Set([c.env.PAY_TO, ...extra])];
  const balances = await Promise.all(addrs.map(async (a) => {
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call",
          params: [{ to: usdc, data: "0x70a08231" + a.slice(2).toLowerCase().padStart(64, "0") }, "latest"] }),
      });
      const body = (await res.json()) as { result?: string };
      return { address: a, usd: body.result ? Number(BigInt(body.result)) / 1e6 : null };
    } catch {
      return { address: a, usd: null };
    }
  }));
  return c.json({ network: c.env.NETWORK, seller: c.env.PAY_TO, balances });
});

// Plan version history (PDC-style versioned tariffs) + fetch-for-restore.
app.get("/meridian/plans", async (c) => {
  const set = c.req.query("set") ?? defaultSet(c.env);
  const res = await c.env.DB
    .prepare(`SELECT version, status, created_at FROM rulesets WHERE name = ? ORDER BY version DESC LIMIT 50`)
    .bind(set)
    .all<{ version: number; status: string; created_at: string }>();
  return c.json(res.results ?? []);
});

app.get("/meridian/plans/:version", async (c) => {
  const set = c.req.query("set") ?? defaultSet(c.env);
  const row = await c.env.DB
    .prepare(`SELECT body FROM rulesets WHERE name = ? AND version = ?`)
    .bind(set, Number(c.req.param("version")))
    .first<{ body: string }>();
  if (!row) return c.json({ error: "unknown version" }, 404);
  return c.json(JSON.parse(row.body));
});

// Billing care: customers (buyers) with lifetime aggregates.
app.get("/meridian/buyers", async (c) => c.json(await buyersSummary(c.env.DB, new Date().toISOString().slice(0, 10))));

// ---- Offers (the product catalog) — admin CRUD ----
app.get("/meridian/offers", async (c) => {
  await ensureDefaultOffer(c.env.DB);
  return c.json(await listOffers(c.env.DB));
});
app.post("/meridian/offers", async (c) => {
  const o = (await c.req.json()) as Omit<Offer, "created_at" | "updated_at">;
  if (!o.slug || !/^[a-z0-9-]{2,40}$/.test(o.slug)) return c.json({ error: "slug must be kebab-case" }, 400);
  if (!o.name) return c.json({ error: "name required" }, 400);
  await upsertOffer(c.env.DB, o);
  return c.json({ saved: true, slug: o.slug });
});
app.delete("/meridian/offers/:slug", async (c) => {
  await deleteOffer(c.env.DB, c.req.param("slug"));
  return c.json({ deleted: true });
});

// ---- Subscriptions: which account is on which offer ----
app.get("/meridian/subscriptions", async (c) => c.json(await listSubscriptions(c.env.DB)));
app.post("/meridian/subscriptions", async (c) => {
  const { buyerId, offerSlug } = (await c.req.json()) as { buyerId: string; offerSlug: string | null };
  if (!buyerId) return c.json({ error: "buyerId required" }, 400);
  if (offerSlug && !(await getOffer(c.env.DB, offerSlug))) return c.json({ error: "unknown offer" }, 400);
  await setSubscription(c.env.DB, buyerId, offerSlug);
  return c.json({ subscribed: offerSlug ?? null });
});

// Rerating report: the same monetizable traffic priced by the matrix vs one
// flat price. decision IN (paid, quoted) = every request the meter would
// charge for; free-by-design (search, meta) stays free under both tariffs.
app.get("/meridian/reports/delta", async (c) => {
  const flat = Number(c.req.query("flat") ?? 0.01);
  const since = c.req.query("since") ?? "1970-01-01";
  const res = await c.env.DB
    .prepare(
      `SELECT class, zone, freshness, COUNT(*) AS n, SUM(price) AS matrix_usd,
              SUM(CASE WHEN decision='paid' THEN price ELSE 0 END) AS realized_usd,
              COUNT(CASE WHEN decision='paid' THEN 1 END) AS paid_n
       FROM cdr WHERE decision IN ('paid','quoted') AND day >= ?
       GROUP BY class, zone, freshness ORDER BY matrix_usd DESC`,
    )
    .bind(since)
    .all<{ class: string; zone: string; freshness: string; n: number; matrix_usd: number; realized_usd: number; paid_n: number }>();
  const rows = res.results ?? [];
  const totalN = rows.reduce((t, r) => t + r.n, 0);
  const matrixUsd = Math.round(rows.reduce((t, r) => t + r.matrix_usd, 0) * 1e6) / 1e6;
  const flatUsd = Math.round(totalN * flat * 1e6) / 1e6;
  return c.json({
    since,
    flatPrice: flat,
    monetizableRequests: totalN,
    flatUsd,
    matrixUsd,
    deltaUsd: Math.round((matrixUsd - flatUsd) * 1e6) / 1e6,
    deltaPct: flatUsd > 0 ? Math.round(((matrixUsd - flatUsd) / flatUsd) * 1000) / 10 : null,
    realizedUsd: Math.round(rows.reduce((t, r) => t + r.realized_usd, 0) * 1e6) / 1e6,
    segments: rows.map((r) => ({
      class: r.class, zone: r.zone, freshness: r.freshness, requests: r.n,
      matrixUsd: Math.round(r.matrix_usd * 1e6) / 1e6,
      flatUsd: Math.round(r.n * flat * 1e6) / 1e6,
    })),
  });
});

app.get("/meridian/health", (c) => c.json({ ok: true, settleMode: c.env.SETTLE_MODE }));

// BYOK copilot: the caller's model key passes through per-request, never stored.
app.post("/meridian/ai/generate", async (c) => {
  const body = (await c.req.json()) as import("./ai").CopilotRequest;
  const { runCopilot } = await import("./ai");
  const result = await runCopilot(body);
  return c.json(result, result.ok || result.issues ? 200 : 400);
});

// ---------- Public offer discovery (machine-readable catalog) ----------
// Agents shop here: what can be bought, what each offer costs, what it
// includes — enough to make (and combine into) an optimal purchasing plan.
// Prices are exposed as per-zone ranges; the matrix itself stays private.
app.get("/offers", async (c) => {
  await ensureDefaultOffer(c.env.DB);
  const current = await loadPlan(c.env);
  const offers = await listOffers(c.env.DB, true);
  const out = [];
  for (const o of offers) {
    const base = o.ruleset ? await loadPlanNamed(c.env, o.ruleset) : current;
    const p = o.plan_version
      ? (await loadPlanVersion(c.env, o.ruleset ?? defaultSet(c.env), o.plan_version)) ?? base
      : base;
    out.push({
      slug: o.slug,
      name: o.name,
      description: o.description,
      charges: { per_use: true, monthly_usd: o.monthly_usd, onetime_usd: o.onetime_usd },
      credit_limit_usd_per_day: o.daily_cap_usd ?? current.caps?.per_buyer_daily_usd ?? null,
      included_allowances: o.allowances,
      usage_pricing: { currency: "USD", by_zone: zoneSummary(p) },
      subscribe: o.monthly_usd > 0 || o.onetime_usd > 0
        ? { method: "manual", note: "self-serve subscription via x402 upto-scheme: coming" }
        : { method: "none-needed", note: "default offer — just pay the 402s" },
    });
  }
  return c.json({
    service: "meridian",
    payment: { protocol: "x402", network: c.env.NETWORK },
    offers: out,
    hint: "compare offers; allowances rate matching usage to $0; the 402 always quotes the final price",
  });
});

// ---------- The paywall pipeline (everything else) ----------

app.all("*", async (c) => {
  const env = c.env;
  const req = c.req.raw;
  const url = new URL(req.url);
  const path = url.pathname;

  let plan = await loadPlan(env);
  const caller = identifyCaller(req);
  const now = new Date();
  const day = now.toISOString().slice(0, 10);

  const counters = await buyerCounters(env.DB, caller.buyerId, day);

  // Subscription-aware rating: an account on an offer gets that offer's plan
  // version and its included allowances.
  const sub = await getSubscription(env.DB, caller.buyerId);
  const offer = sub ? await getOffer(env.DB, sub.offer_slug) : null;
  if (offer?.ruleset) plan = await loadPlanNamed(env, offer.ruleset);
  if (offer?.plan_version) {
    plan = (await loadPlanVersion(env, offer.ruleset ?? defaultSet(env), offer.plan_version)) ?? plan;
  }
  // Credit limit is a property of the commercial relationship: the offer's cap
  // overrides the plan's anonymous default.
  if (offer?.daily_cap_usd != null) {
    plan = { ...plan, caps: { ...plan.caps, per_buyer_daily_usd: offer.daily_cap_usd } };
  }
  // Custom reference objects resolve from their configured request headers.
  const custom = Object.fromEntries(
    Object.entries(plan.models.custom ?? {}).map(([name, def]) => [
      name,
      req.headers.get(def.source.name) ?? "",
    ]),
  );
  let decision = rate(plan, {
    crawler: caller.crawler,
    verified: caller.verified,
    path,
    contentAgeDays: env.ORIGIN
      ? contentAgeFromRequest(url, Number(env.DEFAULT_AGE_DAYS ?? 365))
      : contentAgeDays(path, Number(env.DEFAULT_AGE_DAYS ?? 365)),
    buyerRequestsToday: counters.requestsToday + 1,
    buyerSpendTodayUsd: counters.spendTodayUsd,
    custom,
  });

  // Included allowances: matching usage rates to $0 until today's amount is used.
  if (offer && !decision.blocked && decision.price > 0) {
    const alw = offer.allowances.find((a) => !a.zone || a.zone === decision.attributes.zone);
    if (alw && counters.requestsToday + 1 <= alw.amount) {
      decision = {
        ...decision, price: 0, free: true,
        trace: [...decision.trace, `offer ${offer.slug}: allowance ${alw.amount}/${alw.period}${alw.zone ? ` (zone=${alw.zone})` : ""} — request ${counters.requestsToday + 1} of ${alw.amount} → 0`],
      };
    }
  }

  const baseCdr: Omit<CdrRow, "decision" | "paymentMode" | "txRef"> = {
    ts: now.toISOString(),
    day,
    buyerId: caller.buyerId,
    crawler: caller.crawler,
    path,
    planVersion: plan.version ?? 0,
    rating: decision,
  };

  const serve = async (): Promise<Response> => {
    if (env.ORIGIN_SERVICE) {
      const target = new URL(path + url.search, env.ORIGIN ?? "https://origin.internal");
      return env.ORIGIN_SERVICE.fetch(new Request(target, req));
    }
    if (env.ORIGIN) return fetch(new Request(new URL(path + url.search, env.ORIGIN), req));
    const demo = findDemoResource(path);
    if (!demo) return c.text("not found (demo mode: see /meridian/health for API routes)", 404);
    const type = demo.path.startsWith("/api/") ? "application/json" : "text/markdown";
    return new Response(demo.body, { headers: { "content-type": type } });
  };

  if (decision.blocked) {
    await insertCdr(env.DB, { ...baseCdr, decision: "blocked", paymentMode: "none", txRef: null });
    return c.json({ error: "blocked", reason: decision.trace.at(-1) }, 429);
  }

  if (decision.free) {
    await insertCdr(env.DB, { ...baseCdr, decision: "free", paymentMode: "none", txRef: null });
    return serve();
  }

  const expose = env.EXPOSE_TRACE === "true";
  const requirements = buildRequirements({
    priceUsd: decision.price,
    resource: url.origin + path,
    network: env.NETWORK,
    payTo: env.PAY_TO,
    plan: plan.plan,
    planVersion: plan.version ?? 0,
    selectorRow: expose ? decision.selectorRow : "-",
    trace: expose ? decision.trace : [],
  });

  // ---- payment: simulated shortcut, or real x402 verify/settle ----
  if (env.SETTLE_MODE === "simulated") {
    const payment = checkPayment(req, env.SETTLE_MODE);
    if (payment.paid) {
      await insertCdr(env.DB, { ...baseCdr, decision: "paid", paymentMode: payment.mode, txRef: payment.txRef });
      const res = await serve();
      const out = new Response(res.body, res);
      out.headers.set("x-payment-response", btoa(JSON.stringify({ success: true, transaction: payment.txRef, mode: "simulated" })));
      return out;
    }
  } else {
    const fac = { requirement: requirements.accepts[0], facilitator: facilitatorUrl(env.NETWORK, env.FACILITATOR_URL) };
    const v = await verifyPayment(req, fac);
    if (!v.ok && req.headers.get("x-payment")) console.error("x402 verify failed:", v.reason ?? "(no reason)");
    if (v.ok) {
      if (env.SETTLE_STRATEGY === "serve-first") {
        // reserve → serve → commit async; CDR shows "pending…" until stamped
        const cdrId = await insertCdr(env.DB, { ...baseCdr, decision: "paid", paymentMode: "x402", txRef: `pending:${crypto.randomUUID()}`, payer: v.payer ?? null });
        const res = await serve();
        const settleAndStamp = settlePayment(v.paymentPayload, fac).then((s) =>
          updateCdrTxRef(env.DB, cdrId, s.ok ? s.txRef : `failed:${s.reason}`),
        );
        try { c.executionCtx.waitUntil(settleAndStamp); } catch { void settleAndStamp; }
        const out = new Response(res.body, res);
        out.headers.set("x-payment-response", btoa(JSON.stringify({ success: true, pending: true })));
        return out;
      }
      // settle-first (default): commit on-chain, then serve — hash in the CDR always
      const s = await settlePayment(v.paymentPayload, fac);
      if (!s.ok) console.error("x402 settle failed:", s.reason);
      if (s.ok) {
        await insertCdr(env.DB, { ...baseCdr, decision: "paid", paymentMode: "x402", txRef: s.txRef, payer: s.payer ?? v.payer ?? null });
        const res = await serve();
        const out = new Response(res.body, res);
        out.headers.set("x-payment-response", s.responseHeader);
        return out;
      }
    }
  }

  // No/invalid payment → 402 quote (this CDR row makes conversion measurable)
  await insertCdr(env.DB, { ...baseCdr, decision: "quoted", paymentMode: "none", txRef: null });
  return c.json(requirements, 402);
});

export default app;
