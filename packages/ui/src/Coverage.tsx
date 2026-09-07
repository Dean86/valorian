/** Coverage — the inventory view: what the origin exposes (OpenAPI), how each
 *  route resolves through the live plan (zone → prices via the real rate()),
 *  and what traffic actually hit it (CDRs). Okta-rate-limits-table pattern:
 *  every row is a resource, policy and reality side by side. */

import { useEffect, useMemo, useState } from "react";
import { Help } from "./Help";
import { authed } from "./api";
import { rate, type RatingInput, type TariffPlan } from "@meridian/rating-core";

interface OpenApiSpec {
  paths?: Record<string, { get?: { summary?: string; parameters?: Array<{ name: string; schema?: { enum?: string[] } }> } }>;
}
interface CdrLite { path: string; price: number; decision: string }

interface RouteRow {
  key: string;
  label: string;
  summary: string;
  samplePath: string;
  slugs?: string[];
  zone: string;
  traffic: number;
  revenue: number;
  prices: number[]; // across class × freshness grid
}

const baseInput = (path: string, age: number, crawler: string, verified = false): RatingInput => ({
  crawler, verified, path, contentAgeDays: age, buyerRequestsToday: 1, buyerSpendTodayUsd: 0,
});

/** One representative caller per class, derived from the plan itself. */
function classExemplars(plan: TariffPlan): Array<{ cls: string; crawler: string; verified: boolean }> {
  return Object.entries(plan.models.classes ?? {}).map(([cls, def]) => {
    const m = def.match.find((x) => x !== "*" && !x.startsWith("verified:")) ?? "";
    if (m) return { cls, crawler: m, verified: false };
    if (def.match.some((x) => x.startsWith("verified:"))) return { cls, crawler: "some-agent", verified: true };
    return { cls, crawler: "unknown-bot-xyz", verified: false };
  });
}

/** One sample age per freshness band. */
function bandAges(plan: TariffPlan): Array<{ band: string; age: number }> {
  const bands = plan.models.freshness?.bands ?? [];
  let prevMax = -1;
  return bands.map((b) => {
    const age = b.max_age_days !== undefined ? prevMax + 1 : prevMax + 300;
    prevMax = b.max_age_days ?? prevMax + 300;
    return { band: b.name, age };
  });
}

