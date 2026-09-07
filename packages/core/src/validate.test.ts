import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { validatePlan } from "./validate";
import { defaultPlan } from "./defaultPlan";

const here = dirname(fileURLToPath(import.meta.url));

describe("validatePlan", () => {
  it("accepts the default plan with no errors", () => {
    const { plan, issues } = validatePlan(defaultPlan);
    expect(plan).toBeDefined();
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
  });

  it("warns when the selector has no catch-all row", () => {
    const { issues } = validatePlan({
      ...defaultPlan,
      selector: { dimensions: ["class"], rows: [{ when: { class: "frontier_lab" }, price: 0.01 }] },
    });
    expect(issues.some((i) => i.level === "warning" && i.message.includes("catch-all"))).toBe(true);
  });

  it("rejects a selector row referencing an unknown class", () => {
    const { plan, issues } = validatePlan({
      ...defaultPlan,
      selector: { dimensions: ["class"], rows: [{ when: { class: "nope" }, price: 1 }, { when: {}, price: 0 }] },
    });
    expect(plan).toBeUndefined();
    expect(issues.some((i) => i.level === "error" && i.message.includes('"nope"'))).toBe(true);
  });

  it("rejects conditions on undeclared dimensions and bad prices", () => {
    const { issues } = validatePlan({
      ...defaultPlan,
      selector: { dimensions: ["class"], rows: [{ when: { zone: "api" }, price: -1 }, { when: {}, price: 0 }] },
    });
    expect(issues.some((i) => i.message.includes("not a declared dimension"))).toBe(true);
    expect(issues.some((i) => i.message.includes("invalid price"))).toBe(true);
  });

  it("rejects out-of-order tiers and freshness bands", () => {
    const { issues } = validatePlan({
      ...defaultPlan,
      models: {
        ...defaultPlan.models,
        freshness: { bands: [{ name: "a", max_age_days: 90 }, { name: "b", max_age_days: 7 }, { name: "c" }] },
      },
      tiers: [{ up_to: 100, multiplier: 1 }, { up_to: 50, multiplier: 2 }],
    });
    expect(issues.some((i) => i.message.includes("freshness bands out of order"))).toBe(true);
    expect(issues.some((i) => i.message.includes("increasing up_to"))).toBe(true);
  });

  it("rejects duplicate row ids", () => {
    const { issues } = validatePlan({
      ...defaultPlan,
      selector: {
        dimensions: ["class"],
        rows: [{ id: "x", when: {}, price: 1 }, { id: "x", when: {}, price: 2 }],
      },
    });
    expect(issues.some((i) => i.message.includes("duplicate rule id"))).toBe(true);
  });
});

describe("tariffs/default.yaml lockstep", () => {
  it("matches defaultPlan exactly", () => {
    const yamlPath = join(here, "../../../tariffs/default.yaml");
    const fromYaml = parse(readFileSync(yamlPath, "utf8"));
    expect(fromYaml).toEqual(defaultPlan);
  });

  it("the YAML itself validates clean", () => {
    const yamlPath = join(here, "../../../tariffs/default.yaml");
    const { issues } = validatePlan(parse(readFileSync(yamlPath, "utf8")));
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
  });
});
