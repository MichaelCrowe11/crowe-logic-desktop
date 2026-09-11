-- The control plane's schema.
--
-- Two tables carry the product and one carries the paperwork. The shape of the
-- first is dictated by a decision made on the client long before this file
-- existed: every usage event's id is derived from the tenant, the turn and the
-- meter (cloud/contract.js), so a retry after a timeout is byte-identical to
-- the original. That is only a guarantee if something refuses the duplicate,
-- and this is where it gets refused.

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id                TEXT PRIMARY KEY,
  plan                     TEXT NOT NULL DEFAULT 'free',
  entitled                 BOOLEAN NOT NULL DEFAULT FALSE,
  -- 0 means no ceiling, matching clampCeiling() on the client. A tenant with a
  -- quota of 0 is uncapped, not blocked; a tenant who has spent their quota is
  -- refused at authorize, never handed a ceiling of 0.
  quota_usd                NUMERIC(12,4) NOT NULL DEFAULT 0,
  -- An empty array means the plane has no opinion about models, which is the
  -- same reading store-memory.js and cloud/local.js both take.
  allowed_models           TEXT[] NOT NULL DEFAULT '{}',
  -- Marketplace state. Authoritative: a webhook writes here, authorize reads
  -- here, so entitlement has exactly one source of truth.
  marketplace_subscription UUID UNIQUE,
  marketplace_plan_id      TEXT,
  marketplace_state        TEXT,
  quota_period_start       TIMESTAMPTZ NOT NULL DEFAULT date_trunc('month', now()),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* The ledger.

   usage_id is the primary key and it arrives from the client already computed.
   That is the entire idempotency mechanism: INSERT ... ON CONFLICT DO NOTHING
   makes a duplicate delivery a no-op inside the storage engine, under
   concurrency, without a transaction the application has to get right. The
   alternative - SELECT then INSERT - is a race that bills a customer twice
   under exactly the retry storm the client's outbox is built to produce.

   Append-only. A correction is a new row, never an UPDATE, because a ledger
   that can be edited is a ledger that cannot answer a billing dispute. */
CREATE TABLE IF NOT EXISTS usage_ledger (
  usage_id     TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL DEFAULT '',
  turn_id      TEXT NOT NULL,
  meter        TEXT NOT NULL,
  value        NUMERIC(18,6) NOT NULL CHECK (value >= 0),
  model        TEXT NOT NULL DEFAULT '',
  plan         TEXT NOT NULL DEFAULT '',
  stop         TEXT NOT NULL DEFAULT '',
  verdict      TEXT NOT NULL DEFAULT '',
  occurred_at  TIMESTAMPTZ NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULL means "not yet reported to the marketplace". This column is the
  -- metering outbox: the same shape cloud/outbox.js already proves on the
  -- client, rather than a second delivery mechanism with its own failure modes.
  emitted_at   TIMESTAMPTZ
);

-- The quota sum runs on every authorize, which is the critical path of every
-- turn. This index is what keeps it off a sequential scan of the whole ledger.
CREATE INDEX IF NOT EXISTS usage_ledger_quota_idx
  ON usage_ledger (tenant_id, meter, occurred_at);

-- Partial, because the emitter only ever asks for the unreported rows and that
-- set stays small even when the ledger does not.
CREATE INDEX IF NOT EXISTS usage_ledger_unemitted_idx
  ON usage_ledger (emitted_at) WHERE emitted_at IS NULL;

/* Marketplace webhooks, deduplicated on the id Microsoft sends.

   Same reasoning as the ledger and the same mechanism. Webhook delivery is
   at-least-once, and a replayed "unsubscribe" that is processed twice is
   survivable while a replayed plan change is not necessarily. Recording the
   event id first makes the handler's own idempotency a property of the table. */
CREATE TABLE IF NOT EXISTS marketplace_events (
  event_id        UUID PRIMARY KEY,
  subscription_id UUID NOT NULL,
  action          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'received',
  payload         JSONB NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS marketplace_events_subscription_idx
  ON marketplace_events (subscription_id, received_at DESC);
