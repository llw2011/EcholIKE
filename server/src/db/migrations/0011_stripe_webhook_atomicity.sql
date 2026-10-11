ALTER TABLE "stripe_webhook_event"
  ADD COLUMN "mutation_kind" text DEFAULT 'none' NOT NULL;

ALTER TABLE "stripe_webhook_event"
  ADD CONSTRAINT "stripe_webhook_event_mutation_kind_check"
  CHECK ("mutation_kind" IN ('none', 'customer_upsert', 'subscription_upsert'));
