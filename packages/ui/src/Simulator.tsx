import type { RatingDecision, RatingInput, TariffPlan } from "@meridian/rating-core";

const QUICK_CRAWLERS: Array<{ label: string; crawler: string; verified: boolean }> = [
  { label: "GPTBot", crawler: "GPTBot", verified: true },
  { label: "ClaudeBot", crawler: "ClaudeBot", verified: true },
  { label: "Googlebot", crawler: "Googlebot", verified: true },
  { label: "startup agent", crawler: "acme-research-agent/0.3", verified: true },
  { label: "anon scraper", crawler: "python-requests/2.31", verified: false },
];

export function Simulator(props: {
  plan: TariffPlan;
  input: RatingInput;
  onInput: (i: RatingInput) => void;
  decision?: RatingDecision;
}) {
  const { plan, input, onInput, decision } = props;
  const set = (patch: Partial<RatingInput>) => onInput({ ...input, ...patch });

  return (
    <section className="panel">
      <h2>Simulator · live</h2>

      <label className="lbl">crawler / user-agent</label>
      <input className="input" value={input.crawler} onChange={(e) => set({ crawler: e.target.value })} />
      <div className="quick">
        {QUICK_CRAWLERS.map((q) => (
          <button
            key={q.label}
            className="btn tiny"
            onClick={() => set({ crawler: q.crawler, verified: q.verified })}
          >
            {q.label}
          </button>
        ))}
      </div>

      <label className="lbl">
        <input
          type="checkbox"
          checked={input.verified}
          onChange={(e) => set({ verified: e.target.checked })}
        />{" "}
        identity verified (web bot auth)
      </label>

      <label className="lbl">path</label>
      <input className="input" value={input.path} onChange={(e) => set({ path: e.target.value })} />

      <label className="lbl">content age (days)</label>
      <input
        className="input num"
        type="number"
        min="0"
        value={input.contentAgeDays}
        onChange={(e) => set({ contentAgeDays: Number(e.target.value) })}
      />

      <label className="lbl">buyer requests today</label>
      <input
        className="input num"
        type="number"
        min="0"
        value={input.buyerRequestsToday}
        onChange={(e) => set({ buyerRequestsToday: Number(e.target.value) })}
      />

      {Object.entries(plan.models.custom ?? {}).map(([name, def]) => (
        <div key={name}>
          <label className="lbl">{name} (custom · header {def.source.name})</label>
          <select
            className="input"
            value={input.custom?.[name] ?? ""}
            onChange={(e) => {
              const next = { ...(input.custom ?? {}) };
              if (e.target.value === "") delete next[name];
              else next[name] = e.target.value;
              set({ custom: next });
            }}
          >
            <option value="">(header absent)</option>
            {def.values.map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </div>
      ))}

      <label className="lbl">buyer spend today (USD)</label>
      <input
        className="input num"
        type="number"
        min="0"
        step="0.01"
        value={input.buyerSpendTodayUsd}
        onChange={(e) => set({ buyerSpendTodayUsd: Number(e.target.value) })}
      />

      <div className="sim-result">
        {decision ? (
          <>
            <div className="sim-price">
              {decision.blocked ? (
                <span className="hot">BLOCKED</span>
              ) : decision.free ? (
                <span className="ok">FREE</span>
              ) : (
                <>
                  ${decision.price.toFixed(4)}
                  <span className="cur">{decision.currency}/request</span>
                </>
              )}
            </div>
            <div className="sim-attrs">
              <span className="badge info">class: {decision.attributes.class}</span>
              <span className="badge info">zone: {decision.attributes.zone}</span>
              <span className="badge info">freshness: {decision.attributes.freshness}</span>
              <span className={`badge ${decision.blocked ? "hot" : "ok"}`}>rule: {decision.selectorRow}</span>
            </div>
            <div className="trace">
              <span className="tag">rating trace · plan v{plan.version ?? 0}</span>
              {"\n"}
              {decision.trace.join("\n")}
            </div>
          </>
        ) : (
          <div className="hint">plan is mid-edit — fix validation errors to rate</div>
        )}
      </div>
    </section>
  );
}
