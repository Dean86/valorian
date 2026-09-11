/**
 * x402 boundary — building 402 challenges and checking payment.
 * Simulated mode: X-SIM-PAYMENT header (demos, tests, local dev).
 * x402 mode: real facilitator verify + settle. The buyer sends the standard
 * base64 X-PAYMENT header (as produced by x402-fetch and friends); we verify
 * the signed authorization, settle on-chain via the facilitator, and only
 * then serve. Settle-before-serve is a deliberate demo-safety choice: the
 * CDR always carries a real transaction hash at insert time.
 */

/** USDC uses 6 decimals; prices are USD floats in core, atomic units on the wire. */
export function toAtomicUsdc(priceUsd: number): string {
  return String(Math.round(priceUsd * 1e6));
}

export const USDC_BY_NETWORK: Record<string, string> = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

/** EIP-712 signing domain of the USDC contract per network — buyer and
 *  facilitator must agree on this to verify the transfer authorization. */
export const USDC_EIP712_BY_NETWORK: Record<string, { name: string; version: string }> = {
  base: { name: "USD Coin", version: "2" },
  "base-sepolia": { name: "USDC", version: "2" },
};

/** Sepolia: free community facilitator, no auth. Mainnet: CDP (needs keys). */
export function facilitatorUrl(network: string, override?: string): string {
  if (override) return override;
  return network === "base"
    ? "https://api.cdp.coinbase.com/platform/v2/x402"
    : "https://x402.org/facilitator";
}

export interface PaymentRequirement {
  scheme: "exact";
  network: string;
  maxAmountRequired: string;
  /** Full URL — client SDKs validate this as a URL, not a path. */
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  asset: string;
  maxTimeoutSeconds: number;
  /** EIP-712 domain of the asset contract (exact/EVM scheme requirement). */
  extra?: { name: string; version: string };
}

export interface X402Requirements {
  x402Version: number;
  accepts: PaymentRequirement[];
  /** Meridian extension: how the price was computed — the rating trace. */
  meridian: { plan: string; planVersion: number; selectorRow: string; trace: string[] };
}

export function buildRequirements(opts: {
  priceUsd: number;
  resource: string;
  network: string;
  payTo: string;
  plan: string;
  planVersion: number;
  selectorRow: string;
  trace: string[];
}): X402Requirements {
  return {
    x402Version: 1,
    accepts: [{
      scheme: "exact",
      network: opts.network,
      maxAmountRequired: toAtomicUsdc(opts.priceUsd),
      resource: opts.resource,
      description: `Access to ${opts.resource}`,
      mimeType: "application/json",
      payTo: opts.payTo,
      asset: USDC_BY_NETWORK[opts.network] ?? USDC_BY_NETWORK.base,
      maxTimeoutSeconds: 60,
      extra: USDC_EIP712_BY_NETWORK[opts.network] ?? USDC_EIP712_BY_NETWORK.base,
    }],
    meridian: {
      plan: opts.plan,
      planVersion: opts.planVersion,
      selectorRow: opts.selectorRow,
      trace: opts.trace,
    },
  };
}

export type PaymentCheck =
  | { paid: true; mode: "simulated" | "x402"; txRef: string }
  | { paid: false };

/**
 * Simulated-mode payment check: `X-SIM-PAYMENT: paid` (optionally X-SIM-TX).
 * In x402 mode this always says unpaid — the real flow is verifyPayment +
 * settlePayment below, orchestrated by the pipeline per SETTLE_STRATEGY.
 */
export function checkPayment(req: Request, settleMode: string): PaymentCheck {
  if (settleMode === "simulated" && req.headers.get("x-sim-payment") === "paid") {
    return { paid: true, mode: "simulated", txRef: req.headers.get("x-sim-tx") ?? `sim-${crypto.randomUUID()}` };
  }
  return { paid: false };
}

// ---- real x402: reserve (verify) and commit (settle), separated so the
// ---- pipeline can choose settle-first (safety) or serve-first (latency).

export interface FacilitatorOpts {
  requirement: PaymentRequirement;
  facilitator: string;
}

type FacilitatorBody = { x402Version: 1; paymentPayload: unknown; paymentRequirements: PaymentRequirement };

function facilitatorPost(path: string, opts: FacilitatorOpts, paymentPayload: unknown): Promise<Response> {
  const body: FacilitatorBody = { x402Version: 1, paymentPayload, paymentRequirements: opts.requirement };
  return fetch(`${opts.facilitator}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export type VerifyResult =
  | { ok: true; paymentPayload: unknown; payer?: string }
  | { ok: false; reason?: string };

/** Decode X-PAYMENT and ask the facilitator whether it is valid & funded. */
export async function verifyPayment(req: Request, opts: FacilitatorOpts): Promise<VerifyResult> {
  const header = req.headers.get("x-payment");
  if (!header) return { ok: false };
  if (header.length > 8192) return { ok: false, reason: "oversized X-PAYMENT header" };
  let paymentPayload: unknown;
  try {
    paymentPayload = JSON.parse(atob(header));
  } catch {
    return { ok: false, reason: "malformed X-PAYMENT header" };
  }
  // Shape pre-check: reject obvious junk locally so garbage headers never reach
  // (and never rate-limit us at) the facilitator.
  if (typeof paymentPayload !== "object" || paymentPayload === null || !("payload" in (paymentPayload as object))) {
    return { ok: false, reason: "malformed payment payload" };
  }
  const res = await facilitatorPost("/verify", opts, paymentPayload);
  if (!res.ok) return { ok: false, reason: `facilitator verify ${res.status}` };
  const verify = (await res.json()) as { isValid: boolean; invalidReason?: string; payer?: string };
  if (!verify.isValid) return { ok: false, reason: verify.invalidReason ?? "invalid payment" };
  return { ok: true, paymentPayload, payer: verify.payer };
}

export type SettleResult =
  | { ok: true; txRef: string; payer?: string; responseHeader: string }
  | { ok: false; reason: string };

/** Execute the signed transfer on-chain via the facilitator. */
export async function settlePayment(paymentPayload: unknown, opts: FacilitatorOpts): Promise<SettleResult> {
  const res = await facilitatorPost("/settle", opts, paymentPayload);
  if (!res.ok) return { ok: false, reason: `facilitator settle ${res.status}` };
  const settle = (await res.json()) as {
    success: boolean;
    transaction?: string;
    network?: string;
    payer?: string;
    errorReason?: string;
  };
  if (!settle.success || !settle.transaction) {
    return { ok: false, reason: settle.errorReason ?? "settlement failed" };
  }
  return {
    ok: true,
    txRef: settle.transaction,
    payer: settle.payer,
    responseHeader: btoa(JSON.stringify({ success: true, transaction: settle.transaction, network: settle.network })),
  };
}
