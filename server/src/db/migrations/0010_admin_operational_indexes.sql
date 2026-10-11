CREATE INDEX "quota_operation_created_at_idx"
  ON "quota_operation" USING btree ("created_at", "id");
CREATE INDEX "quota_operation_user_created_at_idx"
  ON "quota_operation" USING btree ("user_id", "created_at", "id");
CREATE INDEX "quota_operation_period_status_created_at_idx"
  ON "quota_operation" USING btree ("period_key", "status", "created_at", "id");
CREATE INDEX "audit_log_created_idx"
  ON "audit_log" USING btree ("created_at", "id");
