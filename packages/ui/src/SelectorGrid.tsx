import type { SelectorRow, TariffPlan } from "@meridian/rating-core";
import { Help } from "./Help";

/** The rate matrix — priority-ordered decision table, first match wins.
 *  Column layout: WHEN (one column per declared dimension) → CHARGE.
 *  Cell values: single value, "*" wildcard, or a value LIST (OR semantics). */
export function SelectorGrid(props: {
  plan: TariffPlan;
  onChange: (p: TariffPlan) => void;
  highlightRow?: string;
}) {
  const { plan, onChange, highlightRow } = props;
  const dims = plan.selector.dimensions;
  const rows = plan.selector.rows;

  const optionsFor = (dim: string): string[] => {
    if (dim === "class") return Object.keys(plan.models.classes);
    if (dim === "zone") return Object.keys(plan.models.zones ?? {});
    if (dim === "freshness") return (plan.models.freshness?.bands ?? []).map((b) => b.name);
    const custom = plan.models.custom?.[dim];
    if (custom) return [...custom.values, custom.default ?? "other"];
    return [];
  };

  const setRows = (next: SelectorRow[]) =>
    onChange({ ...plan, selector: { ...plan.selector, rows: next } });

  const updateRow = (i: number, patch: Partial<SelectorRow>) =>
    setRows(rows.map((r, n) => (n === i ? { ...r, ...patch } : r)));

  const setCondition = (i: number, dim: string, value: string | string[]) => {
    const row = rows[i];
    const when = { ...row.when };
    if (value === "*" || (Array.isArray(value) && value.length === 0)) delete when[dim];
    else when[dim] = value;
    updateRow(i, { when });
  };

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    setRows(next);
  };

  const rowKey = (r: SelectorRow, i: number) => r.id ?? `row:${i}`;

  // Columns are criteria: built-ins plus every defined custom attribute.
  const availableDims = ["class", "zone", "freshness", ...Object.keys(plan.models.custom ?? {})];
  const toggleDim = (d: string) => {
    const has = dims.includes(d);
    if (has && dims.length === 1) return; // rules need at least one column
    if (has) {
      const affected = rows.filter((r) => d in r.when).length;
      if (affected > 0 && !window.confirm(
        `Remove the "${d}" column? ${affected} rule${affected > 1 ? "s" : ""} condition on it — those conditions will be cleared (the rules become broader). Publish is still required to make it live.`,
      )) return;
    }
    const dimensions = has ? dims.filter((x) => x !== d) : [...dims, d];
    const nextRows = has
      ? rows.map((r) => {
          if (!(d in r.when)) return r;
          const when = { ...r.when };
          delete when[d];
          return { ...r, when };
        })
      : rows;
    onChange({ ...plan, selector: { dimensions, rows: nextRows } });
  };

  return (
    <section className="panel">
      <h2>
        Pricing rules <span className="count">({rows.length} rules · first match wins)</span>
        <Help>
          Each rule may combine conditions across dimensions (they AND together — e.g.{" "}
          <code>class=search_indexer</code> AND <code>freshness=fresh</code>). Pick{" "}
          <code>⋯ multiple</code> in a cell to match several values of one dimension (OR). Rules are
          checked top-down: put specific combinations above general rules. Toggle the column chips to
          choose which criteria the rules can price on — custom attributes defined under criteria appear
          there automatically; removing a column clears its conditions from every rule.
        </Help>
      </h2>
      <div className="dim-picker">
        <span className="dim-lbl">columns</span>
        {availableDims.map((d) => (
          <button
            key={d}
            type="button"
            className={`dim-chip ${dims.includes(d) ? "on" : ""}`}
            onClick={() => toggleDim(d)}
            title={
              dims.includes(d)
                ? dims.length === 1
                  ? "rules need at least one column"
                  : `remove — clears ${d} conditions from all rules`
                : `price on ${d}`
            }
          >
            {d}
          </button>
        ))}
      </div>
      <table className="selector-table">
        <thead>
          <tr>
            <th className="prio">#</th>
            {dims.map((d, n) => (
              <th key={d} className={n === dims.length - 1 ? "group-when" : ""}>
                when · {d}
              </th>
            ))}
            <th>charge (USD/req)</th>
            <th>rule id</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className={highlightRow !== undefined && rowKey(row, i) === highlightRow ? "hot" : ""}>
              <td className="prio">{i + 1}</td>
              {dims.map((dim, n) => {
                const value = row.when[dim] ?? "*";
                const cellClass = n === dims.length - 1 ? "when-end" : "";
                if (Array.isArray(value)) {
                  return (
                    <td key={dim} className={cellClass}>
                      <input
                        className="input"
                        title="comma-separated values (OR); clear to reset to * any"
                        value={value.join(", ")}
                        onChange={(e) =>
                          setCondition(
                            i,
                            dim,
                            e.target.value.split(",").map((x) => x.trim()).filter(Boolean),
                          )
                        }
                      />
                    </td>
                  );
                }
                return (
                  <td key={dim} className={cellClass}>
                    <select
                      className={`input ${value === "*" ? "wild" : ""}`}
                      value={value}
                      onChange={(e) => {
                        if (e.target.value === "__multi__") {
                          setCondition(i, dim, value === "*" ? optionsFor(dim).slice(0, 1) : [value]);
                        } else {
                          setCondition(i, dim, e.target.value);
                        }
                      }}
                    >
                      <option value="*">* any</option>
                      {optionsFor(dim).map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                      {value !== "*" && !optionsFor(dim).includes(value) && (
                        <option value={value}>{value} (unknown)</option>
                      )}
                      <option value="__multi__">⋯ multiple</option>
                    </select>
                  </td>
                );
              })}
              <td className="price-cell">
                <input
                  className="input num"
                  type="number"
                  step="0.0001"
                  min="0"
                  value={row.price}
                  onChange={(e) => updateRow(i, { price: Number(e.target.value) })}
                />
              </td>
              <td>
                <input
                  className="input"
                  value={row.id ?? ""}
                  placeholder={`row:${i}`}
                  onChange={(e) => updateRow(i, { id: e.target.value || undefined })}
                />
              </td>
              <td className="rowctl">
                <button title="raise priority" onClick={() => move(i, -1)}>↑</button>
                <button title="lower priority" onClick={() => move(i, 1)}>↓</button>
                <button title="delete rule" onClick={() => setRows(rows.filter((_, n) => n !== i))}>×</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        className="btn tiny mini-add"
        onClick={() => setRows([...rows, { id: `rule-${rows.length + 1}`, when: {}, price: 0.001 }])}
      >
        + add rule
      </button>
    </section>
  );
}
