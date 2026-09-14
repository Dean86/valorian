/**
 * BYOK AI copilot — proxies the owner's own model key to their chosen provider
 * and returns a validated plan. The key arrives per-request from the browser
 * and is NEVER stored or logged; proxying also sidesteps provider CORS limits.
 */

import {
  AI_RESPONSE_SCHEMA,
  RATING_KNOWLEDGE,
  aiPlanToTariff,
  validatePlan,
  type AiPlan,
  type TariffPlan,
  type ValidationIssue,
} from "@valorian/rating-core";

export interface CopilotRequest {
  provider: "anthropic" | "openai";
  apiKey: string;
  model?: string;
  baseUrl?: string;
  prompt: string;
  currentPlan: TariffPlan;
}

export interface CopilotResult {
  ok: boolean;
  explanation?: string;
  plan?: TariffPlan;
  issues?: ValidationIssue[];
  error?: string;
}

interface AiEnvelope {
  explanation: string;
  plan: AiPlan;
}

function userMessage(req: CopilotRequest): string {
  return [
    "Current plan (JSON):",
    JSON.stringify(req.currentPlan),
    "",
    "Owner's request:",
    req.prompt,
  ].join("\n");
}

async function callAnthropic(req: CopilotRequest): Promise<AiEnvelope> {
  const base = (req.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": req.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: req.model || "claude-opus-5",
      max_tokens: 16000,
      system: RATING_KNOWLEDGE,
      messages: [{ role: "user", content: userMessage(req) }],
      output_config: { format: { type: "json_schema", schema: AI_RESPONSE_SCHEMA } },
    }),
  });
  if (!res.ok) {
    const detail = await safeErrorDetail(res);
    throw new Error(`anthropic ${res.status}: ${detail}`);
  }
  const body = (await res.json()) as {
    stop_reason?: string;
    content: Array<{ type: string; text?: string }>;
  };
  if (body.stop_reason === "refusal") throw new Error("model declined the request");
  const text = body.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("empty model response");
  return JSON.parse(text) as AiEnvelope;
}

async function callOpenAi(req: CopilotRequest): Promise<AiEnvelope> {
  const base = (req.baseUrl ?? "https://api.openai.com").replace(/\/$/, "");
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${req.apiKey}`,
    },
    body: JSON.stringify({
      model: req.model || "gpt-4.1",
      messages: [
        { role: "system", content: RATING_KNOWLEDGE },
        { role: "user", content: userMessage(req) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "rate_plan_response", strict: false, schema: AI_RESPONSE_SCHEMA },
      },
    }),
  });
  if (!res.ok) {
    const detail = await safeErrorDetail(res);
    throw new Error(`provider ${res.status}: ${detail}`);
  }
  const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  const text = body.choices?.[0]?.message?.content;
  if (!text) throw new Error("empty model response");
  return JSON.parse(text) as AiEnvelope;
}

async function safeErrorDetail(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 300);
  } catch {
    return "(no detail)";
  }
}

export async function runCopilot(req: CopilotRequest): Promise<CopilotResult> {
  if (!req.apiKey) return { ok: false, error: "missing api key" };
  if (!req.prompt?.trim()) return { ok: false, error: "empty prompt" };
  try {
    const envelope = req.provider === "anthropic" ? await callAnthropic(req) : await callOpenAi(req);
    const tariff = aiPlanToTariff(envelope.plan, req.currentPlan.version);
    const { plan, issues } = validatePlan(tariff);
    return {
      ok: plan !== undefined,
      explanation: envelope.explanation,
      plan: plan ?? tariff,
      issues,
      ...(plan === undefined ? { error: "generated plan failed validation" } : {}),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "copilot failed" };
  }
}
