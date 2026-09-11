/**
 * Minimal Model Context Protocol server (Streamable HTTP / JSON-RPC 2.0).
 * MCP is the standard by which 2026 agents discover and call tools; exposing
 * Meridian as an MCP server is how a buying agent reaches the catalog, prices,
 * and the advisor. The paid data itself is still fetched over x402 HTTP — these
 * tools are the discovery + advisory surface.
 */

export const MCP_TOOLS = [
  {
    name: "browse_offers",
    description:
      "List the commercial catalog: pay-per-use and subscription offers with monthly charge, included daily allowance, per-zone price ranges and credit cap. Call this first to see what is on sale and how it is priced.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_resources",
    description:
      "List the rateable resources (data products/endpoints) with the pricing zone and the fresh per-request price of each — so you can decide what to buy.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_quote",
    description:
      "Get the current price for one resource. Provide a product slug (from list_resources). Returns the fresh per-request price and its zone.",
    inputSchema: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"], additionalProperties: false },
  },
  {
    name: "consult_advisor",
    description:
      "Describe your data need in plain language. The seller's advisor maps it to the exact resources, prices them with the rating engine, and recommends the cheapest offer plus how to call. First few consultations are free, then metered.",
    inputSchema: { type: "object", properties: { need: { type: "string" } }, required: ["need"], additionalProperties: false },
  },
] as const;

export type McpToolResult = { text: string } | { error: string };
export type McpDispatch = (name: string, args: Record<string, unknown>) => Promise<McpToolResult>;

const PROTOCOL_VERSION = "2025-06-18";

/** Handle one JSON-RPC message. Returns null body for notifications (→ 202). */
export async function handleMcp(
  bodyText: string,
  dispatch: McpDispatch,
): Promise<{ status: number; body: unknown }> {
  let msg: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } } };
  }
  const { id, method, params } = msg;
  const ok = (result: unknown) => ({ status: 200, body: { jsonrpc: "2.0", id, result } });
  const rpcErr = (code: number, message: string) => ({ status: 200, body: { jsonrpc: "2.0", id, error: { code, message } } });
  if (id === undefined) return { status: 202, body: null }; // notification

  switch (method) {
    case "initialize":
      return ok({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "meridian", version: "1.0.0" },
        instructions:
          "Meridian meters this API. Use browse_offers + list_resources to see what is sold and how it is priced, get_quote for one resource, or consult_advisor to describe a need in words. Pay for data per request via x402 (an HTTP 402 quotes the price).",
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: MCP_TOOLS });
    case "tools/call": {
      const name = params?.name as string | undefined;
      const args = (params?.arguments as Record<string, unknown>) ?? {};
      if (!name || !MCP_TOOLS.some((t) => t.name === name)) return rpcErr(-32602, `unknown tool: ${name}`);
      const r = await dispatch(name, args);
      if ("error" in r) return ok({ content: [{ type: "text", text: r.error }], isError: true });
      return ok({ content: [{ type: "text", text: r.text }] });
    }
    default:
      return rpcErr(-32601, `method not found: ${method}`);
  }
}
