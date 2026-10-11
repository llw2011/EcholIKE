CREATE TYPE "provider_kind" AS ENUM ('llm', 'stt', 'tts', 'ocr');
CREATE TYPE "provider_mode" AS ENUM ('proxy', 'direct', 'byok', 'local', 'disabled');
CREATE TYPE "desktop_policy_plan" AS ENUM ('free', 'pro', 'all');

CREATE TABLE "provider_registry" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" "provider_kind" NOT NULL,
  "provider_id" text NOT NULL,
  "display_name" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "mode" "provider_mode" NOT NULL,
  "endpoint_encrypted" text,
  "api_key_encrypted" text,
  "default_model" text,
  "models_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "capabilities_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "priority" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "desktop_policy" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "channel" text DEFAULT 'stable' NOT NULL,
  "platform" text DEFAULT 'all' NOT NULL,
  "plan" "desktop_policy_plan" DEFAULT 'all' NOT NULL,
  "features_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "services_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "policy_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "ota_release" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "app_name" text DEFAULT 'EcholIKE' NOT NULL,
  "version" text NOT NULL,
  "channel" text DEFAULT 'stable' NOT NULL,
  "platform" text DEFAULT 'all' NOT NULL,
  "arch" text DEFAULT 'all' NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "auto_update" boolean DEFAULT false NOT NULL,
  "force_update" boolean DEFAULT false NOT NULL,
  "min_version" text,
  "download_url_encrypted" text,
  "sha256" text,
  "signature" text,
  "release_notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "published_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "provider_registry_kind_provider_idx"
  ON "provider_registry" USING btree ("kind", "provider_id");
CREATE INDEX "provider_registry_lookup_idx"
  ON "provider_registry" USING btree ("kind", "enabled", "priority");
CREATE INDEX "desktop_policy_lookup_idx"
  ON "desktop_policy" USING btree ("channel", "platform", "plan", "enabled");
CREATE UNIQUE INDEX "ota_release_version_target_idx"
  ON "ota_release" USING btree ("app_name", "version", "channel", "platform", "arch");
CREATE INDEX "ota_release_lookup_idx"
  ON "ota_release" USING btree ("enabled", "channel", "platform", "arch");
