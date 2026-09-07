-- Meridian rating worker — D1 schema.
-- cdr: one row per rating decision. This is the system's audit trail;
-- revenue assurance, invoicing, and the dashboard all read from here.
CREATE TABLE IF NOT EXISTS cdr (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,                -- ISO 8601
  day TEXT NOT NULL,               -- YYYY-MM-DD (UTC), for daily counters
  buyer_id TEXT NOT NULL,
  crawler TEXT NOT NULL,
  class TEXT NOT NULL,
  zone TEXT NOT NULL,
  freshness TEXT NOT NULL,
  path TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  selector_row TEXT NOT NULL,      -- ≈ impact category
  price REAL NOT NULL,
  currency TEXT NOT NULL,
  decision TEXT NOT NULL,          -- quoted | paid | free | blocked
  payment_mode TEXT NOT NULL,      -- none | simulated | x402
  tx_ref TEXT,                     -- settlement reference (tx hash in x402 mode)
  payer TEXT,                      -- buyer wallet address (x402 mode) — the account id
  trace TEXT NOT NULL              -- JSON array of trace lines
);
CREATE INDEX IF NOT EXISTS idx_cdr_ts ON cdr (ts);
CREATE INDEX IF NOT EXISTS idx_cdr_buyer_day ON cdr (buyer_id, day, decision);
CREATE INDEX IF NOT EXISTS idx_cdr_class ON cdr (class, decision);

-- plans: versioned system of record (published snapshots also live in KV).
CREATE TABLE IF NOT EXISTS plans (
  version INTEGER PRIMARY KEY,
  status TEXT NOT NULL,            -- draft | published | retired
  effective_from TEXT,
  created_at TEXT NOT NULL,
  body TEXT NOT NULL               -- full plan JSON
);

-- offers: the product catalog above the rate plans (offer → plan → charge).
CREATE TABLE IF NOT EXISTS offers (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',    -- draft | published | retired
  plan_version INTEGER,                    -- NULL → rides the current published plan
  monthly_usd REAL NOT NULL DEFAULT 0,     -- declared; collected once upto/subscription rails land
  onetime_usd REAL NOT NULL DEFAULT 0,
  daily_cap_usd REAL,                      -- credit limit for this offer; NULL = plan default
  allowances TEXT NOT NULL DEFAULT '[]',   -- JSON [{amount, period:'day', zone?}]
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- subscriptions: which account is on which offer (v1: one per buyer, manual).
CREATE TABLE IF NOT EXISTS subscriptions (
  buyer_id TEXT PRIMARY KEY,
  offer_slug TEXT NOT NULL,
  started_at TEXT NOT NULL
);

-- named pricing-rule sets (tailored rules per situation), versioned per name.
CREATE TABLE IF NOT EXISTS rulesets (
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (name, version)
);
