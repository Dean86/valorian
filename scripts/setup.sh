#!/usr/bin/env bash
# Meridian one-shot setup: provisions D1 + KV, applies the schema, wires the
# ids into wrangler.toml, sets your admin token, and deploys.
# Prereqs: a Cloudflare account and CLOUDFLARE_API_TOKEN in the environment
# (or `npx wrangler login`). Run from the repo root.
set -euo pipefail
cd "$(dirname "$0")/../packages/worker"

echo "→ creating D1 database 'meridian'…"
D1_ID=$(npx wrangler d1 create meridian 2>/dev/null | grep -oP 'database_id = "\K[^"]+' || true)
if [ -z "$D1_ID" ]; then
  D1_ID=$(npx wrangler d1 list --json | python3 -c "import json,sys; print(next(d['uuid'] for d in json.load(sys.stdin) if d['name']=='meridian'))")
  echo "  exists, reusing: $D1_ID"
fi

echo "→ creating KV namespace 'PLANS'…"
KV_ID=$(npx wrangler kv namespace create PLANS 2>/dev/null | grep -oP 'id = "\K[^"]+' || true)
if [ -z "$KV_ID" ]; then
  KV_ID=$(npx wrangler kv namespace list | python3 -c "import json,sys; print(next(n['id'] for n in json.load(sys.stdin) if n['title'].endswith('PLANS')))")
  echo "  exists, reusing: $KV_ID"
fi

sed -i.bak -E "s/^database_id = .*/database_id = \"$D1_ID\"/; s/^id = .*/id = \"$KV_ID\"/" wrangler.toml && rm -f wrangler.toml.bak
echo "→ applying schema…"
npx wrangler d1 execute meridian --remote --file=schema.sql -y > /dev/null

echo "→ set your admin token (guards the console & management API):"
ADMIN=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 40)
printf '%s' "$ADMIN" | npx wrangler secret put ADMIN_TOKEN > /dev/null
echo "  ADMIN_TOKEN generated — SAVE THIS, the console asks for it: $ADMIN"

echo "→ building console…"
(cd ../ui && npm run build > /dev/null)
echo "→ deploying…"
npx wrangler deploy | grep -E "workers.dev|Version"
echo
echo "✓ done. Next steps:"
echo "  1. Edit packages/worker/wrangler.toml: set ORIGIN to your API's URL and PAY_TO to your wallet."
echo "     (If your origin is another Worker, add a service binding — see ARCHITECTURE.md.)"
echo "  2. Redeploy: cd packages/worker && npx wrangler deploy"
echo "  3. Open your worker URL, unlock with the admin token, design your pricing rules, publish."
