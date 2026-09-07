import type { TariffPlan } from "@meridian/rating-core";
import { Help } from "./Help";

/** Reference-data panels — one per catalog section, routed from the sidenav. */

interface PanelProps {
  plan: TariffPlan;
  onChange: (p: TariffPlan) => void;
}

/** Rename a record key while preserving declaration order (order = match priority). */
function renameKey<T>(obj: Record<string, T>, from: string, to: string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(obj)) out[k === from ? to : k] = v;
  return out;
}

const csv = (list: string[]) => list.join(", ");
const parseCsv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

export function ClassesPanel({ plan, onChange }: PanelProps) {
  const classes = plan.models.classes;
  const setClasses = (next: typeof classes) =>
    onChange({ ...plan, models: { ...plan.models, classes: next } });

  return (
    <section className="panel">
      <h2>
        Agent classes <span className="count">({Object.keys(classes).length})</span>
        <Help>
          Group callers by identity. Matchers are identity tokens (e.g. <code>gptbot</code>),{" "}
          <code>verified:*</code> for any verified bot, or <code>*</code> as catch-all. Declaration order
          is match priority.
        </Help>
      </h2>
      {Object.entries(classes).map(([name, cls]) => (
        <div className="model-row" key={name}>
          <input
            className="input"
            value={name}
            onChange={(e) => setClasses(renameKey(classes, name, e.target.value))}
          />
          <input
            className="input"
            title="comma-separated matchers"
            value={csv(cls.match)}
            onChange={(e) => setClasses({ ...classes, [name]: { match: parseCsv(e.target.value) } })}
          />
          <button
            className="del"
            title="remove class"
            onClick={() => {
              const next = { ...classes };
              delete next[name];
              setClasses(next);
            }}
          >
            ×
          </button>
        </div>
      ))}
      <button
        className="btn tiny mini-add"
        onClick={() => setClasses({ ...classes, [`class_${Object.keys(classes).length + 1}`]: { match: [] } })}
      >
        + class
      </button>
    </section>
  );
}

