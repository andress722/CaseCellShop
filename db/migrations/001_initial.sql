CREATE TABLE products (
  id text PRIMARY KEY,
  name text NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  source_updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inventory (
  product_id text PRIMARY KEY REFERENCES products(id),
  available integer NOT NULL CHECK (available >= 0),
  reserved integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id text PRIMARY KEY,
  status text NOT NULL CHECK (status IN (
    'PENDING', 'QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'RECONCILIATION_REQUIRED'
  )),
  total_cents integer NOT NULL CHECK (total_cents >= 0),
  idempotency_key text NOT NULL UNIQUE,
  request_hash text NOT NULL,
  erp_reference text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  id bigserial PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id),
  product_id text NOT NULL REFERENCES products(id),
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
  quantity integer NOT NULL CHECK (quantity > 0),
  subtotal_cents integer NOT NULL CHECK (subtotal_cents >= 0)
);

CREATE TABLE outbox_events (
  id bigserial PRIMARY KEY,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  event_type text NOT NULL,
  payload_json jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX outbox_pending_idx ON outbox_events (created_at, id)
  WHERE published_at IS NULL;

CREATE TABLE processed_messages (
  consumer text NOT NULL,
  message_id text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, message_id)
);
