CREATE TABLE dlq_resolutions (
  job_id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id),
  reason text NOT NULL,
  resolved_status text NOT NULL CHECK (resolved_status IN ('COMPLETED', 'FAILED')),
  resolved_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX dlq_resolutions_order_idx ON dlq_resolutions (order_id);
