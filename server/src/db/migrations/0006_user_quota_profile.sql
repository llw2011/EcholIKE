CREATE TABLE IF NOT EXISTS "user_quota_profile" (
  "user_id" text PRIMARY KEY NOT NULL,
  "quota_level" integer DEFAULT 1 NOT NULL,
  "updated_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_quota_profile_user_id_user_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "user_quota_profile_updated_by_user_id_fk"
    FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE set null ON UPDATE no action,
  CONSTRAINT "user_quota_profile_quota_level_check"
    CHECK ("quota_level" between 1 and 5)
);

CREATE INDEX IF NOT EXISTS "user_quota_profile_level_idx"
  ON "user_quota_profile" USING btree ("quota_level");
