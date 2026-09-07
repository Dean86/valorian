import { useMemo } from "react";
import { rate, type RatingInput, type TariffPlan } from "@meridian/rating-core";
import { Simulator } from "./Simulator";

/** The PRICING → Simulator view: test a request against the current plan.
 *  Shows a read-only snapshot of the rate matrix with the matched rule lit. */
export function SimulatorView(props: {
  plan: TariffPlan;
  input: RatingInput;
  onInput: (i: RatingInput) => void;
}) {
  const { plan, input, onInput } = props;

  const decision = useMemo(() => {
    try {
      return rate(plan, input);
    } catch {
      return undefined; // plan mid-edit can be transiently unrateable
    }
  }, [plan, input]);

  const dims = plan.selector.dimensions;
  const fmt = (v: string | string[] | undefined) =>
    v === undefined ? "*" : Array.isArray(v) ? v.join(" | ") : v;
  const rowKey = (id: string | undefined, i: number) => id ?? `row:${i}`;

  return (
    <main className="matrix-view">
      <section className="panel">
        <h2>
          Pricing rules · read-only <span className="count">(the matched rule lights up — edit in Pricing rules)</span>
        </h2>
        <table className="selector-table">
          <thead>
            <tr>
              <th className="prio">#</th>
              {dims.map((d, n) => (
                <th key={d} className={n === dims.length - 1 ? "group-when" : ""}>
                  when · {d}
                </th>
              ))}
              <th>charge</th>
              <th>rule id</th>
            </tr>
          </thead>
          <tbody>
            {plan.selector.rows.map((row, i) => (
              <tr
                key={i}
                className={
                  decision !== undefined && rowKey(row.id, i) === decision.selectorRow ? "hot" : ""
                }
              >
                <td className="prio">{i + 1}</td>
                {dims.map((dim, n) => (
                  <td key={dim} className={`${n === dims.length - 1 ? "when-end" : ""} ${row.when[dim] === undefined ? "mono-dim" : ""}`}>
                    {fmt(row.when[dim])}
                  </td>
                ))}
                <td>{row.price === 0 ? "free" : `$${row.price}`}</td>
                <td className="mono-dim">{rowKey(row.id, i)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="sim">
        <Simulator plan={plan} input={input} onInput={onInput} decision={decision} />
      </div>
    </main>
  );
}
