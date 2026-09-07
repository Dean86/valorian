/** Accounts — billing care. The account is the payer entity (wallet when
 *  known); the agent is the actor working for it. List → Clerk-style detail:
 *  Overview | Statement | Purchases | Plan & offers. */

import { useEffect, useMemo, useState } from "react";
import { Help } from "./Help";
import { authed } from "./api";
import type { TariffPlan } from "@meridian/rating-core";

interface AccountSummary {
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

interface Cdr {
  id: number;
  ts: string;
  path: string;
  zone: string;
  freshness: string;
  selector_row: string;
  plan_version: number;
  price: number;
  decision: string;
  payment_mode: string;
  tx_ref: string | null;
}

type Tab = "overview" | "statement" | "purchases" | "plan";
interface OfferLite { slug: string; name: string; status: string; monthly_usd: number; allowances: Array<{ amount: number; period: string; zone?: string }> }
interface Sub { buyer_id: string; offer_slug: string }

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const when = (ts: string) => ts.slice(0, 16).replace("T", " ");

export function AccountsView({ plan }: { plan: TariffPlan }) {
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [cdrs, setCdrs] = useState<Cdr[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [offers, setOffers] = useState<OfferLite[]>([]);
  const [subs, setSubs] = useState<Sub[]>([]);
  const [subNote, setSubNote] = useState<string | null>(null);

  const loadSubs = () => {
    void authed("/meridian/offers").then((r) => (r.ok ? r.json() : [])).then((o: OfferLite[]) => setOffers(o.filter((x) => x.status === "published")));
    void authed("/meridian/subscriptions").then((r) => (r.ok ? r.json() : [])).then(setSubs);
  };
  useEffect(loadSubs, []);

  async function subscribe(buyerId: string, offerSlug: string | null) {
    setSubNote(null);
    const res = await authed("/meridian/subscriptions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ buyerId, offerSlug }),
    });
    if (res.ok) { setSubNote(offerSlug ? `subscribed to ${offerSlug} — next request rates under it` : "unsubscribed — back to pay-per-use"); loadSubs(); }
    else setSubNote(`failed (${res.status})`);
  }

  useEffect(() => {
    authed("/meridian/buyers")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(setAccounts)
      .catch(() => setErr("worker unreachable — run `npm run dev:node` or open the deployed console"));
  }, []);

  useEffect(() => {
    if (!open) return;
    setCdrs([]);
    authed(`/meridian/cdrs?buyer=${encodeURIComponent(open)}&limit=200`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setCdrs)
      .catch(() => {});
  }, [open]);

  const acct = accounts.find((a) => a.buyerId === open);

  const purchases = useMemo(() => {
    const byResource = new Map<string, { n: number; usd: number; zone: string }>();
    for (const r of cdrs) {
      if (r.decision !== "paid") continue;
      const key = r.path.split("?")[0];
      const cur = byResource.get(key) ?? { n: 0, usd: 0, zone: r.zone };
      cur.n++;
      cur.usd += r.price;
      byResource.set(key, cur);
    }
    return [...byResource.entries()].sort((a, b) => b[1].usd - a[1].usd);
  }, [cdrs]);

  const rowsHit = useMemo(() => {
    const m = new Map<string, { n: number; usd: number }>();
    for (const r of cdrs) {
      const cur = m.get(r.selector_row) ?? { n: 0, usd: 0 };
      cur.n++;
      if (r.decision === "paid") cur.usd += r.price;
      m.set(r.selector_row, cur);
    }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  }, [cdrs]);

  const conv = (b: AccountSummary) => (b.quoted > 0 ? `${Math.round((b.paid / b.quoted) * 100)}%` : "—");

  if (open && acct) {
    return (
      <div>
        <div className="panel">
          <h2>
            <button className="btn tiny" onClick={() => { setOpen(null); setTab("overview"); }}>← accounts</button>
            &nbsp; {acct.crawler} <span className="count">{acct.payer ? short(acct.payer) : acct.buyerId} · {acct.class}</span>
          </h2>
          <div className="acct-tabs">
            {(["overview", "statement", "purchases", "plan"] as Tab[]).map((t) => (
              <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
                {t === "plan" ? "plan & offers" : t}
              </button>
            ))}
          </div>

          {tab === "overview" && (
            <div className="acct-overview">
              <div className="tiles">
                <div className="tile"><div className="k">lifetime revenue</div><div className="v">${acct.spendUsd}</div></div>
                <div className="tile"><div className="k">today</div><div className="v">${acct.spendTodayUsd}<small> / ${plan.caps?.per_buyer_daily_usd ?? "∞"} cap</small></div></div>
                <div className="tile"><div className="k">quoted → paid</div><div className="v">{acct.quoted} → {acct.paid} <small>({conv(acct)})</small></div></div>
                <div className="tile"><div className="k">served free</div><div className="v">{acct.free}</div></div>
                <div className="tile"><div className="k">blocked</div><div className="v">{acct.blocked}</div></div>
              </div>
              <div className="acct-rail">
                <div className="rail-row"><span className="lbl">account (wallet)</span>
                  {acct.payer
                    ? <a className="wallet-link" href={`https://sepolia.basescan.org/address/${acct.payer}`} target="_blank" rel="noreferrer">{acct.payer}</a>
                    : <span className="cov-sub">anonymous — no settled payment yet</span>}
                </div>
                <div className="rail-row"><span className="lbl">agent</span><span>{acct.crawler} <span className="chip-class">{acct.class}</span></span></div>
                <div className="rail-row"><span className="lbl">first seen</span><span>{when(acct.firstSeen)}</span></div>
                <div className="rail-row"><span className="lbl">last seen</span><span>{when(acct.lastSeen)}</span></div>
              </div>
            </div>
          )}

          {tab === "statement" && (
            <table className="selector-table">
              <thead><tr><th>when</th><th>resource</th><th>row</th><th className="cov-num">price</th><th className="cov-num">running</th><th>status</th><th>settlement</th></tr></thead>
              <tbody>
                {cdrs.map((r, i) => (
                  <tr key={r.id}>
                    <td className="cov-sub">{when(r.ts)}</td>
                    <td><span className="cov-route">{r.path}</span></td>
                    <td><span className="cov-sub">{r.selector_row}</span></td>
                    <td className="cov-num">{r.price > 0 ? `$${r.price}` : "free"}</td>
                    <td className="cov-num cov-sub">${cdrs.slice(i).reduce((t, x) => t + (x.decision === "paid" ? x.price : 0), 0).toFixed(3)}</td>
                    <td><span className={`decision d-${r.decision}`}>{r.decision}</span></td>
                    <td>{r.tx_ref?.startsWith("0x")
                      ? <a className="wallet-link" href={`https://sepolia.basescan.org/tx/${r.tx_ref}`} target="_blank" rel="noreferrer">{short(r.tx_ref)}</a>
                      : <span className="cov-sub">{r.tx_ref ?? "—"}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {tab === "purchases" && (
            purchases.length === 0
              ? <p className="help">no paid purchases yet — quotes and free traffic only</p>
              : <table className="selector-table">
                  <thead><tr><th>resource</th><th>zone</th><th className="cov-num">purchases</th><th className="cov-num">total spend</th></tr></thead>
                  <tbody>
                    {purchases.map(([path, p]) => (
                      <tr key={path}>
                        <td><span className="cov-route">{path}</span></td>
                        <td><span className={`zone-chip z-${p.zone}`}>{p.zone}</span></td>
                        <td className="cov-num">{p.n}</td>
                        <td className="cov-num spend">${p.usd.toFixed(3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
          )}

          {tab === "plan" && (
            <div>
              <div className="sub-box">
                <div className="rail-row"><span className="lbl">current offer</span>
                  <span className="cov-route">{subs.find((x) => x.buyer_id === acct.buyerId)?.offer_slug ?? "pay-per-use (default)"}</span></div>
                <div className="rail-row"><span className="lbl">change offer</span>
                  <span className="sub-controls">
                    <select className="input" id="offer-pick" defaultValue={subs.find((x) => x.buyer_id === acct.buyerId)?.offer_slug ?? ""}>
                      <option value="">pay-per-use (default)</option>
                      {offers.filter((o) => o.slug !== "pay-per-use").map((o) => (
                        <option key={o.slug} value={o.slug}>
                          {o.name}{o.monthly_usd > 0 ? ` · $${o.monthly_usd}/mo` : ""}{o.allowances.length ? ` · ${o.allowances[0].amount}/${o.allowances[0].period} incl.` : ""}
                        </option>
                      ))}
                    </select>
                    <button className="btn tiny" onClick={() => {
                      const v = (document.getElementById("offer-pick") as HTMLSelectElement).value;
                      void subscribe(acct.buyerId, v || null);
                    }}>apply</button>
                  </span></div>
                {subNote && <p className="help">{subNote}</p>}
              </div>
              <p className="help" style={{ marginBottom: 10 }}>
                Rated under plan <b>{plan.plan} v{plan.version ?? 0}</b>.
                Matrix rows this account has hit:
              </p>
              <table className="selector-table">
                <thead><tr><th>pricing rule</th><th className="cov-num">events</th><th className="cov-num">revenue</th></tr></thead>
                <tbody>
                  {rowsHit.map(([row, v]) => (
                    <tr key={row}><td><span className="cov-route">{row}</span></td><td className="cov-num">{v.n}</td><td className="cov-num">${v.usd.toFixed(3)}</td></tr>
                  ))}
                </tbody>
              </table>
              <div className="offer-placeholder">
                <b>Offers & subscriptions — roadmap.</b> This account pays per use today.
                Coming to the catalog: monthly subscriptions with fair-use policies (the tier
                mechanism), zone-scoped bundles, and prepaid allowances via the x402
                <code> upto</code> scheme — authorize once, draw down per rated request.
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>Accounts <span className="count">({accounts.length})</span>
        <Help>
          The account is the payer entity — the wallet, once a payment has settled; the agent (crawler)
          is the actor working for it. Anonymous callers carry ip:agent identities until their first
          settled payment reveals the wallet.
        </Help>
      </h2>
      {err && <p className="help">{err}</p>}
      <table className="selector-table">
        <thead>
          <tr><th>agent</th><th>class</th><th>account (wallet)</th><th className="cov-num">served</th>
          <th className="cov-num">conv</th><th className="cov-num">lifetime</th><th>daily cap</th><th>last seen</th><th></th></tr>
        </thead>
        <tbody>
          {accounts.map((b) => (
            <tr key={b.buyerId}>
              <td><div className="cov-route">{b.crawler}</div><div className="cov-sub">{b.buyerId}</div></td>
              <td><span className="chip-class">{b.class}</span></td>
              <td>{b.payer
                ? <a className="wallet-link" href={`https://sepolia.basescan.org/address/${b.payer}`} target="_blank" rel="noreferrer">{short(b.payer)}</a>
                : <span className="cov-sub">anonymous</span>}</td>
              <td className="cov-num">{b.paid + b.free}</td>
              <td className="cov-num">{conv(b)}</td>
              <td className="cov-num spend">{b.spendUsd > 0 ? `$${b.spendUsd}` : "—"}</td>
              <td>{plan.caps?.per_buyer_daily_usd
                ? <div className="capbar" title={`$${b.spendTodayUsd} of $${plan.caps.per_buyer_daily_usd} daily cap`}>
                    <div className="capbar-fill" style={{ width: `${Math.min(100, (b.spendTodayUsd / plan.caps.per_buyer_daily_usd) * 100)}%` }} />
                    <span className="capbar-label">${b.spendTodayUsd} / ${plan.caps.per_buyer_daily_usd}</span>
                  </div>
                : <span className="cov-sub">no cap</span>}</td>
              <td className="cov-sub">{when(b.lastSeen)}</td>
              <td><button className="btn tiny" onClick={() => setOpen(b.buyerId)}>open</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
