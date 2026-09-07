/**
 * Node dev server — the same Meridian worker app served via @hono/node-server,
 * with SQLite-backed D1 and in-memory KV. No Cloudflare account needed.
 *
 * Run (from packages/worker):  npm run dev:node
 * Then in another terminal:    npm run replay   (repo root)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import app, { type Env } from "./index";
import { MemoryKV, SqliteD1 } from "./node-shims";

const here = dirname(fileURLToPath(import.meta.url));

const db = new SqliteD1(process.env.MERIDIAN_DB ?? ":memory:");
db.exec(readFileSync(join(here, "../schema.sql"), "utf8"));

const env: Env = {
  DB: db as unknown as Env["DB"],
  PLANS: new MemoryKV() as unknown as Env["PLANS"],
  SETTLE_MODE: process.env.SETTLE_MODE ?? "simulated",
  PAY_TO: process.env.PAY_TO ?? "0x0000000000000000000000000000000000000000",
  NETWORK: process.env.NETWORK ?? "base",
  ORIGIN: process.env.ORIGIN,
  DEFAULT_AGE_DAYS: process.env.DEFAULT_AGE_DAYS,
  ADMIN_TOKEN: process.env.ADMIN_TOKEN,
};

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: (req) => app.fetch(req, env), port });
console.log(`meridian rating worker (node dev) → http://localhost:${port}`);
console.log(`  settle mode: ${env.SETTLE_MODE} | plan: default (KV empty → bundled)`);
console.log(`  try: curl -i http://localhost:${port}/article/agent-web-charging -H "User-Agent: GPTBot" -H "X-Sim-Verified: 1"`);
