CREATE TABLE erp_invoices (
  order_id text PRIMARY KEY,
  erp_reference text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX orders_reconciliation_idx ON orders (updated_at)
  WHERE status IN ('PROCESSING', 'RECONCILIATION_REQUIRED');
