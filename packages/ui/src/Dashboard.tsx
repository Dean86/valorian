import { useCallback, useEffect, useState } from "react";
import { authed } from "./api";

interface ClassStats {
  class: string;
  quoted: number;
  paid: number;
  free: number;
  blocked: number;
  revenueUsd: number;
}
interface Stats {
  sinceDay: string;
  totals: { quoted: number; paid: number; free: number; blocked: number; revenueUsd: number };
  conversionPct: number | null;
  byClass: ClassStats[];
}
interface WalletsResp { network: string; seller: string; balances: Array<{ address: string; usd: number | null }> }
interface DeltaReport {
  since: string;
  flatPrice: number;
  monetizableRequests: number;
  flatUsd: number;
  matrixUsd: number;
  deltaUsd: number;
  deltaPct: number | null;
  realizedUsd: number;
  segments: Array<{ class: string; zone: string; freshness: string; requests: number; matrixUsd: number; flatUsd: number }>;
}
interface Cdr {
  id: number;
  ts: string;
  buyer_id: string;
  crawler: string;
  class: string;
  zone: string;
  freshness: string;
  path: string;
  plan_version: number;
  selector_row: string;
  price: number;
  decision: string;
  tx_ref: string | null;
  trace: string;
}

export function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [cdrs, setCdrs] = useState<Cdr[]>([]);
  const [delta, setDelta] = useState<DeltaReport | null>(null);
  const [flat, setFlat] = useState("0.01");
  const [wallets, setWallets] = useState<WalletsResp | null>(null);
  const [watchAddr, setWatchAddr] = useState(
    () => localStorage.getItem("meridian.watchAddr") ?? "0x32AA8Ad02676b44b99BA395C8D46ddbA32E659DD",
  );
  const [baseline, setBaseline] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [openTrace, setOpenTrace] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [s, c, d, w] = await Promise.all([
        authed("/meridian/stats").then((r) => r.json() as Promise<Stats>),
        authed("/meridian/cdrs?limit=50").then((r) => r.json() as Promise<Cdr[]>),
        authed(`/meridian/reports/delta?flat=${encodeURIComponent(flat)}`).then((r) => r.json() as Promise<DeltaReport>),
        authed(`/meridian/wallets?also=${encodeURIComponent(watchAddr)}`)
          .then((r) => (r.ok ? (r.json() as Promise<WalletsResp>) : null))
          .catch(() => null),
      ]);
      setStats(s);
      setCdrs(c);
      setDelta(d);
      if (w) {
        setWallets(w);
        setBaseline((prev) => {
          const next = { ...prev };
          for (const b of w.balances) if (b.usd !== null && next[b.address] === undefined) next[b.address] = b.usd;
          return next;
        });
      }
    } catch {
      setError("worker unreachable — start it with `npm run dev:node` in packages/worker (then `npm run replay` for traffic)");
    }
  }, [flat, watchAddr]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  if (error) return <main style={{ padding: 18 }}><div className="hint">{error}</div></main>;
  if (!stats) return <main style={{ padding: 18 }}><div className="hint">loading…</div></main>;

  const decisionBadge = (d: string) =>
    d === "paid" ? "ok" : d === "quoted" ? "info" : d === "blocked" ? "hot" : "warn";

  const maxUsd = delta ? Math.max(delta.flatUsd, delta.matrixUsd, 0.000001) : 1;

  const walletTile = (addr: string, label: string, isSeller: boolean) => {
    const bal = wallets?.balances.find((b) => b.address.toLowerCase() === addr.toLowerCase());
    const base = baseline[bal?.address ?? ""];
    const d = bal?.usd !== null && bal?.usd !== undefined && base !== undefined ? bal.usd - base : null;
    const dCls = d === null || Math.abs(d) < 1e-9 ? "wflat" : (d > 0 ? "wup" : "wdown");
    return (
      <div className={`wallet-tile ${isSeller ? "seller" : ""}`}>
        <div className="k">{label}</div>
        <div className="wbal">{bal?.usd === null || bal?.usd === undefined ? "…" : `$${bal.usd.toFixed(3)}`}</div>
        <div className={`wdelta ${dCls}`}>
          {d === null ? "reading chain…" : Math.abs(d) < 1e-9 ? "no change since watching" : `${d > 0 ? "+" : "−"}$${Math.abs(d).toFixed(3)} since watching`}
        </div>
        <div className="waddr">{addr.slice(0, 8)}…{addr.slice(-6)}</div>
      </div>
    );
  };

  return (
    <main style={{ padding: "14px 18px" }}>
      {wallets && (
        <div className="panel wallets-panel">
          <h2>
            Wallets — live on {wallets.network}
            <span className="count">
              USDC balances, polled every 5s · watch:&nbsp;
              <input
                className="input num watch-in"
                value={watchAddr}
                onChange={(e) => { setWatchAddr(e.target.value); localStorage.setItem("meridian.watchAddr", e.target.value); }}
              />
            </span>
          </h2>
          <div className="wallets-strip">
            {walletTile(wallets.seller, "seller — your revenue", true)}
            {/^0x[0-9a-fA-F]{40}$/.test(watchAddr) && walletTile(watchAddr, "watched payer — public on-chain", false)}
          </div>
        </div>
      )}
      {delta && delta.monetizableRequests > 0 && (
        <div className="panel delta-panel">
          <h2>
            The delta — same traffic, two tariffs
            <span className="count">
              {delta.monetizableRequests} monetizable requests, rerated · flat $
              <input className="input num flat-in" value={flat} onChange={(e) => setFlat(e.target.value)} />
              /req
            </span>
          </h2>
          <div className="delta-bars">
            <div className="delta-row">
              <span className="delta-label">one flat price</span>
              <div className="delta-track"><div className="delta-fill flat" style={{ width: `${(delta.flatUsd / maxUsd) * 100}%` }} /></div>
              <span className="delta-val">${delta.flatUsd.toFixed(3)}</span>
            </div>
            <div className="delta-row">
              <span className="delta-label">the rate matrix</span>
              <div className="delta-track"><div className="delta-fill matrix" style={{ width: `${(delta.matrixUsd / maxUsd) * 100}%` }} /></div>
              <span className="delta-val strong">${delta.matrixUsd.toFixed(3)}</span>
            </div>
          </div>
          <div className="delta-verdict">
            {delta.deltaPct === null ? "" : delta.deltaUsd >= 0
              ? <>matrix earns <b>+${delta.deltaUsd.toFixed(3)} ({delta.deltaPct}%)</b> more on identical traffic — differentiation, not luck</>
              : <>flat wins by ${Math.abs(delta.deltaUsd).toFixed(3)} at this flat price — drag the price down to see where it stops covering premium traffic</>}
          </div>
          <details className="delta-detail">
            <summary>by segment (class × zone × freshness)</summary>
            <table className="selector-table">
              <thead><tr><th>class</th><th>zone</th><th>freshness</th><th className="cov-num">requests</th><th className="cov-num">matrix</th><th className="cov-num">flat</th></tr></thead>
              <tbody>
                {delta.segments.map((g, i) => (
                  <tr key={i}>
                    <td>{g.class}</td><td>{g.zone}</td><td>{g.freshness}</td>
                    <td className="cov-num">{g.requests}</td>
                    <td className="cov-num">${g.matrixUsd}</td>
                    <td className="cov-num">${g.flatUsd}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </div>
      )}
      <div className="tiles">
        <div className="tile">
          <div className="k">revenue (today)</div>
          <div className="v">${stats.totals.revenueUsd.toFixed(4)}</div>
        </div>
        <div className="tile">
          <div className="k">402 → paid conversion</div>
          <div className="v">{stats.conversionPct === null ? "—" : `${stats.conversionPct}%`}</div>
        </div>
        <div className="tile">
          <div className="k">quoted</div>
          <div className="v">{stats.totals.quoted}</div>
        </div>
        <div className="tile">
          <div className="k">paid</div>
          <div className="v">{stats.totals.paid}</div>
        </div>
        <div className="tile">
          <div className="k">free / blocked</div>
          <div className="v">
            {stats.totals.free} <small>/ {stats.totals.blocked}</small>
          </div>
        </div>
      </div>

      <section className="panel">
        <h2>Revenue by subscriber class</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th>class</th><th>quoted</th><th>paid</th><th>free</th><th>blocked</th><th>conversion</th><th>revenue</th>
            </tr>
          </thead>
          <tbody>
            {stats.byClass.map((s) => (
              <tr key={s.class}>
                <td><span className="badge info">{s.class}</span></td>
                <td>{s.quoted}</td>
                <td>{s.paid}</td>
                <td>{s.free}</td>
                <td>{s.blocked}</td>
                <td>{s.quoted > 0 ? `${Math.round((s.paid / s.quoted) * 100)}%` : "—"}</td>
                <td>${s.revenueUsd.toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>Recent CDRs <span className="count">(click a row for the rating trace)</span></h2>
        <table className="data-table">
          <thead>
            <tr>
              <th>ts</th><th>buyer</th><th>class</th><th>zone</th><th>path</th><th>rule</th><th>price</th><th>decision</th><th>plan</th>
            </tr>
          </thead>
          <tbody>
            {cdrs.map((c) => (
              <>
                <tr key={c.id} onClick={() => setOpenTrace(openTrace === c.id ? null : c.id)} style={{ cursor: "pointer" }}>
                  <td className="mono-dim">{c.ts.slice(11, 19)}</td>
                  <td className="mono-dim">{c.buyer_id}</td>
                  <td>{c.class}</td>
                  <td className="mono-dim">{c.zone}</td>
                  <td className="mono-dim">{c.path}</td>
                  <td>{c.selector_row}</td>
                  <td>${c.price.toFixed(4)}</td>
                  <td><span className={`badge ${decisionBadge(c.decision)}`}>{c.decision}</span></td>
                  <td className="mono-dim">v{c.plan_version}</td>
                </tr>
                {openTrace === c.id && (
                  <tr key={`${c.id}-trace`}>
                    <td colSpan={9}>
                      <div className="trace">{(JSON.parse(c.trace) as string[]).join("\n")}</div>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
