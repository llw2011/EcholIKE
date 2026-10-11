ALTER TABLE "subscription" ADD COLUMN "stripe_event_created_at" timestamp with time zone;
ALTER TABLE "subscription" ADD COLUMN "stripe_event_id" text;
ALTER TABLE "stripe_webhook_event" ADD COLUMN "event_created_at" timestamp with time zone;

CREATE INDEX "subscription_stripe_event_order_idx"
  ON "subscription" USING btree ("stripe_event_created_at", "stripe_event_id");
