ALTER TABLE "ota_release" ADD COLUMN "artifact_bytes" integer;
ALTER TABLE "ota_release" ALTER COLUMN "enabled" SET DEFAULT false;
ALTER TABLE "ota_release"
  ADD CONSTRAINT "ota_release_artifact_bytes_check"
  CHECK ("artifact_bytes" IS NULL OR "artifact_bytes" > 0);
ALTER TABLE "ota_release" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;
ALTER TABLE "ota_release"
  ADD CONSTRAINT "ota_release_revision_check"
  CHECK ("revision" >= 0);
