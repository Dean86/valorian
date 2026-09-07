/** The watchable demo agent — a narrated, self-paced walk through the whole
 *  economy: discover offers → browse free → get quoted → decide → pay on-chain
 *  → compare premium/archive → meet a subscribed sibling → receipt.
 *
 *  Usage:
 *    npx tsx demo/agent.ts            # paced: press ENTER between scenes (for recording)
 *    npx tsx demo/agent.ts --fast     # no pauses (for testing)
 *
 *  Pair with the console's Analytics view on a second screen — CDRs and
 *  revenue update within ~5s of each action. */

import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Heavy wallet libs load slowly from /mnt/c under WSL — boot line first,
// then dynamic imports, so the terminal never sits silent.
if (!import.meta.url.endsWith(".mjs")) {
  console.log("\x1b[2m  booting agent · loading wallet libraries (~30-60s from /mnt/c; tip: npm run demo:build once, then npm run demo:agent starts instantly)\x1b[0m");
}
const { createPublicClient, formatUnits, http, parseAbi } = await import("viem");
const { baseSepolia } = await import("viem/chains");
const { privateKeyToAccount } = await import("viem/accounts");
const { wrapFetchWithPayment } = await import("x402-fetch");

const here = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(here, "../.env"), "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const METER = process.env.METER_URL ?? "https://meridian-rating-worker.dejan-ilesic.workers.dev";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const FAST = process.argv.includes("--fast");

// ---------- presentation helpers ----------
const C = { dim: "\x1b[2m", red: "\x1b[38;5;167m", green: "\x1b[38;5;108m", amber: "\x1b[38;5;179m",
            blue: "\x1b[38;5;110m", bold: "\x1b[1m", off: "\x1b[0m" };
const say = (s = "") => console.log(s);
const think = (s: string) => say(`${C.dim}  ⋯ ${s}${C.off}`);
const act = (s: string) => say(`${C.blue}  → ${s}${C.off}`);
const good = (s: string) => say(`${C.green}  ✓ ${s}${C.off}`);
const money = (s: string) => say(`${C.red}  $ ${s}${C.off}`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
async function scene(title: string): Promise<void> {
  say();
  say(`${C.bold}${C.red}── ${title} ${"─".repeat(Math.max(2, 58 - title.length))}${C.off}`);
  if (!FAST) await new Promise<void>((res) => rl.question(`${C.dim}  [enter]${C.off}`, () => res()));
}
const pause = (ms: number) => (FAST ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)));

