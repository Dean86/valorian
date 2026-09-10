import { useEffect, useMemo, useRef, useState } from "react";
import YAML from "yaml";
import { adminToken, authed, clearAdminToken, setAdminToken } from "./api";
import { defaultPlan, validatePlan, type RatingInput, type TariffPlan } from "@meridian/rating-core";
import { MatrixView } from "./PlanEditor";
import { SimulatorView } from "./SimulatorView";
import { ClassesPanel, CustomAttrsPanel, FreshnessPanel, ZonesPanel } from "./ModelsEditor";
import { Copilot } from "./Copilot";
import { CoverageView } from "./Coverage";
import { AccountsView } from "./Accounts";
import { OffersView } from "./Offers";
import { Dashboard } from "./Dashboard";

type View = "offers" | "matrix" | "coverage" | "simulator" | "accounts" | "classes" | "zones" | "freshness" | "custom" | "copilot" | "dashboard";
type Area = "catalog" | "accounts" | "analytics";

// Three products in one shell (Clerk/Stripe pattern): the offer designer,
// account management, and operations — each with its own contextual sidebar.
const AREAS: Record<Area, { label: string; defaultView: View; groups: Array<{ group: string; items: Array<{ id: View; label: string }> }> }> = {
  catalog: {
    label: "Catalog",
    defaultView: "matrix",
    groups: [
      { group: "resources", items: [{ id: "coverage", label: "Resources" }] },
      {
        group: "design",
        items: [
          { id: "offers", label: "Offers" },
          { id: "matrix", label: "Pricing rules" },
          { id: "simulator", label: "Simulator" },
          { id: "copilot", label: "Copilot" },
        ],
      },
      {
        group: "criteria",
        items: [
          { id: "classes", label: "Agent classes" },
          { id: "zones", label: "Content zones" },
          { id: "freshness", label: "Freshness bands" },
          { id: "custom", label: "Custom attributes" },
        ],
      },
    ],
  },
  accounts: {
    label: "Accounts",
    defaultView: "accounts",
    groups: [{ group: "billing care", items: [{ id: "accounts", label: "Accounts" }] }],
  },
  analytics: {
    label: "Analytics",
    defaultView: "dashboard",
    groups: [{ group: "operations", items: [{ id: "dashboard", label: "Dashboard" }] }],
  },
};

