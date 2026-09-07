import { useEffect, useState } from "react";
import { validatePlan, type TariffPlan, type ValidationIssue } from "@meridian/rating-core";
import { SelectorGrid } from "./SelectorGrid";
import { TiersPanel } from "./ModelsEditor";
import { Help } from "./Help";
import { authed } from "./api";

/** The CATALOG → Pricing rules view: rule editing, tiers (part of the charge),
 *  validation, and the plan's version history with restore. */
export function MatrixView(props: {
  plan: TariffPlan;
  onChange: (p: TariffPlan) => void;
  issues: ValidationIssue[];
  sets?: Array<{ name: string; latest: number; is_default?: boolean }>;
  onSwitchSet?: (name: string) => void;
  onNewSet?: () => void;
  onRenameSet?: (to: string) => void;
}) {
  const { plan, onChange, issues, sets, onSwitchSet, onNewSet, onRenameSet } = props;
  const isDefault = sets?.find((s) => s.name === plan.plan)?.is_default ?? false;
  const [renaming, setRenaming] = useState(false);
  const [nameInput, setNameInput] = useState("");

  return (
    <main className="page-wide">
      {sets && onSwitchSet && (
        <section className="panel">
          <h2>
            Pricing rules set
            <Help>
              Each set is a tailored, independently versioned rule set — one per situation (standard,
              per-offer, per-partner). Offers reference a set by name; the <b>default</b> set rates
              anonymous traffic, so its name is fixed by meter config. &quot;New set&quot; drafts a copy of the
              current rules under a new name — tailor, then publish to create it.
            </Help>
          </h2>
          <div className="set-bar">
            {renaming ? (
              <>
                <input
                  className="input set-bar-select"
                  value={nameInput}
                  autoFocus
                  onChange={(e) => setNameInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { onRenameSet?.(nameInput); setRenaming(false); }
                    if (e.key === "Escape") setRenaming(false);
                  }}
                />
                <button className="btn tiny" onClick={() => { onRenameSet?.(nameInput); setRenaming(false); }}>save</button>
                <button className="btn tiny" onClick={() => setRenaming(false)}>cancel</button>
              </>
            ) : (
              <>
                <select
                  className="input set-bar-select"
                  value={plan.plan}
                  onChange={(e) => { if (e.target.value === "__new") onNewSet?.(); else onSwitchSet(e.target.value); }}
                >
                  {!sets.some((s) => s.name === plan.plan) && <option value={plan.plan}>{plan.plan} (unpublished draft)</option>}
                  {sets.map((s) => (
                    <option key={s.name} value={s.name}>
                      {s.name}{s.is_default ? " · default" : ""} (v{s.latest})
                    </option>
                  ))}
                  <option value="__new">+ new set…</option>
                </select>
                <span className="cov-sub">editing v{plan.version ?? 0}</span>
                <button className="btn tiny" onClick={() => onNewSet?.()}>+ new set</button>
                <button
                  className="btn tiny"
                  disabled={isDefault}
                  title={isDefault ? "the default set's name is fixed by meter config" : "rename this set (versions, live copy and offers migrate)"}
                  onClick={() => { setNameInput(plan.plan); setRenaming(true); }}
                >
                  rename
                </button>
              </>
            )}
          </div>
        </section>
      )}
      <SelectorGrid plan={plan} onChange={onChange} />
      <TiersPanel plan={plan} onChange={onChange} />
      <PlanVersions plan={plan} onChange={onChange} />
      {issues.length > 0 && (
        <div className="issues">
          {issues.map((i, n) => (
            <div key={n} className={`issue ${i.level}`}>
              <span className={i.level === "error" ? "hot" : "warn"}>
                {i.level === "error" ? "✕" : "!"}
              </span>
              {i.message}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

interface PlanVersion { version: number; status: string; created_at: string }

function PlanVersions({ plan, onChange }: { plan: TariffPlan; onChange: (p: TariffPlan) => void }) {
  const [versions, setVersions] = useState<PlanVersion[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = () =>
    authed(`/meridian/plans?set=${encodeURIComponent(plan.plan)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setVersions)
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [plan.version, plan.plan]);

  async function restore(version: number) {
    setBusy(version);
    setNote(null);
    try {
      const body = await authed(`/meridian/plans/${version}?set=${encodeURIComponent(plan.plan)}`).then((r) => r.json());
      const { plan: valid } = validatePlan(body);
      if (!valid) { setNote(`v${version} failed validation — not restored`); return; }
      const res = await authed("/meridian/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(valid),
      });
      const out = (await res.json()) as { published?: boolean; version?: number };
      if (res.ok && out.published) {
        setNote(`restored v${version} as v${out.version}`);
        const fresh = await authed(`/meridian/plan?set=${encodeURIComponent(plan.plan)}`).then((r) => r.json());
        const { plan: live } = validatePlan(fresh);
        if (live) onChange(live);
        void load();
      } else {
        setNote(`restore rejected (${res.status})`);
      }
    } catch {
      setNote("worker unreachable");
    } finally {
      setBusy(null);
    }
  }

  if (versions.length === 0) return null;

  const latest = versions[0]?.version ?? plan.version ?? 0;
  const editorBehind = (plan.version ?? 0) < latest;

  async function loadLive() {
    const fresh = await authed(`/meridian/plan?set=${encodeURIComponent(plan.plan)}`).then((r) => r.json());
    const { plan: live } = validatePlan(fresh);
    if (live) { onChange(live); setNote(`loaded live v${live.version}`); }
  }

  return (
    <section className="panel">
      <h2>
        Pricing rules versions <span className="count">({versions.length})</span>
        <Help>
          Every publish creates a new version of these pricing rules. Restore re-publishes an old
          version as the newest one; nothing is ever overwritten. Offers can pin themselves to a
          specific version. <b>live</b> = what the meter rates with; <b>in editor</b> = what this tab
          holds — publish always builds on the editor copy, so load live first if they diverge.
        </Help>
      </h2>
      {editorBehind && (
        <p className="help">
          ⚠ this tab is editing <b>v{plan.version ?? 0}</b> but the meter runs <b>v{latest}</b> —
          publishing now would fork from the old version.{" "}
          <button className="btn tiny" onClick={() => void loadLive()}>load live v{latest}</button>
        </p>
      )}
      {note && <p className="help">{note}</p>}
      <table className="selector-table">
        <thead><tr><th>version</th><th>status</th><th>published</th><th></th></tr></thead>
        <tbody>
          {versions.map((v) => (
            <tr key={v.version} className={v.version === latest ? "hot" : ""}>
              <td className="cov-route">v{v.version}</td>
              <td>
                <span className={`decision ${v.version === latest ? "d-paid" : "d-free"}`}>{v.version === latest ? "live" : v.status}</span>
                {v.version === plan.version && v.version !== latest && <span className="decision d-quoted"> · in editor</span>}
              </td>
              <td className="cov-sub">{v.created_at.slice(0, 16).replace("T", " ")}</td>
              <td>
                {v.version !== plan.version && (
                  <button className="btn tiny" disabled={busy !== null} onClick={() => void restore(v.version)}>
                    {busy === v.version ? "restoring…" : "restore"}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
