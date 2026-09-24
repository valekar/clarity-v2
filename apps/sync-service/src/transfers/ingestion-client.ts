import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import {
  isDeviceLeaseResponse,
  isStudyAdmissionResponse,
  isUploadAdmissionResponse,
  isUploadStatusResponse,
  isManifestBeginResponse,
  isManifestPageResponse,
  isManifestSealResponse,
  type ActiveUploadAdmission,
  type DeviceLeaseResponse,
  type UploadPartPlan as ContractUploadPartPlan,
  type UploadAdmissionResponse,
  type StudyAdmissionRequest,
  type StudyAdmissionResponse,
  type ManifestBeginRequest,
  type ManifestPageRequest,
  type ManifestSealRequest,
} from "@clarity/contracts";
import type { LogicalReport } from "../discovery/model.js";
import type { LocalPartReceipt, LocalUpload } from "../persistence/upload-spool-store.js";

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

export type UploadPartPlan = ContractUploadPartPlan;

export type UploadSession = ActiveUploadAdmission;
export type UploadAuthorization = UploadAdmissionResponse;

export type CloudUploadState =
  "admitted" | "uploading" | "received" | "completed" | "expired" | "aborted";

function transferSignal(leaseSignal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(60 * 60 * 1000);
  return leaseSignal ? AbortSignal.any([leaseSignal, timeout]) : timeout;
}

export class UploadApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "UploadApiError";
  }
}

export class UploadAuthorizationExpiredError extends Error {}

export interface IngestionClientOptions {
  apiBaseUrl: string;
  deviceAuthorization: string;
  fetchImpl?: typeof fetch;
  allowInsecureLocalhost?: boolean;
  now?: () => number;
  leaseHeartbeatIntervalMs?: number;
}

export interface CloudLeaseHeartbeat {
  signal: AbortSignal;
  stop(): void;
}

export type SourceHealthReport = Readonly<{
  sourceReachable: boolean;
  syncState: "idle" | "syncing" | "attention";
  lastErrorCode: "orthanc_unavailable" | "low_spool_space" | "source_changed" | "sync_failed" | null;
  queuedStudies: number;
  queuedUploads: number;
  spoolFreeBytes: number | null;
  spoolCapacityBytes: number | null;
  lastSuccessfulSyncAt: string | null;
}>;

