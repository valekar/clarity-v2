const DEFAULT_POLL_INTERVAL_MINUTES = 5;
const MIN_POLL_INTERVAL_MINUTES = 5;
const MAX_POLL_INTERVAL_MINUTES = 60;

export function parsePollIntervalMinutes(value: string | undefined): number {
  if (value === undefined) return DEFAULT_POLL_INTERVAL_MINUTES;
  if (!/^(?:[5-9]|[1-5][0-9]|60)$/.test(value)) {
    throw new Error("poll interval must be a whole number of minutes from 5 to 60");
  }
  const minutes = Number(value);
  if (minutes < MIN_POLL_INTERVAL_MINUTES || minutes > MAX_POLL_INTERVAL_MINUTES) {
    throw new Error("poll interval must be a whole number of minutes from 5 to 60");
  }
  return minutes;
}

function isLoopbackEndpoint(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Resolve the source inventory poll cadence from the private service config.
 * Sub-minute polling is reserved for disposable synthetic proofs and requires
 * both explicit opt-ins plus loopback-only endpoints.
 */
export function pollIntervalMs(environment: NodeJS.ProcessEnv): number {
  const syntheticSeconds = environment.CLARITY_SYNC_SYNTHETIC_POLL_INTERVAL_SECONDS;
  if (syntheticSeconds !== undefined) {
    if (
      syntheticSeconds !== "5" ||
      environment.CLARITY_SYNC_ALLOW_INSECURE_LOCALHOST !== "1" ||
      !isLoopbackEndpoint(environment.CLARITY_ORTHANC_URL) ||
      !isLoopbackEndpoint(environment.CLARITY_INGESTION_API_URL)
    ) {
      throw new Error("synthetic fast polling requires explicit loopback-only proof settings");
    }
    return 5_000;
  }

  const configured = environment.CLARITY_SYNC_POLL_INTERVAL_MINUTES;
  return parsePollIntervalMinutes(configured) * 60_000;
}
