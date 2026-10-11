CREATE TABLE "admin_operation" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "actor_user_id" text NOT NULL,
  "kind" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "payload_hash" text NOT NULL,
  "request_id" text NOT NULL,
  "result_json" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "admin_operation_actor_user_id_user_id_fk"
    FOREIGN KEY ("actor_user_id") REFERENCES "user"("id")
    ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "admin_operation_kind_check"
    CHECK ("kind" = 'quota_adjustment'),
  CONSTRAINT "admin_operation_payload_hash_check"
    CHECK ("payload_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "admin_operation_idempotency_key_check"
    CHECK ("idempotency_key" ~ '^[A-Za-z0-9._:-]{16,200}$'),
  CONSTRAINT "admin_operation_result_check"
    CHECK ("result_json" IS NULL OR jsonb_typeof("result_json") = 'object')
);

CREATE UNIQUE INDEX "admin_operation_actor_key_idx"
  ON "admin_operation" USING btree ("actor_user_id", "kind", "idempotency_key");
CREATE INDEX "admin_operation_created_at_idx"
  ON "admin_operation" USING btree ("created_at");

ALTER TABLE "usage_ledger" ADD COLUMN "admin_operation_id" uuid;
ALTER TABLE "usage_ledger"
  ADD CONSTRAINT "usage_ledger_admin_operation_id_admin_operation_id_fk"
  FOREIGN KEY ("admin_operation_id") REFERENCES "admin_operation"("id")
  ON DELETE restrict ON UPDATE no action;
ALTER TABLE "usage_ledger"
  ADD CONSTRAINT "usage_ledger_admin_operation_metadata_check"
  CHECK (
    "admin_operation_id" IS NULL OR (
      "source" = 'adjustment'::usage_ledger_source
      AND "operation_id" IS NULL
      AND "operation_lease_token" IS NULL
      AND "operation_event" IS NULL
    )
  );
CREATE UNIQUE INDEX "usage_ledger_admin_operation_idx"
  ON "usage_ledger" USING btree ("admin_operation_id");
