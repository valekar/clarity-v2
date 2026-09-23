SELECT public.enroll_pending_hanko_identity(
  '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  'Synthetic Candidate One', 'https://hanko.example.invalid', 'synthetic-subject-one'
);
SELECT public.enroll_pending_hanko_identity(
  '00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002',
  'Synthetic Candidate Two', 'https://hanko.example.invalid', 'synthetic-subject-two'
);
DO $$
DECLARE
  v_existing_user_id uuid;
BEGIN
  v_existing_user_id := public.enroll_pending_hanko_identity(
    '00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003',
    'Should Not Replace Existing', 'https://hanko.example.invalid', 'synthetic-subject-one'
  );
  IF v_existing_user_id <> '00000000-0000-4000-8000-000000000001' THEN
    RAISE EXCEPTION 'duplicate Hanko issuer+subject did not resolve to the canonical user';
  END IF;
END;
$$;

DO $$
BEGIN
  IF (SELECT count(*) FROM public.staff_users) <> 2
     OR (SELECT count(*) FROM public.staff_identities WHERE provider = 'hanko') <> 2
     OR (SELECT count(*) FROM public.staff_memberships) <> 0 THEN
    RAISE EXCEPTION 'pending Hanko enrollment did not create exactly two identity-only users';
  END IF;
END;
$$;
