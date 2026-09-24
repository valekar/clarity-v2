ALTER TABLE public.dispatch_outbox
  ADD COLUMN last_reconcile_attempt_at timestamptz;

CREATE INDEX dispatch_outbox_uncertain_reconciliation
  ON public.dispatch_outbox (
    last_reconcile_attempt_at ASC NULLS FIRST, created_at, id
  ) WHERE state = 'uncertain';

CREATE FUNCTION public.list_uncertain_dispatch_outbox(
  p_limit integer
) RETURNS TABLE (idempotency_key uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'uncertain outbox page size is invalid' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
    WITH pending AS MATERIALIZED (
      SELECT o.id, o.last_reconcile_attempt_at, o.created_at
        FROM public.dispatch_outbox o
       WHERE o.state = 'uncertain'
       ORDER BY o.last_reconcile_attempt_at ASC NULLS FIRST, o.created_at, o.id
       FOR UPDATE OF o SKIP LOCKED
       LIMIT p_limit
    ), ranked AS (
      SELECT pending.id,
             row_number() OVER (
               ORDER BY pending.last_reconcile_attempt_at ASC NULLS FIRST,
                        pending.created_at, pending.id
             ) AS position
        FROM pending
    ), updated AS (
      UPDATE public.dispatch_outbox o
         SET last_reconcile_attempt_at = clock_timestamp(),
             updated_at = clock_timestamp(),
             version = version + 1
        FROM ranked
       WHERE o.id = ranked.id
      RETURNING o.id, o.idempotency_key
    )
    SELECT updated.idempotency_key
      FROM updated
      JOIN ranked USING (id)
     ORDER BY ranked.position;
END;
$$;

REVOKE ALL ON FUNCTION public.list_uncertain_dispatch_outbox(integer) FROM PUBLIC;
COMMENT ON FUNCTION public.list_uncertain_dispatch_outbox(integer) IS
  'Returns a bounded page of uncertain outbox idempotency keys for future authorized reconciliation. It never returns blocked or claimable payloads.';

DO $$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY[
    'clarity_v2_runtime',
    'clarity_v2_worker',
    'clarity_v2_device_auth',
    'clarity_v2_dispatch_worker',
    'clarity_v2_delivery'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.list_uncertain_dispatch_outbox(integer) FROM %I',
        v_role
      );
    END IF;
  END LOOP;
END;
$$;
