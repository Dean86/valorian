/**
 * Traffic replay — simulates a day of mixed crawler traffic against a running
 * worker (wrangler dev, default http://localhost:8787) in simulated-settlement
 * mode, then prints a settlement summary. This produces the demo numbers.
 *
 * Usage:
 *   npm run dev            (in packages/worker, separate terminal)
 *   npx tsx scripts/replay.ts [baseUrl] [requests]
 */

const BASE = process.argv[2] ?? "http://localhost:8787";
const TOTAL = Number(process.argv[3] ?? 300);

interface Persona {
  name: string;
  ua: string;
  verified: boolean;
  buyerId: string;
  weight: number;
  /** Probability this buyer pays a 402 quote (re-request with X-SIM-PAYMENT). */
  paysQuotes: number;
}

const PERSONAS: Persona[] = [
  { name: "OpenAI trainer", ua: "Mozilla/5.0 (compatible; GPTBot/1.2)", verified: true, buyerId: "buyer-openai", weight: 0.30, paysQuotes: 0.9 },
  { name: "Anthropic crawler", ua: "Mozilla/5.0 (compatible; ClaudeBot/1.0)", verified: true, buyerId: "buyer-anthropic", weight: 0.20, paysQuotes: 0.85 },
  { name: "Google Search", ua: "Mozilla/5.0 (compatible; Googlebot/2.1)", verified: true, buyerId: "buyer-google", weight: 0.15, paysQuotes: 0 },
  { name: "Startup agent", ua: "acme-research-agent/0.3", verified: true, buyerId: "buyer-acme", weight: 0.20, paysQuotes: 0.6 },
  { name: "Anonymous scraper", ua: "python-requests/2.31", verified: false, buyerId: "buyer-anon", weight: 0.15, paysQuotes: 0.1 },
];

const PATHS = [
  "/article/agent-web-charging",
  "/article/brm-rating-basics",
  "/article/ocs-history",
  "/api/lookup",
  "/glossary/impact-category",
];

function pick<T>(items: T[], weights?: number[]): T {
  if (!weights) return items[Math.floor(Math.random() * items.length)];
  const r = Math.random();
  let acc = 0;
  for (let i = 0; i < items.length; i++) {
    acc += weights[i];
    if (r <= acc) return items[i];
  }
  return items[items.length - 1];
}

interface Tally { requests: number; served: number; quoted: number; paid: number; blocked: number; spentUsd: number }
const tally = new Map<string, Tally>();
const t = (p: Persona): Tally => {
  let v = tally.get(p.name);
  if (!v) { v = { requests: 0, served: 0, quoted: 0, paid: 0, blocked: 0, spentUsd: 0 }; tally.set(p.name, v); }
  return v;
};

async function one(persona: Persona): Promise<void> {
  const path = pick(PATHS);
  const headers: Record<string, string> = {
    "user-agent": persona.ua,
    "x-buyer-id": persona.buyerId,
    ...(persona.verified ? { "x-sim-verified": "1" } : {}),
  };
  const s = t(persona);
  s.requests++;

  const res = await fetch(`${BASE}${path}`, { headers });
  if (res.status === 200) { s.served++; return; }
  if (res.status === 429) { s.blocked++; return; }
  if (res.status !== 402) return;

  s.quoted++;
  const body = (await res.json()) as { accepts?: { maxAmountRequired: string }[] };
  const priceUsd = Number(body.accepts?.[0]?.maxAmountRequired ?? 0) / 1e6;
  if (Math.random() > persona.paysQuotes) return; // buyer walks away

  const paidRes = await fetch(`${BASE}${path}`, { headers: { ...headers, "x-sim-payment": "paid" } });
  if (paidRes.status === 200) { s.paid++; s.served++; s.spentUsd += priceUsd; }
  else if (paidRes.status === 429) s.blocked++;
}

async function main() {
  console.log(`Replaying ${TOTAL} requests against ${BASE} ...\n`);
  const personas = PERSONAS.map((p) => p);
  const weights = PERSONAS.map((p) => p.weight);
  for (let i = 0; i < TOTAL; i++) {
    await one(pick(personas, weights));
    if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${TOTAL}`);
  }

  console.log("\n=== replay summary (client side) ===");
  const pad = (s: string | number, n: number) => String(s).padStart(n);
  console.log(`${"persona".padEnd(20)} ${pad("req", 5)} ${pad("quoted", 7)} ${pad("paid", 5)} ${pad("served", 7)} ${pad("blocked", 8)} ${pad("spent $", 9)}`);
  let spent = 0;
  for (const [name, s] of tally) {
    spent += s.spentUsd;
    console.log(`${name.padEnd(20)} ${pad(s.requests, 5)} ${pad(s.quoted, 7)} ${pad(s.paid, 5)} ${pad(s.served, 7)} ${pad(s.blocked, 8)} ${pad(s.spentUsd.toFixed(4), 9)}`);
  }
  console.log(`\ntotal simulated revenue: $${spent.toFixed(4)}`);
  console.log(`\nnow compare with the seller's view:  curl ${BASE}/meridian/stats`);
}

main().catch((e) => { console.error(e); process.exit(1); });
