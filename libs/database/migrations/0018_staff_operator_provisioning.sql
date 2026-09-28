-- Public login never creates staff rows. A private, temporary operator login
-- may enroll a Hanko subject; an active administrator then grants membership.
REVOKE EXECUTE ON FUNCTION public.enroll_pending_hanko_identity(uuid, uuid, text, text, text)
  FROM clarity_v2_runtime;
GRANT EXECUTE ON FUNCTION public.enroll_pending_hanko_identity(uuid, uuid, text, text, text)
  TO clarity_v2_bootstrap_operator;
