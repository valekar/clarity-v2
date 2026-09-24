export type SourceHealthStatus = "healthy" | "attention" | "offline" | "stale";

export type SourceHealthItem = Readonly<{
  sourceId: string;
  sourceName: string;
  status: SourceHealthStatus;
  observedAt: string | null;
  lastSuccessfulSyncAt: string | null;
  lastErrorCode: string | null;
  queuedStudies: number;
  queuedUploads: number;
  spoolFreeBytes: number | null;
  spoolCapacityBytes: number | null;
  sourceReachable: boolean | null;
  cloudReachable: boolean | null;
}>;

export type SourceHealthResponse = Readonly<{ items: readonly SourceHealthItem[] }>;

const STATUSES = new Set<SourceHealthStatus>(["healthy", "attention", "offline", "stale"]);

function optionalString(value: unknown): string | null | undefined {
  return value === null || typeof value === "string" ? value : undefined;
}

function optionalCount(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function optionalReachability(value: unknown): boolean | null | undefined {
  return value === null || typeof value === "boolean" ? value : undefined;
}

function optionalTimestamp(value: unknown): string | null | undefined {
  return value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)))
    ? value
    : undefined;
}

function parseItem(value: unknown): SourceHealthItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (
    typeof item.sourceId !== "string" ||
    item.sourceId.length > 128 ||
    typeof item.sourceName !== "string" ||
    item.sourceName.length > 160 ||
    typeof item.status !== "string" ||
    !STATUSES.has(item.status as SourceHealthStatus)
  ) {
    return null;
  }
  const observedAt = optionalTimestamp(item.observedAt);
  const lastSuccessfulSyncAt = optionalTimestamp(item.lastSuccessfulSyncAt);
  const lastErrorCode = optionalString(item.lastErrorCode);
  const queuedStudies = optionalCount(item.queuedStudies);
  const queuedUploads = optionalCount(item.queuedUploads);
  const spoolFreeBytes = optionalCount(item.spoolFreeBytes);
  const spoolCapacityBytes = optionalCount(item.spoolCapacityBytes);
  const sourceReachable = optionalReachability(item.sourceReachable);
  const cloudReachable = optionalReachability(item.cloudReachable);
  if (
    observedAt === undefined ||
    lastSuccessfulSyncAt === undefined ||
    lastErrorCode === undefined ||
    queuedStudies === null ||
    queuedStudies === undefined ||
    queuedUploads === null ||
    queuedUploads === undefined ||
    spoolFreeBytes === undefined ||
    spoolCapacityBytes === undefined ||
    sourceReachable === undefined ||
    cloudReachable === undefined
  )
    return null;
  if (
    spoolFreeBytes !== null &&
    spoolCapacityBytes !== null &&
    spoolFreeBytes > spoolCapacityBytes
  ) {
    return null;
  }
  return {
    sourceId: item.sourceId,
    sourceName: item.sourceName,
    status: item.status as SourceHealthStatus,
    observedAt,
    lastSuccessfulSyncAt,
    lastErrorCode,
    queuedStudies,
    queuedUploads,
    spoolFreeBytes,
    spoolCapacityBytes,
    sourceReachable,
    cloudReachable,
  };
}

export function parseSourceHealthResponse(value: unknown): SourceHealthResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const items = (value as Record<string, unknown>).items;
  if (!Array.isArray(items) || items.length > 100) return null;
  const parsed = items.map(parseItem);
  if (parsed.some((item) => item === null)) return null;
  return { items: parsed as SourceHealthItem[] };
}

export async function requestSourceHealth(
  fetcher: typeof fetch,
  lifetimeSignal: AbortSignal,
  timeoutMs = 12_000,
): Promise<SourceHealthResponse> {
  const signal = AbortSignal.any([lifetimeSignal, AbortSignal.timeout(timeoutMs)]);
  const response = await fetcher("/api/staff/source-health", {
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("source-health-unavailable");
  const result = parseSourceHealthResponse(await response.json());
  if (!result) throw new Error("source-health-invalid");
  return result;
}

export function formatCapacity(bytes: number): string {
  if (bytes < 1024 ** 2) return bytes === 0 ? "0 MB" : "<1 MB";
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function sourceHealthMessage(item: SourceHealthItem): string {
  if (item.status === "stale")
    return "No recent source report. Current source and cloud status is unknown.";
  if (item.status === "offline") return "The source could not be reached at its last report.";
  if (
    item.status === "attention" &&
    item.spoolFreeBytes !== null &&
    item.spoolFreeBytes <= 1024 ** 3
  ) {
    return `Local storage is low: ${formatCapacity(item.spoolFreeBytes)} free.`;
  }
  if (item.status === "attention") return "Sync needs attention. Check the source service.";
  if (item.sourceReachable === true && item.cloudReachable === true) {
    return "Source and cloud were reachable at the last report.";
  }
  return "Source status was reported recently.";
}
