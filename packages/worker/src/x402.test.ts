import { describe, expect, it } from "vitest";
import { buildRequirements, checkPayment, toAtomicUsdc } from "./x402";

describe("toAtomicUsdc", () => {
  it("converts USD to 6-decimal atomic units", () => {
    expect(toAtomicUsdc(0.001)).toBe("1000");
    expect(toAtomicUsdc(0.05)).toBe("50000");
    expect(toAtomicUsdc(1)).toBe("1000000");
  });
});

describe("buildRequirements", () => {
  it("emits a valid x402 'exact' challenge with the Meridian rating extension", () => {
    const r = buildRequirements({
      priceUsd: 0.05,
      resource: "https://meter.test/article/x",
      network: "base",
      payTo: "0xabc",
      plan: "default",
      planVersion: 3,
      selectorRow: "lab-fresh",
      trace: ["resolve: ...", "selector: matched lab-fresh"],
    });
    expect(r.x402Version).toBe(1);
    expect(r.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "base",
      maxAmountRequired: "50000",
      payTo: "0xabc",
      resource: "https://meter.test/article/x",
    });
    expect(r.meridian.planVersion).toBe(3);
    expect(r.meridian.selectorRow).toBe("lab-fresh");
  });
});

describe("checkPayment", () => {
  const req = (headers: Record<string, string> = {}) =>
    new Request("https://x.test/", { headers });

  it("accepts simulated payment only in simulated mode", () => {
    expect(checkPayment(req({ "x-sim-payment": "paid" }), "simulated").paid).toBe(true);
    expect(checkPayment(req({ "x-sim-payment": "paid" }), "x402").paid).toBe(false);
    expect(checkPayment(req(), "simulated").paid).toBe(false);
  });

  it("carries the simulated tx reference through", () => {
    const res = checkPayment(req({ "x-sim-payment": "paid", "x-sim-tx": "tx-42" }), "simulated");
    expect(res).toMatchObject({ paid: true, txRef: "tx-42" });
  });
});