export function App() {
  const [plan, setPlan] = useState<TariffPlan>(() => structuredClone(defaultPlan));
  const [area, setArea] = useState<Area>("catalog");
  const [view, setView] = useState<View>("matrix");
  const [simInput, setSimInput] = useState<RatingInput>({
    crawler: "GPTBot",
    verified: true,
    path: "/article/agent-web-charging",
    contentAgeDays: 2,
    buyerRequestsToday: 1,
    buyerSpendTodayUsd: 0,
  });
  const [status, setStatus] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [unlocked, setUnlocked] = useState<boolean | null>(null); // null = checking
  const [gateInput, setGateInput] = useState("");
  const [gateErr, setGateErr] = useState<string | null>(null);
  const [meterInfo, setMeterInfo] = useState<{ ok: boolean; settleMode: string } | null>(null);
  const [sets, setSets] = useState<Array<{ name: string; latest: number; is_default?: boolean }>>([]);

  useEffect(() => {
    if (!unlocked) return;
    void authed("/meridian/rulesets").then((r) => (r.ok ? r.json() : [])).then(setSets).catch(() => {});
  }, [unlocked, plan.version]);

  async function switchSet(name: string) {
    const res = await authed(`/meridian/plan?set=${encodeURIComponent(name)}`);
    const { plan: live } = validatePlan(await res.json());
    if (live) { setPlan(live); setStatus({ kind: "ok", text: `switched to ${name} v${live.version ?? 0}` }); }
  }

  async function renameSet(to: string) {
    const from = plan.plan;
    if (!to || to === from) return;
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(to)) { setStatus({ kind: "err", text: "set name must be kebab-case" }); return; }
    const res = await authed("/meridian/rulesets/rename", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from, to }),
    });
    const body = (await res.json()) as { renamed?: boolean; error?: string };
    if (res.ok && body.renamed) {
      setStatus({ kind: "ok", text: `renamed to '${to}' — versions, live copy and offers migrated` });
      await switchSet(to);
      void authed("/meridian/rulesets").then((r) => (r.ok ? r.json() : [])).then(setSets);
    } else {
      setStatus({ kind: "err", text: body.error ?? `rename failed (${res.status})` });
    }
  }

  function newSet() {
    const name = window.prompt("Name for the new pricing-rules set (kebab-case) — starts as a copy of the current set:");
    if (!name) return;
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(name)) { setStatus({ kind: "err", text: "set name must be kebab-case" }); return; }
    if (sets.some((s) => s.name === name)) { setStatus({ kind: "err", text: `set '${name}' already exists` }); return; }
    setPlan({ ...plan, plan: name, version: undefined });
    setStatus({ kind: "ok", text: `drafted new set '${name}' — tailor the rules, then publish to create it` });
  }

  useEffect(() => {
    if (unlocked === false) {
      fetch("/meridian/health").then((r) => r.json()).then(setMeterInfo).catch(() => {});
    }
  }, [unlocked]);
  const fileRef = useRef<HTMLInputElement>(null);

  async function tryUnlock(token: string): Promise<boolean> {
    setAdminToken(token);
    try {
      const res = await authed("/meridian/plan");
      if (res.status === 401) { clearAdminToken(); return false; }
      const { plan: live } = validatePlan(await res.json());
      if (live) setPlan(live);
      return true;
    } catch {
      return true; // worker unreachable (local dev) — let the console open on defaults
    }
  }

  const validation = useMemo(() => validatePlan(plan), [plan]);
  const errorCount = validation.issues.filter((i) => i.level === "error").length;

  // Gate on mount: a stored token is verified; otherwise the lock screen shows.
  useEffect(() => {
    const t = adminToken();
    if (!t) { setUnlocked(false); return; }
    void tryUnlock(t).then(setUnlocked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function publish() {
    setStatus(null);
    try {
      const res = await authed("/meridian/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(plan),
      });
      if (res.status === 401) { clearAdminToken(); setUnlocked(false); return; }
      const body = (await res.json()) as { published?: boolean; version?: number };
      if (res.ok && body.published) {
        setPlan((p) => ({ ...p, version: body.version }));
        setStatus({ kind: "ok", text: `published v${body.version}` });
      } else {
        setStatus({ kind: "err", text: `publish rejected (${res.status})` });
      }
    } catch {
      setStatus({ kind: "err", text: "worker unreachable — run `npm run dev:node`" });
    }
  }

  function exportYaml() {
    const blob = new Blob([YAML.stringify(plan)], { type: "text/yaml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${plan.plan}-v${plan.version ?? 0}.yaml`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function importYaml(file: File) {
    try {
      const parsed: unknown = YAML.parse(await file.text());
      const { plan: valid, issues } = validatePlan(parsed);
      if (!valid) {
        setStatus({ kind: "err", text: `import rejected: ${issues.find((i) => i.level === "error")?.message}` });
        return;
      }
      setPlan(valid);
      setStatus({ kind: "ok", text: `imported ${valid.plan}` });
    } catch {
      setStatus({ kind: "err", text: "import failed: not valid YAML" });
    }
  }

  if (unlocked === null) {
    return (
      <div className="gate scanlines">
        <div className="gate-glow" />
        <div className="gate-card">
          <div className="gate-mark"><span className="dot hot pulse" /> MERIDIAN <small>RATING ENGINE</small></div>
          <div className="gate-boot">checking access…</div>
        </div>
      </div>
    );
  }

  if (!unlocked) {
    return (
      <div className="gate scanlines">
        <div className="gate-glow" />
        <form
          className={`gate-card ${gateErr ? "shake" : ""}`}
          onSubmit={(e) => {
            e.preventDefault();
            setGateErr(null);
            void tryUnlock(gateInput).then((ok) => {
              if (ok) setUnlocked(true);
              else setGateErr("invalid token — access denied");
            });
          }}
        >
          <div className="gate-mark"><span className={`dot pulse ${meterInfo?.ok ? "ok" : "hot"}`} /> MERIDIAN <small>RATING ENGINE</small></div>
          <div className="gate-boot">
            <span>meter</span><span className="gate-v">{meterInfo?.ok ? "online" : "…"}</span>
            <span>settlement</span><span className="gate-v">{meterInfo?.settleMode ?? "…"}</span>
            <span>console</span><span className="gate-v hot">locked</span>
          </div>
          <p className="gate-sub">Owner console. The rate matrix, accounts and revenue live behind this line.</p>
          <div className="gate-inputrow">
            <input
              className="input gate-input"
              type="password"
              placeholder="admin token"
              value={gateInput}
              onChange={(e) => setGateInput(e.target.value)}
              autoFocus
            />
            <button className="btn primary" type="submit">unlock</button>
          </div>
          {gateErr && <p className="gate-err">{gateErr}</p>}
          <div className="gate-foot">unauthorized requests are quoted at $∞</div>
        </form>
      </div>
    );
  }

  return (
    <>
      <header className="topbar">
        <div className="wordmark">
          <span className="dot" /> MERIDIAN <small>RATING ENGINE</small>
        </div>
        <nav className="area-tabs">
          {(Object.keys(AREAS) as Area[]).map((a) => (
            <button
              key={a}
              className={`area-tab ${area === a ? "active" : ""}`}
              onClick={() => { setArea(a); setView(AREAS[a].defaultView); }}
            >
              {AREAS[a].label}
            </button>
          ))}
        </nav>

        <div className="spacer" />
        {status && <span className={`statusline ${status.kind}`}>{status.text}</span>}
        {area === "catalog" && (<>
        <button className="btn ghost" onClick={() => fileRef.current?.click()}>
          import yaml
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".yaml,.yml"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importYaml(f);
            e.target.value = "";
          }}
        />
        <button className="btn ghost" onClick={exportYaml}>
          export yaml
        </button>
        <button
          className="btn primary"
          onClick={publish}
          disabled={errorCount > 0}
          title={errorCount > 0 ? `${errorCount} validation error(s) block publish` : "publish a new plan version"}
        >
          publish
        </button>
        </>)}
      </header>

      <div className="shell">
        <nav className="sidenav">
          {AREAS[area].groups.map((g) => (
            <div key={g.group} className="navgroup">
              <div className="navgroup-label">{g.group}</div>
              {g.items.map((item) => (
                <button
                  key={item.id}
                  className={`navitem ${view === item.id ? "active" : ""}`}
                  onClick={() => setView(item.id)}
                >
                  {item.label}
                  {item.id === "matrix" && errorCount > 0 && <span className="nav-flag hot">{errorCount}</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="content">
          {view === "matrix" && (
            <MatrixView
              plan={plan}
              onChange={setPlan}
              issues={validation.issues}
              sets={sets}
              onSwitchSet={switchSet}
              onNewSet={newSet}
              onRenameSet={renameSet}
            />
          )}
          {view === "coverage" && <CoverageView plan={plan} onChange={setPlan} />}
          {view === "accounts" && <AccountsView plan={plan} />}
          {view === "offers" && <OffersView plan={plan} onPlanLoaded={setPlan} />}
          {view === "simulator" && <SimulatorView plan={plan} input={simInput} onInput={setSimInput} />}
          {view === "classes" && (
            <main className="page-narrow"><ClassesPanel plan={plan} onChange={setPlan} /></main>
          )}
          {view === "zones" && (
            <main className="page-narrow"><ZonesPanel plan={plan} onChange={setPlan} /></main>
          )}
          {view === "freshness" && (
            <main className="page-narrow"><FreshnessPanel plan={plan} onChange={setPlan} /></main>
          )}
          {view === "custom" && (
            <main className="page-narrow"><CustomAttrsPanel plan={plan} onChange={setPlan} /></main>
          )}
          {view === "copilot" && (
            <Copilot plan={plan} onApply={setPlan} goToMatrix={() => setView("matrix")} />
          )}
          {view === "dashboard" && <Dashboard />}
        </div>
      </div>
    </>
  );
}