export function ZonesPanel({ plan, onChange }: PanelProps) {
  const zones = plan.models.zones ?? {};
  const setZones = (next: typeof zones) =>
    onChange({ ...plan, models: { ...plan.models, zones: next } });

  return (
    <section className="panel">
      <h2>
        Content zones <span className="count">({Object.keys(zones).length})</span>
        <Help>
          Group URLs into named zones (a zone model over paths). Patterns: <code>/api/*</code> prefix,
          exact paths, or <code>*</code> catch-all. First matching zone wins.
        </Help>
      </h2>
      {Object.entries(zones).map(([name, patterns]) => (
        <div className="model-row" key={name}>
          <input
            className="input"
            value={name}
            onChange={(e) => setZones(renameKey(zones, name, e.target.value))}
          />
          <input
            className="input"
            title="comma-separated path patterns"
            value={csv(patterns)}
            onChange={(e) => setZones({ ...zones, [name]: parseCsv(e.target.value) })}
          />
          <button
            className="del"
            title="remove zone"
            onClick={() => {
              const next = { ...zones };
              delete next[name];
              setZones(next);
            }}
          >
            ×
          </button>
        </div>
      ))}
      <button
        className="btn tiny mini-add"
        onClick={() => setZones({ ...zones, [`zone_${Object.keys(zones).length + 1}`]: [] })}
      >
        + zone
      </button>
    </section>
  );
}

export function FreshnessPanel({ plan, onChange }: PanelProps) {
  const bands = plan.models.freshness?.bands ?? [];
  const setBands = (next: typeof bands) =>
    onChange({ ...plan, models: { ...plan.models, freshness: { bands: next } } });

  return (
    <section className="panel">
      <h2>
        Freshness bands <span className="count">({bands.length})</span>
        <Help>
          Content-age brackets (the time-model analog): ascending max age in days; leave the last band's
          age empty to make it terminal (archive).
        </Help>
      </h2>
      {bands.map((b, i) => (
        <div className="model-row" key={i}>
          <input
            className="input"
            value={b.name}
            onChange={(e) => setBands(bands.map((x, n) => (n === i ? { ...x, name: e.target.value } : x)))}
          />
          <input
            className="input num"
            placeholder="terminal"
            title="max content age in days; empty = terminal band"
            value={b.max_age_days ?? ""}
            onChange={(e) => {
              const v = e.target.value === "" ? undefined : Number(e.target.value);
              setBands(
                bands.map((x, n) =>
                  n === i ? { name: x.name, ...(v !== undefined ? { max_age_days: v } : {}) } : x,
                ),
              );
            }}
          />
          <button className="del" title="remove band" onClick={() => setBands(bands.filter((_, n) => n !== i))}>
            ×
          </button>
        </div>
      ))}
      <button
        className="btn tiny mini-add"
        onClick={() => setBands([...bands, { name: `band_${bands.length + 1}` }])}
      >
        + band
      </button>
    </section>
  );
}

export function TiersPanel({ plan, onChange }: PanelProps) {
  const tiers = plan.tiers ?? [];
  const set = (patch: Partial<TariffPlan>) => onChange({ ...plan, ...patch });

  return (
    <section className="panel">
      <h2>Volume tiers &amp; default credit cap
        <Help>
          Tiers multiply the matched price by the buyer's request count today (ascending; leave the last
          tier's threshold empty). The credit cap here is the DEFAULT for anonymous pay-per-use traffic — offers can carry their own cap, which overrides it.
        </Help>
      </h2>
      {tiers.map((t, i) => (
        <div className="model-row" key={i}>
          <input
            className="input num"
            placeholder="∞"
            title="applies while buyer's requests today <= this; empty = top tier"
            value={t.up_to ?? ""}
            onChange={(e) => {
              const v = e.target.value === "" ? undefined : Number(e.target.value);
              set({
                tiers: tiers.map((x, n) =>
                  n === i ? { ...(v !== undefined ? { up_to: v } : {}), multiplier: x.multiplier } : x,
                ),
              });
            }}
          />
          <input
            className="input num"
            title="price multiplier"
            value={t.multiplier}
            onChange={(e) =>
              set({ tiers: tiers.map((x, n) => (n === i ? { ...x, multiplier: Number(e.target.value) } : x)) })
            }
          />
          <button className="del" title="remove tier" onClick={() => set({ tiers: tiers.filter((_, n) => n !== i) })}>
            ×
          </button>
        </div>
      ))}
      <button className="btn tiny mini-add" onClick={() => set({ tiers: [...tiers, { multiplier: 1 }] })}>
        + tier
      </button>
      <label className="lbl">default daily credit cap per buyer (USD) — anonymous traffic</label>
      <input
        className="input num"
        placeholder="no cap"
        value={plan.caps?.per_buyer_daily_usd ?? ""}
        onChange={(e) => set({ caps: e.target.value === "" ? {} : { per_buyer_daily_usd: Number(e.target.value) } })}
      />
    </section>
  );
}

export function CustomAttrsPanel({ plan, onChange }: PanelProps) {
  const custom = plan.models.custom ?? {};
  const setCustom = (next: typeof custom) =>
    onChange({
      ...plan,
      models: { ...plan.models, ...(Object.keys(next).length > 0 ? { custom: next } : { custom: undefined }) },
    });

  return (
    <section className="panel">
      <h2>
        Custom attributes <span className="count">({Object.keys(custom).length})</span>
        <Help>
          Owner-defined reference objects — extra dimensions for the pricing rules with their own value
          catalogs. The value resolves from an HTTP header on each request (e.g. attribute{" "}
          <code>channel</code> from header <code>X-Channel</code>); anything outside the value list falls
          back to the default. After adding one here, add its name to the rule dimensions to price on it.
        </Help>
      </h2>
      {Object.entries(custom).map(([name, def]) => (
        <div key={name} style={{ borderTop: "1px solid var(--line-1)", paddingTop: 8, marginTop: 8 }}>
          <div className="model-row">
            <input
              className="input"
              title="attribute name (becomes a matrix dimension)"
              value={name}
              onChange={(e) => setCustom(renameKey(custom, name, e.target.value))}
            />
            <input
              className="input"
              title="allowed values, comma-separated (lowercase)"
              value={csv(def.values)}
              onChange={(e) => setCustom({ ...custom, [name]: { ...def, values: parseCsv(e.target.value) } })}
            />
            <button
              className="del"
              title="remove attribute"
              onClick={() => {
                const next = { ...custom };
                delete next[name];
                setCustom(next);
              }}
            >
              ×
            </button>
          </div>
          <div className="model-row">
            <input
              className="input"
              title="source header, e.g. X-Channel"
              placeholder="X-Header-Name"
              value={def.source.name}
              onChange={(e) =>
                setCustom({ ...custom, [name]: { ...def, source: { type: "header", name: e.target.value } } })
              }
            />
            <input
              className="input"
              title='fallback value when the header is missing/unknown (default: "other")'
              placeholder="other"
              value={def.default ?? ""}
              onChange={(e) =>
                setCustom({
                  ...custom,
                  [name]: { ...def, ...(e.target.value ? { default: e.target.value } : { default: undefined }) },
                })
              }
            />
            <span />
          </div>
        </div>
      ))}
      <button
        className="btn tiny mini-add"
        onClick={() =>
          setCustom({
            ...custom,
            [`attr_${Object.keys(custom).length + 1}`]: {
              values: [],
              source: { type: "header", name: "X-Attr" },
            },
          })
        }
      >
        + custom attribute
      </button>
    </section>
  );
}
