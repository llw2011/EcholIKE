ALTER TABLE "provider_registry" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;
ALTER TABLE "provider_registry"
  ADD CONSTRAINT "provider_registry_revision_check"
  CHECK ("revision" >= 0);

ALTER TABLE "ota_release"
  ADD CONSTRAINT "ota_release_force_enabled_check"
  CHECK (NOT "force_update" OR "enabled");

ALTER TABLE "ota_release"
  ADD CONSTRAINT "ota_release_enabled_artifact_check"
  CHECK (
    NOT "enabled" OR (
      "artifact_bytes" IS NOT NULL
      AND "artifact_bytes" > 0
      AND nullif(btrim("download_url_encrypted"), '') IS NOT NULL
      AND "sha256" IS NOT NULL
      AND "sha256" ~* '^[a-f0-9]{64}$'
      AND nullif(btrim("signature"), '') IS NOT NULL
    )
  ) NOT VALID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "ota_release"
    WHERE "enabled"
      AND (
        "artifact_bytes" IS NULL
        OR "artifact_bytes" <= 0
        OR nullif(btrim("download_url_encrypted"), '') IS NULL
        OR "sha256" IS NULL
        OR "sha256" !~* '^[a-f0-9]{64}$'
        OR nullif(btrim("signature"), '') IS NULL
      )
  ) THEN
    ALTER TABLE "ota_release"
      VALIDATE CONSTRAINT "ota_release_enabled_artifact_check";
  END IF;
END $$;

CREATE INDEX "usage_ledger_period_kind_idx"
  ON "usage_ledger" USING btree ("period_key", "kind", "user_id");
