/** Offers — the PDC view: design offers here. An offer = rate plan assignment
 *  + charges (monthly/one-time) + included allowances (non-monetary balances).
 *  Published offers are discoverable by agents at public GET /offers. */

import { useEffect, useMemo, useState } from "react";
import { Help } from "./Help";
import type { TariffPlan } from "@meridian/rating-core";
import { authed } from "./api";

interface Allowance { amount: number; period: "day"; zone?: string }
interface Offer {
  slug: string; name: string; description: string;
  status: "draft" | "published" | "retired";
  plan_version: number | null;
  ruleset: string | null;
  monthly_usd: number; onetime_usd: number;
  daily_cap_usd: number | null;
  allowances: Allowance[];
}
interface Ruleset { name: string; latest: number }

const EMPTY: Offer = { slug: "", name: "", description: "", status: "draft", plan_version: null, ruleset: null, monthly_usd: 0, onetime_usd: 0, daily_cap_usd: null, allowances: [] };

export function OffersView({ plan }: { plan: TariffPlan; onPlanLoaded: (p: TariffPlan) => void }) {
  const [offers, setOffers] = useState<Offer[]>([]);
  const [rulesets, setRulesets] = useState<Ruleset[]>([]);
  const [edit, setEdit] = useState<Offer | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const zones = useMemo(() => Object.keys(plan.models.zones ?? {}), [plan]);

  const load = () => {
    void authed("/meridian/offers").then((r) => (r.ok ? r.json() : [])).then(setOffers);
    void authed("/meridian/rulesets").then((r) => (r.ok ? r.json() : [])).then(setRulesets);
  };
  useEffect(load, []);

  async function save() {
    if (!edit) return;
    setNote(null);
    const res = await authed("/meridian/offers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(edit),
    });
    const body = (await res.json()) as { saved?: boolean; error?: string };
    if (res.ok && body.saved) { setNote(`saved ${edit.slug}`); setEdit(null); load(); }
    else setNote(body.error ?? `save failed (${res.status})`);
  }

  async function remove(slug: string) {
    if (!window.confirm(`Delete offer '${slug}'? Subscribed accounts fall back to pay-per-use.`)) return;
    await authed(`/meridian/offers/${slug}`, { method: "DELETE" });
    load();
  }

  const allowanceLabel = (o: Offer) =>
    o.allowances.length === 0 ? "—" : o.allowances.map((a) => `${a.amount}/${a.period}${a.zone ? ` ${a.zone}` : ""}`).join(", ");

  return (
    <div>
      <div className="panel">
        <h2>
          Offers
          <span className="count">agents discover published offers at public <code>GET /offers</code></span>
          <Help>
            An offer = pricing rules assignment + charges + included allowances (offer → pricing rules → charges →
            allowances). Allowances are <b>enforced live</b>: matching usage rates to $0 until the daily
            amount is used. Monthly and one-time charges are <b>declared</b> in the public catalog; on-chain
            collection lands with the x402 upto/subscription rails. The daily credit cap overrides the
            plan&apos;s anonymous default. Prices are denominated in <b>USD</b> (unit of account) and settle
            in <b>USDC</b>, a dollar-pegged stablecoin — rating currency and payment instrument are
            deliberately separate layers, so settlement rails can change without touching the tariff.
          </Help>
          <span style={{ flex: 1 }} />
          <button className="btn tiny" onClick={() => { setEdit({ ...EMPTY }); setIsNew(true); }}>+ new offer</button>
        </h2>
        {note && <p className="help">{note}</p>}
        <table className="selector-table">
          <thead>
            <tr><th>offer</th><th>status</th><th>pricing rules</th><th className="cov-num">monthly</th><th className="cov-num">one-time</th><th>included</th><th></th></tr>
          </thead>
          <tbody>
            {offers.map((o) => (
              <tr key={o.slug} className={edit?.slug === o.slug ? "hot" : ""}>
                <td><div className="cov-route">{o.name}</div><div className="cov-sub">{o.slug}</div></td>
                <td><span className={`decision ${o.status === "published" ? "d-paid" : o.status === "draft" ? "d-quoted" : "d-free"}`}>{o.status}</span></td>
                <td className="cov-sub">{o.ruleset ?? "default"}</td>
                <td className="cov-num">{o.monthly_usd > 0 ? `$${o.monthly_usd}` : "—"}</td>
                <td className="cov-num">{o.onetime_usd > 0 ? `$${o.onetime_usd}` : "—"}</td>
                <td className="cov-sub">{allowanceLabel(o)}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button className="btn tiny" onClick={() => { setEdit(structuredClone(o)); setIsNew(false); }}>edit</button>{" "}
                  {o.slug !== "pay-per-use" && <button className="btn tiny" onClick={() => void remove(o.slug)}>delete</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {edit && (
        <div className="panel">
          <h2>{isNew ? "New offer" : `Edit · ${edit.slug}`}</h2>
          <div className="offer-form">
            <label className="of-row"><span className="lbl">name</span>
              <input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="Lab Partner" /></label>
            <label className="of-row"><span className="lbl">slug</span>
              <input className="input" value={edit.slug} disabled={!isNew} onChange={(e) => setEdit({ ...edit, slug: e.target.value })} placeholder="lab-partner" /></label>
            <label className="of-row"><span className="lbl">description</span>
              <textarea className="input of-desc" value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })}
                placeholder="Shown to agents in the public catalog — say who this is for and what it includes." /></label>
            <label className="of-row"><span className="lbl">status</span>
              <select className="input" value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value as Offer["status"] })}>
                <option value="draft">draft</option><option value="published">published</option><option value="retired">retired</option>
              </select></label>
            <label className="of-row"><span className="lbl">pricing rules</span>
              <select className="input" value={edit.ruleset ?? ""} onChange={(e) => setEdit({ ...edit, ruleset: e.target.value || null })}>
                <option value="">default set</option>
                {rulesets.map((r) => <option key={r.name} value={r.name}>{r.name} (v{r.latest})</option>)}
              </select></label>
            <label className="of-row"><span className="lbl">monthly charge $</span>
              <input className="input num" type="number" min="0" step="0.01" value={edit.monthly_usd}
                onChange={(e) => setEdit({ ...edit, monthly_usd: Number(e.target.value) })} /></label>
            <label className="of-row"><span className="lbl">one-time charge $</span>
              <input className="input num" type="number" min="0" step="0.01" value={edit.onetime_usd}
                onChange={(e) => setEdit({ ...edit, onetime_usd: Number(e.target.value) })} /></label>
            <label className="of-row"><span className="lbl">daily credit cap $</span>
              <input className="input num" type="number" min="0" step="0.5" placeholder="plan default"
                value={edit.daily_cap_usd ?? ""}
                onChange={(e) => setEdit({ ...edit, daily_cap_usd: e.target.value === "" ? null : Number(e.target.value) })} /></label>

            <div className="of-row"><span className="lbl">included allowances</span>
              <div className="of-allowances">
                {edit.allowances.map((a, i) => (
                  <div key={i} className="of-alw">
                    <input className="input num" type="number" min="1" value={a.amount}
                      onChange={(e) => setEdit({ ...edit, allowances: edit.allowances.map((x, j) => j === i ? { ...x, amount: Number(e.target.value) } : x) })} />
                    <span className="cov-sub">requests / day</span>
                    <select className="input" value={a.zone ?? ""}
                      onChange={(e) => setEdit({ ...edit, allowances: edit.allowances.map((x, j) => j === i ? { ...x, zone: e.target.value || undefined } : x) })}>
                      <option value="">any zone</option>
                      {zones.map((z) => <option key={z} value={z}>{z}</option>)}
                    </select>
                    <button className="del" onClick={() => setEdit({ ...edit, allowances: edit.allowances.filter((_, j) => j !== i) })}>✕</button>
                  </div>
                ))}
                <button className="btn tiny mini-add" onClick={() => setEdit({ ...edit, allowances: [...edit.allowances, { amount: 100, period: "day" }] })}>
                  + allowance
                </button>
              </div>
            </div>

            <div className="of-actions">
              <button className="btn primary" onClick={() => void save()}>save offer</button>
              <button className="btn ghost" onClick={() => setEdit(null)}>cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
