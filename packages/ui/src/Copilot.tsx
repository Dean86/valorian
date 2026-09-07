import { useState } from "react";
import { Help } from "./Help";
import { authed } from "./api";
import type { TariffPlan, ValidationIssue } from "@meridian/rating-core";

/** BYOK AI copilot — bring your own model key; the key lives in this browser
 *  (localStorage) and passes through the worker per-request, never stored. */

interface CopilotResult {
  ok: boolean;
  explanation?: string;
  plan?: TariffPlan;
  issues?: ValidationIssue[];
  error?: string;
}

interface Settings {
  provider: "anthropic" | "openai";
  apiKey: string;
  model: string;
  baseUrl: string;
}

const LS_KEY = "meridian.copilot";

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw) as Settings;
  } catch {
    /* fall through */
  }
  return { provider: "anthropic", apiKey: "", model: "claude-opus-5", baseUrl: "" };
}

const EXAMPLES = [
  "Create a plan for a tech news site: search engines free, frontier labs pay a premium on articles newer than a week, everything else cheap.",
  "Double all prices for unverified traffic and add a $2 daily cap per buyer.",
  "Add a zone for /docs/* priced at a quarter of the default.",
];

export function Copilot(props: {
  plan: TariffPlan;
  onApply: (p: TariffPlan) => void;
  goToMatrix: () => void;
}) {
  const { plan, onApply, goToMatrix } = props;
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CopilotResult | null>(null);

  const saveSettings = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    localStorage.setItem(LS_KEY, JSON.stringify(next));
  };

  async function generate() {
    setBusy(true);
    setResult(null);
    try {
      const res = await authed("/meridian/ai/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: settings.provider,
          apiKey: settings.apiKey,
          model: settings.model || undefined,
          baseUrl: settings.baseUrl || undefined,
          prompt,
          currentPlan: plan,
        }),
      });
      setResult((await res.json()) as CopilotResult);
    } catch {
      setResult({ ok: false, error: "worker unreachable — run `npm run dev:node`" });
    } finally {
      setBusy(false);
    }
  }

  const errorIssues = result?.issues?.filter((i) => i.level === "error") ?? [];

  return (
    <main className="page-narrow">
      <section className="panel">
        <h2>AI copilot · bring your own key
          <Help>
            Describe your pricing in plain language — the model drafts the full rate plan using
            Meridian's built-in charging knowledge. Your key stays in this browser and is passed through
            per request, never stored.
          </Help>
        </h2>

        <div className="copilot-settings">
          <div>
            <label className="lbl">provider</label>
            <select
              className="input"
              value={settings.provider}
              onChange={(e) => {
                const provider = e.target.value as Settings["provider"];
                saveSettings({
                  provider,
                  model: provider === "anthropic" ? "claude-opus-5" : "gpt-4.1",
                  baseUrl: "",
                });
              }}
            >
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI-compatible</option>
            </select>
          </div>
          <div>
            <label className="lbl">model</label>
            <input
              className="input"
              value={settings.model}
              onChange={(e) => saveSettings({ model: e.target.value })}
            />
          </div>
          <div>
            <label className="lbl">base url (optional — local/self-hosted)</label>
            <input
              className="input"
              placeholder={settings.provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com"}
              value={settings.baseUrl}
              onChange={(e) => saveSettings({ baseUrl: e.target.value })}
            />
          </div>
          <div>
            <label className="lbl">api key</label>
            <input
              className="input"
              type="password"
              placeholder="sk-…"
              value={settings.apiKey}
              onChange={(e) => saveSettings({ apiKey: e.target.value })}
            />
          </div>
        </div>

        <label className="lbl">what should the rate plan do?</label>
        <textarea
          className="input"
          rows={4}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={EXAMPLES[0]}
        />
        <div className="quick">
          {EXAMPLES.map((ex, i) => (
            <button key={i} className="btn tiny" onClick={() => setPrompt(ex)} title={ex}>
              example {i + 1}
            </button>
          ))}
        </div>

        <div style={{ marginTop: 12 }}>
          <button className="btn primary" onClick={generate} disabled={busy || !settings.apiKey || !prompt.trim()}>
            {busy ? "generating…" : "generate plan"}
          </button>
        </div>
      </section>

      {result && (
        <section className="panel">
          <h2>Result</h2>
          {result.error && !result.plan && <div className="issue error">✕ {result.error}</div>}
          {result.explanation && <p className="help">{result.explanation}</p>}
          {result.issues && result.issues.length > 0 && (
            <div className="issues">
              {result.issues.map((i, n) => (
                <div key={n} className={`issue ${i.level}`}>
                  {i.level === "error" ? "✕" : "!"} {i.message}
                </div>
              ))}
            </div>
          )}
          {result.plan && (
            <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
              <button
                className="btn primary"
                disabled={errorIssues.length > 0}
                title={errorIssues.length > 0 ? "generated plan has validation errors" : "load into the editor (not yet published)"}
                onClick={() => {
                  onApply(result.plan!);
                  goToMatrix();
                }}
              >
                apply to editor
              </button>
              <span className="statusline">
                {result.plan.selector.rows.length} rules · {Object.keys(result.plan.models.classes).length} classes —
                review in the rate matrix, then publish
              </span>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