// ---------- the agent ----------
async function main() {
  const pk = process.env.BUYER_PRIVATE_KEY as `0x${string}`;
  const account = privateKeyToAccount(pk);
  const chain = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
  const balance = async () =>
    chain.readContract({ address: USDC, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [account.address] });
  const fmt = (v: bigint) => `$${formatUnits(v, 6)}`;
  const payingFetch = wrapFetchWithPayment(fetch, account);
  const UA = "ClaudeBot-demo/1.0 (autonomous research agent)";
  let spent = 0;
  const receipts: Array<{ what: string; usd: number; tx?: string }> = [];

  say(`${C.bold}  AGENT${C.off}  ${C.dim}wallet ${account.address} · task: "track EU dairy prices, budget $0.10"${C.off}`);
  const b0 = await balance();
  say(`${C.dim}  funds  ${fmt(b0)} test-USDC on Base Sepolia${C.off}`);

  await scene("SCENE 1 · discover the commercial catalog");
  act(`GET ${METER}/offers`);
  const offers = (await (await fetch(`${METER}/offers`)).json()) as { offers: Array<{ slug: string; name: string; charges: { monthly_usd: number }; included_allowances: Array<{ amount: number }>; usage_pricing: { by_zone: Array<{ zone: string; min_usd: number; max_usd: number }> } }> };
  for (const o of offers.offers) {
    say(`    ${C.bold}${o.name}${C.off} ${C.dim}(${o.slug})${C.off}` +
        (o.charges.monthly_usd ? ` · $${o.charges.monthly_usd}/mo` : " · no subscription") +
        (o.included_allowances[0] ? ` · ${o.included_allowances[0].amount} req/day included` : ""));
    for (const z of o.usage_pricing.by_zone.filter((z) => z.max_usd > 0))
      say(`      ${C.dim}${z.zone}: $${z.min_usd}–$${z.max_usd}/request${C.off}`);
  }
  await pause(600);
  think("low volume today → pay-per-use is optimal; at >67 req/day Market Watch would win");

  await scene("SCENE 2 · browse the free catalog");
  act("GET /v1/products  (no payment)");
  const cat = (await (await fetch(`${METER}/v1/products`, { headers: { "user-agent": UA } })).json()) as { data: Array<{ slug: string }>; meta: { count: number } };
  good(`${cat.meta.count} products, served free — discovery is the funnel`);
  await pause(400);

  await scene("SCENE 3 · ask for fresh data → the meter answers with a price");
  act("GET /v1/products/butter/prices/latest?member_state=SI");
  const q = await fetch(`${METER}/v1/products/butter/prices/latest?member_state=SI`, { headers: { "user-agent": UA } });
  const quote = (await q.json()) as { accepts: Array<{ maxAmountRequired: string }>; meridian?: { selectorRow: string; trace: string[] } };
  const priceUsd = Number(quote.accepts[0].maxAmountRequired) / 1e6;
  money(`HTTP 402 — quoted $${priceUsd} · rule: ${quote.meridian?.selectorRow}`);
  for (const t of quote.meridian?.trace ?? []) say(`      ${C.dim}${t}${C.off}`);
  await pause(600);
  think(`$${priceUsd} ≤ budget → worth it. signing payment authorization (off-chain, no gas)…`);

  await scene("SCENE 4 · pay and receive — settled on a public blockchain");
  const res = await payingFetch(`${METER}/v1/products/butter/prices/latest?member_state=SI`, { headers: { "user-agent": UA } });
  const payResp = res.headers.get("x-payment-response");
  const tx = payResp ? (JSON.parse(atob(payResp)) as { transaction?: string }).transaction : undefined;
  const data = (await res.json()) as { data: Array<{ slug: string; period_start: string; price_eur: number }> };
  good(`HTTP ${res.status} — ${data.data[0].slug}, week of ${data.data[0].period_start}: €${data.data[0].price_eur}/100kg`);
  if (tx) { money(`settled: ${tx.slice(0, 22)}…`); say(`      ${C.dim}https://sepolia.basescan.org/tx/${tx}${C.off}`); }
  spent += priceUsd; receipts.push({ what: "SI butter, fresh", usd: priceUsd, tx });
  await pause(600);

  await scene("SCENE 5 · premium costs premium, archives cost less");
  act("GET /v1/products/tolminski-sir/prices/latest   (PDO cheese — premium zone)");
  const res2 = await payingFetch(`${METER}/v1/products/tolminski-sir/prices/latest`, { headers: { "user-agent": UA } });
  const tx2 = res2.headers.get("x-payment-response") ? (JSON.parse(atob(res2.headers.get("x-payment-response")!)) as { transaction?: string }).transaction : undefined;
  const d2 = (await res2.json()) as { data: Array<{ price_eur: number }> };
  money(`premium rate $0.02 — Tolminski sir €${d2.data[0].price_eur}/100kg`);
  spent += 0.02; receipts.push({ what: "Tolminski sir (premium ×2)", usd: 0.02, tx: tx2 });
  act("GET /v1/products/butter/prices?start=2024-01-01&end=2024-03-01   (2024 archive)");
  const res3 = await payingFetch(`${METER}/v1/products/butter/prices?member_state=EU&start=2024-01-01&end=2024-03-01&limit=5`, { headers: { "user-agent": UA } });
  const tx3 = res3.headers.get("x-payment-response") ? (JSON.parse(atob(res3.headers.get("x-payment-response")!)) as { transaction?: string }).transaction : undefined;
  await res3.json();
  money("archive rate $0.002 — five 2024 observations for a fifth of a cent");
  spent += 0.002; receipts.push({ what: "2024 archive (×0.2)", usd: 0.002, tx: tx3 });
  think("same API, three prices — who I am, what I touch, how fresh it is");
  await pause(600);

  await scene("SCENE 6 · my sibling is on the Market Watch plan");
  act("same request, User-Agent: GPTBot  (subscribed to Market Watch: $20/mo, 100 req/day included)");
  const sib = await fetch(`${METER}/v1/products/butter/prices/latest?member_state=SI`, { headers: { "user-agent": "GPTBot/1.0" } });
  if (sib.status === 200) good("HTTP 200 — served FREE, allowance covers it. Same data I just paid for.");
  else say(`    ${C.amber}(sibling not subscribed right now — HTTP ${sib.status})${C.off}`);
  think("above ~67 requests/day, Market Watch beats pay-per-use. offers make agents optimize.");
  await pause(600);

  await scene("RECEIPT");
  const b1 = await balance();
  for (const r of receipts) say(`    ${r.what.padEnd(28)} $${r.usd}${r.tx ? `  ${C.dim}${r.tx.slice(0, 18)}…${C.off}` : ""}`);
  say(`    ${"total".padEnd(28)}${C.bold}$${spent.toFixed(3)}${C.off}`);
  say(`    ${C.dim}wallet ${fmt(b0)} → ${fmt(b1)} · every line has an on-chain receipt · every charge has a rating trace${C.off}`);
  say();
  rl.close();
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
