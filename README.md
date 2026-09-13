# Meridian: a rating engine for machine traffic

Cloudflare's pay-per-crawl charges every AI crawler one flat price. Meridian is
the layer that was left out: **a metering and rating engine you put in front of
your own API or content**, pricing each request by *who's asking, what they're
touching, and how fresh it is*, settled per request over the
[x402](https://x402.org) protocol, straight to your wallet.

Think of it as an OCS (online charging system) for the agent economy, small
enough for one person to run:

- **Pricing rules:** a priority-ordered decision table over criteria you
  define: agent classes, content zones, freshness bands, custom attributes
  from headers. Tailored, named rule sets; every publish versioned, one-click
  restore.
- **Offers:** the commercial catalog above the rules: pay-per-use,
  subscriptions with included daily allowances (enforced live), per-offer
  credit caps. Published offers are machine-readable at public `GET /offers`
  so agents can shop.
- **Real settlement:** HTTP 402 quotes, facilitator verify/settle
  (reserve/commit), USDC on Base, transaction hash in every charge record.
  Testnet by default; mainnet is two config values.
- **Billing care:** every request becomes a rated event (a CDR): matched
  rule, price, payer wallet, on-chain reference. Accounts with statements,
  purchases, conversion. An analytics dashboard with live wallet balances and
  a flat-vs-rated revenue comparison.
- **Owner console:** token-gated web console (served by the worker itself)
  for all of the above. Your rating logic stays private; agents only ever see
  prices.

Runs as a single Cloudflare Worker (free tier is plenty) with D1 + KV.
No servers, no database to manage, no card on file. Self-hosting on plain
Node works too; the code is portable Hono.

**You don't migrate your API. You wrap it in place.** Meridian sits in front
of any origin you name in `ORIGIN`; your existing API stays exactly where it
lives. Point your public traffic at the meter, keep the origin as the private
backend. To stop callers reaching the origin directly and skipping payment,
pick a rung by how much you can touch the origin:

- **Header check (strongest, tiny origin change):** the meter stamps every
  proxied request with a shared secret (`ORIGIN_KEY`); the origin rejects
  metered routes without it. One middleware; copy-paste snippets in
  [ARCHITECTURE.md](./ARCHITECTURE.md).
- **No origin change:** put the origin behind an allowlist / Cloudflare Access
  so only the meter's egress reaches it, or on an unguessable hostname, or, if
  the origin is itself a Worker, a service binding with no public route.

## Quickstart (~10 minutes)

```bash
git clone <this repo> && cd rating-engine
npm install

# auth: either `npx wrangler login`, or export CLOUDFLARE_API_TOKEN
# (dashboard → My Profile → API Tokens → "Edit Cloudflare Workers" template
#  + add permission Account → D1 → Edit)

./scripts/setup.sh          # provisions D1+KV, schema, admin token, deploys
```

Then point it at *your* API: edit `packages/worker/wrangler.toml`

```toml
ORIGIN = "https://api.your-thing.example"   # what the meter fronts
PAY_TO = "0xYourWallet"                     # where USDC lands
NETWORK = "base-sepolia"                    # testnet; "base" for real money
```

redeploy (`cd packages/worker && npx wrangler deploy`), open your worker URL,
unlock with the admin token from setup, and design your pricing. Publish, and
the next request rates under it. If your origin serves an OpenAPI spec at
`/openapi.json`, the **Resources** view maps everything rateable
automatically.

To watch an agent actually pay: `npm run demo:build` once, fund the printed
buyer wallet with test USDC at [faucet.circle.com](https://faucet.circle.com)
(Base Sepolia), then `npm run demo:agent`.

## How a request flows

```
agent → GET /your/route
      → identify (UA / wallet) → resolve class·zone·freshness
      → pricing rules: first match wins → price
      → free? serve · priced? HTTP 402 quote (price, payTo, USDC asset)
      → agent signs, retries with X-PAYMENT
      → facilitator /verify (reserve) → /settle (commit, on-chain) → serve
      → CDR: rule · price · payer · tx hash    (nothing leaves unrated)
```

Full architecture, config reference, protocol gotchas and the runbook:
[ARCHITECTURE.md](./ARCHITECTURE.md).

## Status & roadmap

Working today: everything above, live-tested with real Base Sepolia
settlements. Deliberately next: wallet-keyed subscriber identity (signed
requests), per-rule quantity schedules (graduated pricing), the x402 `upto`
scheme for prepaid allowances and recurring collection, an MCP tool surface.

Built by [Dejan Ilešič](https://www.linkedin.com/in/dejan-ile%C5%A1i%C4%8D-a1148222/).
15 years of telecom billing, applied to the customers that are coming next.
Writing about it at **f(x)IQ**.

MIT licensed. The meter, not the door.
