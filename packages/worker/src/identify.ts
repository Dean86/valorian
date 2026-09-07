/**
 * Caller identification — raw request → (crawler identity, verified?, buyer id).
 *
 * Honesty note: on Cloudflare's free plan we don't get verified-bot data on
 * every request. Order of trust:
 *   1. request.cf.verifiedBotCategory (present on plans with bot management)
 *   2. known crawler tokens in the user-agent (identity yes, verification no)
 *   3. demo override headers (X-SIM-VERIFIED) so the replay script can
 *      exercise both verified and unverified paths.
 * Real x402 mode will take buyer identity from the payment payload instead.
 */

export interface CallerIdentity {
  crawler: string;
  verified: boolean;
  buyerId: string;
}

const KNOWN_CRAWLER_TOKENS = [
  "gptbot", "claudebot", "google-extended", "meta-externalagent", "bytespider",
  "googlebot", "bingbot", "ccbot", "perplexitybot", "amazonbot", "applebot",
];

export function extractCrawlerToken(userAgent: string): string {
  const ua = userAgent.toLowerCase();
  for (const token of KNOWN_CRAWLER_TOKENS) {
    if (ua.includes(token)) return token;
  }
  return userAgent.slice(0, 64) || "unknown";
}

export function identifyCaller(req: Request): CallerIdentity {
  const ua = req.headers.get("user-agent") ?? "";
  const cf = (req as Request & { cf?: { verifiedBotCategory?: string } }).cf;

  const crawler = extractCrawlerToken(ua);
  const verified =
    Boolean(cf?.verifiedBotCategory) ||
    req.headers.get("x-sim-verified") === "1";

  // Buyer identity: explicit header (replay/demo) → ip+crawler fallback.
  const buyerId =
    req.headers.get("x-buyer-id") ??
    `${req.headers.get("cf-connecting-ip") ?? "local"}:${crawler}`;

  return { crawler, verified, buyerId };
}
