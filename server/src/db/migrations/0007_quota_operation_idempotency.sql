CREATE TYPE "quota_operation_status" AS ENUM ('reserved', 'completed', 'released');
CREATE TYPE "quota_operation_event" AS ENUM ('reserve', 'commit', 'release');

CREATE TABLE "quota_operation" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "payload_hash" text NOT NULL,
  "kind" "usage_ledger_kind" NOT NULL,
  "source" "usage_ledger_source" NOT NULL,
  "period_key" text NOT NULL,
  "request_id" text NOT NULL,
  "reserved_amount" integer NOT NULL,
  "actual_amount" integer,
  "status" "quota_operation_status" DEFAULT 'reserved' NOT NULL,
  "lease_token" text,
  "finalized_lease_token" text,
  "lease_expires_at" timestamp with time zone,
  "response_status" integer,
  "response_headers_json" jsonb,
  "response_body" bytea,
  "response_expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "quota_operation_user_id_user_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "quota_operation_source_check"
    CHECK ("source" <> 'adjustment'::usage_ledger_source),
  CONSTRAINT "quota_operation_reserved_amount_check"
    CHECK ("reserved_amount" >= 0),
  CONSTRAINT "quota_operation_actual_amount_check"
    CHECK ("actual_amount" IS NULL OR "actual_amount" >= 0),
  CONSTRAINT "quota_operation_payload_hash_check"
    CHECK ("payload_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "quota_operation_idempotency_key_check"
    CHECK ("idempotency_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$'),
  CONSTRAINT "quota_operation_state_check"
    CHECK (
      (
        "status" = 'reserved'::quota_operation_status
        AND "lease_token" IS NOT NULL
        AND "lease_expires_at" IS NOT NULL
        AND "finalized_lease_token" IS NULL
        AND "actual_amount" IS NULL
        AND "response_status" IS NULL
        AND "response_headers_json" IS NULL
        AND "response_body" IS NULL
        AND "response_expires_at" IS NULL
      )
      OR
      (
        "status" = 'completed'::quota_operation_status
        AND "lease_token" IS NULL
        AND "lease_expires_at" IS NULL
        AND "finalized_lease_token" IS NOT NULL
        AND "actual_amount" IS NOT NULL
        AND "response_status" IS NOT NULL
        AND "response_expires_at" IS NOT NULL
        AND (
          ("response_headers_json" IS NOT NULL AND "response_body" IS NOT NULL)
          OR ("response_headers_json" IS NULL AND "response_body" IS NULL)
        )
      )
      OR
      (
        "status" = 'released'::quota_operation_status
        AND "lease_token" IS NULL
        AND "lease_expires_at" IS NULL
        AND "finalized_lease_token" IS NOT NULL
        AND "actual_amount" IS NULL
        AND "response_status" IS NULL
        AND "response_headers_json" IS NULL
        AND "response_body" IS NULL
        AND "response_expires_at" IS NULL
      )
    )
);

CREATE UNIQUE INDEX "quota_operation_user_key_idx"
  ON "quota_operation" USING btree ("user_id", "idempotency_key");
CREATE INDEX "quota_operation_lease_sweep_idx"
  ON "quota_operation" USING btree (
    "user_id", "kind", "period_key", "status", "lease_expires_at"
  );
CREATE INDEX "quota_operation_global_lease_sweep_idx"
  ON "quota_operation" USING btree ("status", "lease_expires_at");
CREATE INDEX "quota_operation_response_sweep_idx"
  ON "quota_operation" USING btree ("status", "response_expires_at");

ALTER TABLE "usage_ledger" ADD COLUMN "operation_id" uuid;
ALTER TABLE "usage_ledger" ADD COLUMN "operation_lease_token" text;
ALTER TABLE "usage_ledger" ADD COLUMN "operation_event" "quota_operation_event";
ALTER TABLE "usage_ledger"
  ADD CONSTRAINT "usage_ledger_operation_id_quota_operation_id_fk"
  FOREIGN KEY ("operation_id") REFERENCES "quota_operation"("id")
  ON DELETE restrict ON UPDATE no action;
ALTER TABLE "usage_ledger"
  ADD CONSTRAINT "usage_ledger_operation_metadata_check"
  CHECK (
    ("operation_id" IS NULL AND "operation_lease_token" IS NULL AND "operation_event" IS NULL)
    OR
    ("operation_id" IS NOT NULL AND "operation_lease_token" IS NOT NULL AND "operation_event" IS NOT NULL)
  );
CREATE UNIQUE INDEX "usage_ledger_operation_event_idx"
  ON "usage_ledger" USING btree (
    "operation_id", "operation_lease_token", "operation_event"
  );