export function CoverageView({ plan }: { plan: TariffPlan }) {
  const [spec, setSpec] = useState<OpenApiSpec | null>(null);
  const [cdrs, setCdrs] = useState<CdrLite[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/openapi.json").then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(setSpec)
      .catch(() => setErr("origin spec unreachable — is ORIGIN configured and /openapi.json served?"));
    authed("/meridian/cdrs?limit=200").then((r) => (r.ok ? r.json() : []))
      .then((rows: Array<{ path: string; price: number; decision: string }>) => setCdrs(rows))
      .catch(() => {});
  }, []);

  const exemplars = useMemo(() => classExemplars(plan), [plan]);
  const ages = useMemo(() => bandAges(plan), [plan]);

  const zoneOf = (path: string) =>
    rate(plan, baseInput(path, 0, exemplars[0]?.crawler ?? "gptbot")).attributes.zone;

  const rows = useMemo<RouteRow[]>(() => {
    if (!spec?.paths) return [];
    const out: RouteRow[] = [];
    for (const [tpl, ops] of Object.entries(spec.paths)) {
      const get = ops.get;
      if (!get) continue;
      const slugEnum = get.parameters?.find((p) => p.name === "slug")?.schema?.enum;
      if (tpl.includes("{slug}") && slugEnum?.length) {
        // group concrete slugs by the zone they resolve to (premium splits out)
        const byZone = new Map<string, string[]>();
        for (const slug of slugEnum) {
          const z = zoneOf(tpl.replace("{slug}", slug));
          byZone.set(z, [...(byZone.get(z) ?? []), slug]);
        }
        for (const [zone, slugs] of byZone) {
          out.push({
            key: `${tpl}|${zone}`,
            label: tpl,
            summary: get.summary ?? "",
            samplePath: tpl.replace("{slug}", slugs[0]),
            slugs,
            zone,
            traffic: 0, revenue: 0, prices: [],
          });
        }
      } else {
        out.push({
          key: tpl, label: tpl, summary: get.summary ?? "", samplePath: tpl,
          zone: zoneOf(tpl), traffic: 0, revenue: 0, prices: [],
        });
      }
    }
    // price grid per row (real engine, all class × band combinations)
    for (const r of out) {
      for (const ex of exemplars) {
        for (const a of ages) {
          r.prices.push(rate(plan, baseInput(r.samplePath, a.age, ex.crawler, ex.verified)).price);
        }
      }
    }
    // observed traffic per row
    const tplMatch = (r: RouteRow, path: string): boolean => {
      const clean = path.split("?")[0];
      const rx = new RegExp("^" + r.label.replace(/\{slug\}/g, "([^/]+)") + "$");
      const m = rx.exec(clean);
      if (!m) return false;
      return !r.slugs || r.slugs.includes(m[1]);
    };
    for (const c of cdrs) {
      const row = out.find((r) => tplMatch(r, c.path));
      if (row) {
        row.traffic++;
        if (c.decision === "paid") row.revenue += c.price;
      }
    }
    // zones first by declaration order feel: premium → priced → free-ish last
    return out.sort((a, b) => Math.max(...b.prices) - Math.max(...a.prices) || a.label.localeCompare(b.label));
  }, [spec, cdrs, plan, exemplars, ages]);

  const unmatched = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of cdrs) {
      const clean = c.path.split("?")[0];
      if (clean.startsWith("/meridian")) continue;
      if (rows.some((r) => new RegExp("^" + r.label.replace(/\{slug\}/g, "([^/]+)") + "$").test(clean))) continue;
      counts.set(clean, (counts.get(clean) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [cdrs, rows]);

  const fmtRange = (prices: number[]): JSX.Element => {
    const paid = prices.filter((p) => p > 0);
    if (paid.length === 0) return <span className="cov-free">free</span>;
    const min = Math.min(...paid);
    const max = Math.max(...paid);
    return (
      <span className="cov-price">
        {min === max ? `$${min}` : `$${min}–$${max}`}
        {prices.some((p) => p === 0) && <span className="cov-freehint"> · free for some</span>}
      </span>
    );
  };

  return (
    <div>
      <div className="panel">
        <h2>
          Resources <span className="count">({rows.length})</span>
          <Help>
            Everything rateable, discovered from the origin&apos;s <code>openapi.json</code> plus observed
            traffic — endpoints today; content, tools &amp; feeds next. Each row shows the zone it resolves
            to, the price range the live pricing rules produce for it, and what traffic actually hit it.
          </Help>
        </h2>
        {err && <p className="help">{err}</p>}
        <table className="selector-table">
          <thead>
            <tr>
              <th>route</th><th>zone</th><th>price range</th><th>observed</th><th>revenue</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <>
                <tr key={r.key} className={open === r.key ? "hot" : ""}>
                  <td>
                    <div className="cov-route">{r.label}</div>
                    <div className="cov-sub">
                      {r.slugs ? `${r.slugs.length} product${r.slugs.length > 1 ? "s" : ""}: ${r.slugs.slice(0, 3).join(", ")}${r.slugs.length > 3 ? "…" : ""}` : r.summary}
                    </div>
                  </td>
                  <td><span className={`zone-chip z-${r.zone}`}>{r.zone}</span></td>
                  <td>{fmtRange(r.prices)}</td>
                  <td className="cov-num">{r.traffic || "—"}</td>
                  <td className="cov-num">{r.revenue > 0 ? `$${r.revenue.toFixed(3)}` : "—"}</td>
                  <td>
                    <button className="btn tiny" onClick={() => setOpen(open === r.key ? null : r.key)}>
                      {open === r.key ? "close" : "prices"}
                    </button>
                  </td>
                </tr>
                {open === r.key && (
                  <tr key={`${r.key}-x`}>
                    <td colSpan={6}>
                      <table className="cov-grid">
                        <thead>
                          <tr><th>class ↓ / freshness →</th>{ages.map((a) => <th key={a.band}>{a.band}</th>)}</tr>
                        </thead>
                        <tbody>
                          {exemplars.map((ex) => (
                            <tr key={ex.cls}>
                              <td>{ex.cls}</td>
                              {ages.map((a) => {
                                const d = rate(plan, baseInput(r.samplePath, a.age, ex.crawler, ex.verified));
                                return (
                                  <td key={a.band} className={d.price === 0 ? "cell-free" : "cell-paid"} title={d.selectorRow}>
                                    {d.price === 0 ? "free" : `$${d.price}`}
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <p className="help">cells show the matched matrix row on hover — this grid is computed by the live rating engine, not a mock</p>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>

      {unmatched.length > 0 && (
        <div className="panel">
          <h2>Observed but not in the spec <span className="count">({unmatched.length})</span>
          <Help>
            Paths seen in real traffic that appear in no spec route — you are serving something you never
            priced deliberately. They fall through to zone/default pricing until you add them.
          </Help></h2>
          {unmatched.map(([p, n]) => (
            <div key={p} className="model-row cov-unmatched">
              <span className="lbl">{n}×</span>
              <span className="cov-route">{p}</span>
              <span className={`zone-chip z-${zoneOf(p)}`}>{zoneOf(p)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
