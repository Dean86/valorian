/** Demo buyer agent — pays for Viridian data through the Meridian meter with
 *  real x402 settlement on Base Sepolia.
 *
 *  Usage:
 *    npx tsx demo/buy.ts                              # butter /latest, GPTBot-ish UA
 *    npx tsx demo/buy.ts /v1/products/tolminski-sir/prices/latest
 *    npx tsx demo/buy.ts <path> "SomeBot/1.0"
 *
 *  Needs in .env: BUYER_PRIVATE_KEY (fund the address via faucet.circle.com,
 *  Base Sepolia USDC). Buyer needs NO ETH — the facilitator pays gas.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, formatUnits, http, parseAbi } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment } from "x402-fetch";

const here = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(here, "../.env"), "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const METER = process.env.METER_URL ?? "https://meridian-rating-worker.dejan-ilesic.workers.dev";
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const SELLER = "0x7f13Ad0cad55d13af1ca2389303108a44C5e4436";
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

async function main() {
  const path = process.argv[2] ?? "/v1/products/butter/prices/latest?member_state=SI";
  const ua = process.argv[3] ?? "GPTBot-demo/1.0 (meridian demo buyer)";
  const pk = process.env.BUYER_PRIVATE_KEY as `0x${string}` | undefined;
  if (!pk) throw new Error("BUYER_PRIVATE_KEY missing in .env");
  const account = privateKeyToAccount(pk);

  const chain = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
  const usdc = (addr: string) =>
    chain.readContract({ address: USDC_SEPOLIA, abi: ERC20, functionName: "balanceOf", args: [addr as `0x${string}`] });
  const fmt = (v: bigint) => `$${formatUnits(v, 6)}`;

  console.log(`buyer  ${account.address}`);
  const [b0, s0] = await Promise.all([usdc(account.address), usdc(SELLER)]);
  console.log(`balances before  buyer ${fmt(b0)} · seller ${fmt(s0)}`);
  if (b0 === 0n) {
    console.log("\n⚠ buyer has no testnet USDC — fund it at https://faucet.circle.com (network: Base Sepolia)");
    process.exit(2);
  }

  // First look at the quote (plain fetch, no payment) — the 402 with the rating trace
  const quoteRes = await fetch(`${METER}${path}`, { headers: { "user-agent": ua } });
  if (quoteRes.status === 402) {
    const q = (await quoteRes.json()) as { accepts: Array<{ maxAmountRequired: string }>; meridian?: { selectorRow: string; trace: string[] } };
    console.log(`\n402 quote  $${Number(q.accepts[0].maxAmountRequired) / 1e6} · row ${q.meridian?.selectorRow}`);
    for (const t of q.meridian?.trace ?? []) console.log(`   ${t}`);
  } else {
    console.log(`\nno payment required (HTTP ${quoteRes.status}) — free route for this caller`);
    console.log((await quoteRes.text()).slice(0, 300));
    return;
  }

  // Now pay: x402-fetch sees the 402, signs the authorization, retries
  console.log("\npaying …");
  const fetchWithPay = wrapFetchWithPayment(fetch, account);
  const res = await fetchWithPay(`${METER}${path}`, { headers: { "user-agent": ua } });
  console.log(`HTTP ${res.status}`);
  const payResp = res.headers.get("x-payment-response");
  if (payResp) {
    const decoded = JSON.parse(atob(payResp)) as { transaction?: string; pending?: boolean };
    console.log(`settlement  ${decoded.transaction ?? "(pending — serve-first strategy)"}`);
    if (decoded.transaction) console.log(`basescan    https://sepolia.basescan.org/tx/${decoded.transaction}`);
  }
  const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
  console.log("data       ", JSON.stringify(body.data?.[0] ?? body).slice(0, 200));

  const [b1, s1] = await Promise.all([usdc(account.address), usdc(SELLER)]);
  console.log(`\nbalances after   buyer ${fmt(b1)} (Δ ${fmt(b1 - b0)}) · seller ${fmt(s1)} (Δ +${formatUnits(s1 - s0, 6)})`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
