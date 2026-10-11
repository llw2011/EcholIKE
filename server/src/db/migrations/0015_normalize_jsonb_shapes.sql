DO $$
DECLARE
  target record;
  candidate record;
  parsed jsonb;
  invalid_exists boolean;
BEGIN
  FOR target IN
    SELECT *
    FROM (
      VALUES
        ('audit_log', 'metadata_json', 'object'),
        ('stripe_webhook_event', 'metadata_json', 'object'),
        ('provider_registry', 'models_json', 'array'),
        ('provider_registry', 'capabilities_json', 'object'),
        ('desktop_policy', 'features_json', 'object'),
        ('desktop_policy', 'services_json', 'object'),
        ('desktop_policy', 'policy_json', 'object'),
        ('quota_operation', 'response_headers_json', 'object')
    ) AS targets(table_name, column_name, expected_type)
  LOOP
    FOR candidate IN EXECUTE format(
      'SELECT id::text AS id, %1$I #>> ''{}'' AS raw_value
       FROM %2$I
       WHERE jsonb_typeof(%1$I) = ''string''',
      target.column_name,
      target.table_name
    )
    LOOP
      BEGIN
        parsed := candidate.raw_value::jsonb;
      EXCEPTION WHEN others THEN
        RAISE EXCEPTION '% %.% is not valid JSON', candidate.id, target.table_name, target.column_name
          USING ERRCODE = '22023';
      END;

      IF jsonb_typeof(parsed) IS DISTINCT FROM target.expected_type THEN
        RAISE EXCEPTION '% %.% does not decode to %',
          candidate.id,
          target.table_name,
          target.column_name,
          target.expected_type
          USING ERRCODE = '22023';
      END IF;
    END LOOP;

    EXECUTE format(
      'UPDATE %1$I
       SET %2$I = (%2$I #>> ''{}'')::jsonb
       WHERE jsonb_typeof(%2$I) = ''string''',
      target.table_name,
      target.column_name
    );

    EXECUTE format(
      'SELECT EXISTS (
         SELECT 1
         FROM %1$I
         WHERE %2$I IS NOT NULL
           AND jsonb_typeof(%2$I) IS DISTINCT FROM %3$L
       )',
      target.table_name,
      target.column_name,
      target.expected_type
    ) INTO invalid_exists;

    IF invalid_exists THEN
      RAISE EXCEPTION '%.% contains values outside the required % shape',
        target.table_name,
        target.column_name,
        target.expected_type
        USING ERRCODE = '22023';
    END IF;
  END LOOP;
END $$;

ALTER TABLE "audit_log"
  ADD CONSTRAINT "audit_log_metadata_object_check"
  CHECK (jsonb_typeof("metadata_json") = 'object');

ALTER TABLE "stripe_webhook_event"
  ADD CONSTRAINT "stripe_webhook_event_metadata_object_check"
  CHECK (jsonb_typeof("metadata_json") = 'object');

ALTER TABLE "provider_registry"
  ADD CONSTRAINT "provider_registry_models_array_check"
  CHECK (jsonb_typeof("models_json") = 'array');
ALTER TABLE "provider_registry"
  ADD CONSTRAINT "provider_registry_capabilities_object_check"
  CHECK (jsonb_typeof("capabilities_json") = 'object');

ALTER TABLE "desktop_policy"
  ADD CONSTRAINT "desktop_policy_features_object_check"
  CHECK (jsonb_typeof("features_json") = 'object');
ALTER TABLE "desktop_policy"
  ADD CONSTRAINT "desktop_policy_services_object_check"
  CHECK (jsonb_typeof("services_json") = 'object');
ALTER TABLE "desktop_policy"
  ADD CONSTRAINT "desktop_policy_policy_object_check"
  CHECK (jsonb_typeof("policy_json") = 'object');

ALTER TABLE "quota_operation"
  ADD CONSTRAINT "quota_operation_response_headers_object_check"
  CHECK (
    "response_headers_json" IS NULL
    OR jsonb_typeof("response_headers_json") = 'object'
  );