async function boundedJson(response: Response, maximumBytes = 256 * 1024): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await response.body?.cancel();
    throw new Error("Cloud ingestion metadata response exceeded its limit");
  }
  if (!response.body) throw new Error("Cloud ingestion response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let body = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error("Cloud ingestion metadata response exceeded its limit");
      }
      body += decoder.decode(part.value, { stream: true });
    }
    body += decoder.decode();
    return JSON.parse(body) as unknown;
  } finally {
    reader.releaseLock();
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function safeUrl(value: unknown, allowInsecureLocalhost: boolean): URL {
  if (typeof value !== "string") throw new Error("signed upload URL must be a string");
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (
    (url.protocol !== "https:" &&
      !(allowInsecureLocalhost && loopback && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("signed upload URL must use HTTPS without embedded credentials or fragments");
  }
  return url;
}

function signedRequest(value: unknown, allowInsecureLocalhost: boolean): SignedRequest {
  const item = record(value, "signed request");
  const headersValue = item.headers ?? {};
  const headersRecord = record(headersValue, "signed request headers");
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(headersRecord)) {
    if (
      !/^[a-z0-9-]{1,80}$/i.test(name) ||
      typeof headerValue !== "string" ||
      headerValue.length > 2048
    ) {
      throw new Error("signed request contains an invalid header");
    }
    if (name.toLowerCase() === "authorization")
      throw new Error("signed request must not delegate an authorization header");
    headers[name] = headerValue;
  }
  return { url: safeUrl(item.url, allowInsecureLocalhost).href, headers };
}

function parseSession(value: unknown, allowInsecureLocalhost: boolean): ActiveUploadAdmission {
  const item = record(value, "upload authorization");
  if (
    typeof item.uploadId !== "string" ||
    !item.uploadId ||
    typeof item.expiresAt !== "string" ||
    Number.isNaN(Date.parse(item.expiresAt))
  ) {
    throw new Error("upload authorization is missing its ID or expiry");
  }
  const mode = item.mode;
  if (mode === "put") {
    if (
      item.put === undefined ||
      item.parts !== undefined ||
      item.multipartUploadId !== undefined
    ) {
      throw new Error("single PUT authorization contains multipart fields");
    }
    return {
      uploadId: item.uploadId,
      expiresAt: item.expiresAt,
      mode,
      put: signedRequest(item.put, allowInsecureLocalhost),
    };
  }
  if (
    mode !== "multipart" ||
    typeof item.multipartUploadId !== "string" ||
    !Array.isArray(item.parts)
  ) {
    throw new Error("upload authorization mode is invalid");
  }
  const parts = item.parts.map((value) => {
    const part = record(value, "upload part");
    if (
      !Number.isInteger(part.partNumber) ||
      (part.partNumber as number) < 1 ||
      !Number.isSafeInteger(part.offset) ||
      (part.offset as number) < 0 ||
      !Number.isSafeInteger(part.byteCount) ||
      (part.byteCount as number) < 1 ||
      (part.acknowledgedEtag !== undefined && typeof part.acknowledgedEtag !== "string")
    ) {
      throw new Error("upload part plan has invalid number or byte range");
    }
    return {
      partNumber: part.partNumber as number,
      offset: part.offset as number,
      byteCount: part.byteCount as number,
      put: signedRequest(part.put, allowInsecureLocalhost),
      ...(typeof part.acknowledgedEtag === "string"
        ? { acknowledgedEtag: part.acknowledgedEtag }
        : {}),
    };
  });
  return {
    uploadId: item.uploadId,
    expiresAt: item.expiresAt,
    mode,
    multipartUploadId: item.multipartUploadId,
    parts,
  };
}

export class IngestionClient {
  readonly #baseUrl: URL;
  readonly #authorization: string;
  readonly #fetch: typeof fetch;
  readonly #allowInsecureLocalhost: boolean;
  readonly #now: () => number;
  readonly #leaseHeartbeatIntervalMs: number;
  #lease: DeviceLeaseResponse | null = null;

  constructor(options: IngestionClientOptions) {
    this.#baseUrl = new URL(options.apiBaseUrl);
    if (
      this.#baseUrl.protocol !== "https:" &&
      !(
        options.allowInsecureLocalhost &&
        ["localhost", "127.0.0.1", "::1"].includes(this.#baseUrl.hostname)
      )
    ) {
      throw new Error("Ingestion API must use HTTPS outside an explicitly allowed loopback test");
    }
    if (
      options.deviceAuthorization.length > 256 ||
      !/^ClarityDevice [0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/i.test(
        options.deviceAuthorization,
      )
    ) {
      throw new Error("issued ClarityDevice authorization is required");
    }
    this.#authorization = options.deviceAuthorization;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#allowInsecureLocalhost = options.allowInsecureLocalhost === true;
    this.#now = options.now ?? Date.now;
    this.#leaseHeartbeatIntervalMs = options.leaseHeartbeatIntervalMs ?? 60_000;
  }

  async acquireLease(): Promise<DeviceLeaseResponse> {
    const value = await this.#api("/api/ingestion/lease", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "acquire" }),
    });
    if (!isDeviceLeaseResponse(value) || Date.parse(value.leaseExpiresAt) <= this.#now()) {
      throw new Error("Cloud returned an invalid or expired device lease");
    }
    this.#lease = value;
    return value;
  }

  async renewLease(): Promise<DeviceLeaseResponse> {
    const previous = this.#currentLease();
    let value: unknown;
    try {
      value = await this.#api("/api/ingestion/lease", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "renew",
          sourceGeneration: previous.sourceGeneration,
          fencingToken: previous.fencingToken,
        }),
      });
      if (
        !isDeviceLeaseResponse(value) ||
        value.sourceGeneration !== previous.sourceGeneration ||
        value.fencingToken !== previous.fencingToken ||
        Date.parse(value.leaseExpiresAt) <= this.#now()
      ) {
        throw new Error("Cloud renewal changed ownership or returned an expired lease");
      }
    } catch (error) {
      this.#lease = null;
      throw error;
    }
    this.#lease = value;
    return value;
  }

  async ensureLease(): Promise<DeviceLeaseResponse> {
    if (!this.#lease) return this.acquireLease();
    const remainingMs = Date.parse(this.#lease.leaseExpiresAt) - this.#now();
    if (remainingMs <= 0) {
      this.#lease = null;
      return this.acquireLease();
    }
    if (remainingMs <= 90_000) {
      return this.renewLease();
    }
    return this.#lease;
  }

  async reportHealth(report: SourceHealthReport): Promise<void> {
    const lease = await this.ensureLease();
    await this.#api("/api/ingestion/health", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceGeneration: lease.sourceGeneration,
        fencingToken: lease.fencingToken,
        ...report,
      }),
    });
  }

  async startLeaseHeartbeat(
    intervalMs = this.#leaseHeartbeatIntervalMs,
  ): Promise<CloudLeaseHeartbeat> {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 60_000) {
      throw new Error("cloud lease heartbeat interval is outside its safe bound");
    }
    await this.ensureLease();
    const controller = new AbortController();
    let renewing = false;
    const timer = setInterval(() => {
      if (renewing || controller.signal.aborted) return;
      renewing = true;
      void this.renewLease()
        .catch(() => {
          controller.abort(new Error("cloud source lease was lost during upload"));
        })
        .finally(() => {
          renewing = false;
        });
    }, intervalMs);
    return {
      signal: controller.signal,
      stop: () => clearInterval(timer),
    };
  }

  async admitStudy(report: LogicalReport, admissionKey: string): Promise<StudyAdmissionResponse> {
    await this.ensureLease();
    const lease = this.#currentLease();
    const body: StudyAdmissionRequest = {
      admissionKey,
      sourceGeneration: lease.sourceGeneration,
      fencingToken: lease.fencingToken,
      studyInstanceUid: report.studyInstanceUid,
      orthancStudyId: report.orthancStudyId,
      patientId: report.patientId,
      patientIssuerOfPatientId: report.patientIssuerOfPatientId,
      patientName: report.patientName,
      patientBirthDate: report.patientBirthDate,
      patientSex: report.patientSex,
      studyDate: report.studyDate,
      studyTime: report.studyTime,
      studyDescription: report.studyDescription,
      accessionNumber: report.accessionNumber,
      modalities: report.modalities,
    };
    const value = await this.#api("/api/ingestion/studies", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": admissionKey },
      body: JSON.stringify(body),
    });
    if (!isStudyAdmissionResponse(value) || value.studyInstanceUid !== report.studyInstanceUid) {
      throw new Error("Cloud returned an invalid study admission result");
    }
    return value;
  }

  async beginManifest(
    reportId: string,
    body: Omit<ManifestBeginRequest, "sourceGeneration" | "fencingToken">,
  ): Promise<number | null> {
    const lease = await this.ensureLease();
    const value = await this.#api(
      `/api/ingestion/reports/${encodeURIComponent(reportId)}/manifest/begin`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...body,
          sourceGeneration: lease.sourceGeneration,
          fencingToken: lease.fencingToken,
        } satisfies ManifestBeginRequest),
      },
    );
    if (!isManifestBeginResponse(value))
      throw new Error("Cloud returned an invalid manifest revision");
    return value.revision;
  }

  async recordManifestPage(
    reportId: string,
    body: Omit<ManifestPageRequest, "sourceGeneration" | "fencingToken">,
  ): Promise<number> {
    const lease = await this.ensureLease();
    const value = await this.#api(
      `/api/ingestion/reports/${encodeURIComponent(reportId)}/manifest/pages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...body,
          sourceGeneration: lease.sourceGeneration,
          fencingToken: lease.fencingToken,
        } satisfies ManifestPageRequest),
      },
    );
    if (!isManifestPageResponse(value))
      throw new Error("Cloud returned an invalid manifest page result");
    return value.accepted;
  }

  async sealManifest(
    reportId: string,
    body: Omit<ManifestSealRequest, "sourceGeneration" | "fencingToken">,
  ): Promise<boolean> {
    const lease = await this.ensureLease();
    const value = await this.#api(
      `/api/ingestion/reports/${encodeURIComponent(reportId)}/manifest/seal`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...body,
          sourceGeneration: lease.sourceGeneration,
          fencingToken: lease.fencingToken,
        } satisfies ManifestSealRequest),
      },
    );
    if (!isManifestSealResponse(value))
      throw new Error("Cloud returned an invalid manifest seal result");
    return value.sealed;
  }

  async authorize(upload: LocalUpload): Promise<UploadAuthorization> {
    await this.ensureLease();
    const lease = this.#currentLease();
    const value = await this.#api("/api/ingestion/uploads", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": upload.admissionKey },
      body: JSON.stringify({
        admissionKey: upload.admissionKey,
        orthancInstanceId: upload.orthancInstanceId,
        studyInstanceUid: upload.studyInstanceUid,
        seriesInstanceUid: upload.seriesInstanceUid,
        sopInstanceUid: upload.sopInstanceUid,
        byteCount: upload.byteCount,
        sha256: upload.sha256,
        sourceGeneration: lease.sourceGeneration,
        fencingToken: lease.fencingToken,
      }),
    });
    if (!isUploadAdmissionResponse(value)) {
      throw new Error("Cloud returned an invalid upload authorization");
    }
    if ("status" in value) return { uploadId: value.uploadId, status: value.status };
    return parseSession(value, this.#allowInsecureLocalhost);
  }

  async putFile(
    signed: SignedRequest,
    spoolPath: string,
    byteCount: number,
    leaseSignal?: AbortSignal,
  ): Promise<string> {
    const url = safeUrl(signed.url, this.#allowInsecureLocalhost);
    const stream = Readable.toWeb(createReadStream(spoolPath));
    const response = await this.#fetch(url, {
      method: "PUT",
      headers: { ...signed.headers, "content-length": String(byteCount) },
      body: stream,
      duplex: "half",
      redirect: "error",
      signal: transferSignal(leaseSignal),
    } as RequestInit);
    if (response.status === 403 || response.status === 410) {
      await response.body?.cancel().catch(() => undefined);
      throw new UploadAuthorizationExpiredError("signed upload authorization expired");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new UploadApiError(response.status, "signed object upload failed");
    }
    const etag = response.headers.get("etag");
    await response.body?.cancel().catch(() => undefined);
    if (!etag || etag.length > 512)
      throw new Error("signed object upload returned no valid ETag receipt");
    return etag;
  }

  async putPart(
    signed: SignedRequest,
    spoolPath: string,
    part: UploadPartPlan,
    leaseSignal?: AbortSignal,
  ): Promise<string> {
    const url = safeUrl(signed.url, this.#allowInsecureLocalhost);
    const stream = Readable.toWeb(
      createReadStream(spoolPath, { start: part.offset, end: part.offset + part.byteCount - 1 }),
    );
    const response = await this.#fetch(url, {
      method: "PUT",
      headers: { ...signed.headers, "content-length": String(part.byteCount) },
      body: stream,
      duplex: "half",
      redirect: "error",
      signal: transferSignal(leaseSignal),
    } as RequestInit);
    if (response.status === 403 || response.status === 410) {
      await response.body?.cancel().catch(() => undefined);
      throw new UploadAuthorizationExpiredError("signed upload part authorization expired");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new UploadApiError(response.status, "signed upload part failed");
    }
    const etag = response.headers.get("etag");
    await response.body?.cancel().catch(() => undefined);
    if (!etag || etag.length > 512)
      throw new Error("signed upload part returned no valid ETag receipt");
    return etag;
  }

  async complete(
    uploadId: string,
    byteCount: number,
    sha256: string,
    parts: readonly LocalPartReceipt[],
  ): Promise<CloudUploadState> {
    await this.ensureLease();
    const lease = this.#currentLease();
    const value = await this.#api(
      `/api/ingestion/uploads/${encodeURIComponent(uploadId)}/complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          byteCount,
          sha256,
          parts,
          sourceGeneration: lease.sourceGeneration,
          fencingToken: lease.fencingToken,
        }),
      },
    );
    return this.#state(record(value, "completion result").status);
  }

  async status(uploadId: string): Promise<CloudUploadState> {
    const value = await this.#api(`/api/ingestion/uploads/${encodeURIComponent(uploadId)}`);
    if (!isUploadStatusResponse(value)) throw new Error("Cloud returned an invalid upload status");
    return this.#state(value.status);
  }

  #currentLease(): DeviceLeaseResponse {
    if (!this.#lease) throw new Error("Cloud device lease has not been acquired");
    if (Date.parse(this.#lease.leaseExpiresAt) <= this.#now()) {
      throw new Error("Cloud device lease expired and must be renewed");
    }
    return this.#lease;
  }

  #state(value: unknown): CloudUploadState {
    if (
      ["admitted", "uploading", "received", "completed", "expired", "aborted"].includes(
        String(value),
      )
    ) {
      return value as CloudUploadState;
    }
    throw new Error("cloud returned an unknown upload status");
  }

  async #api(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.#fetch(new URL(path, this.#baseUrl), {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        authorization: this.#authorization,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 409) this.#lease = null;
      throw new UploadApiError(response.status, "cloud ingestion API request failed");
    }
    return boundedJson(response);
  }
}
