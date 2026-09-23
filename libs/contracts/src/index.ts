/** Browser-safe HTTP contracts shared by the web server and device service. */
export type DeviceLeaseAcquireRequest = Readonly<{ action: "acquire" }>;

export type DeviceLeaseRenewRequest = Readonly<{
  action: "renew";
  sourceGeneration: number;
  fencingToken: string;
}>;

export type DeviceLeaseRequest = DeviceLeaseAcquireRequest | DeviceLeaseRenewRequest;

export type DeviceLeaseResponse = Readonly<{
  sourceGeneration: number;
  fencingToken: string;
  leaseExpiresAt: string;
}>;

export type StudyAdmissionRequest = Readonly<{
  admissionKey: string;
  sourceGeneration: number;
  fencingToken: string;
  studyInstanceUid: string;
  /** Locator only; the cloud binds it to the authenticated source and generation. */
  orthancStudyId: string;
  patientId?: string | null;
  patientIssuerOfPatientId?: string | null;
  patientName?: string | null;
  patientBirthDate?: string | null;
  patientSex?: string | null;
  studyDate?: string | null;
  studyTime?: string | null;
  studyDescription?: string | null;
  accessionNumber?: string | null;
  modalities?: string | null;
}>;

export type StudyAdmissionResponse = Readonly<{
  reportId: string;
  studyInstanceUid: string;
  version: number;
  currentManifestRevision: number | null;
  currentManifestDigest: string | null;
  currentManifestGeneration: number | null;
}>;

export type UploadPartPlan = Readonly<{
  partNumber: number;
  offset: number;
  byteCount: number;
  put: SignedUploadRequest;
  acknowledgedEtag?: string;
}>;

export type SignedUploadRequest = Readonly<{
  url: string;
  headers: Readonly<Record<string, string>>;
}>;

export type UploadAdmissionRequest = Readonly<{
  admissionKey: string;
  sourceGeneration: number;
  fencingToken: string;
  orthancInstanceId: string;
  studyInstanceUid: string;
  seriesInstanceUid: string;
  sopInstanceUid: string;
  byteCount: number;
  sha256: string;
}>;

export type ActiveUploadAdmission =
  | Readonly<{
      uploadId: string;
      expiresAt: string;
      mode: "put";
      put: SignedUploadRequest;
    }>
  | Readonly<{
      uploadId: string;
      expiresAt: string;
      mode: "multipart";
      multipartUploadId: string;
      parts: readonly UploadPartPlan[];
    }>;

export type AlreadyReceivedUploadAdmission = Readonly<{
  uploadId: string;
  status: "received" | "completed";
}>;

export type UploadAdmissionResponse = ActiveUploadAdmission | AlreadyReceivedUploadAdmission;

export type UploadPartReceipt = Readonly<{
  partNumber: number;
  offset: number;
  byteCount: number;
  sha256: string;
  etag: string;
}>;

export type UploadCompletionRequest = Readonly<{
  sourceGeneration: number;
  fencingToken: string;
  byteCount: number;
  sha256: string;
  parts: readonly UploadPartReceipt[];
}>;

export type UploadCompletionResponse = Readonly<{
  status: "received" | "completed";
}>;

export type UploadStatusResponse = Readonly<{
  status: "admitted" | "uploading" | "received" | "completed" | "expired" | "aborted";
}>;

export type ManifestMember = Readonly<{ sopInstanceUid: string; sha256: string }>;

export type ManifestBeginRequest = Readonly<{
  sourceGeneration: number;
  fencingToken: string;
  inventoryAttemptId: string;
  expectedCurrentRevision: number | null;
  expectedReportVersion: number;
}>;

export type ManifestBeginResponse = Readonly<{ revision: number | null }>;

export type ManifestPageRequest = Readonly<{
  sourceGeneration: number;
  fencingToken: string;
  inventoryAttemptId: string;
  revision: number;
  expectedReportVersion: number;
  members: readonly ManifestMember[];
}>;

export type ManifestPageResponse = Readonly<{ accepted: number }>;

export type ManifestSealRequest = Readonly<{
  sourceGeneration: number;
  fencingToken: string;
  inventoryAttemptId: string;
  revision: number;
  expectedCurrentRevision: number | null;
  expectedReportVersion: number;
  sourceObservedAt: string;
  sourceStable: true;
  inventoryComplete: true;
  observedManifestDigest: string;
}>;

export type ManifestSealResponse = Readonly<{ sealed: boolean }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FENCE = /^[0-9]{1,19}$/;
const UID = /^[0-9]+(?:\.[0-9]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isDeviceLeaseResponse(value: unknown): value is DeviceLeaseResponse {
  return (
    object(value) &&
    Number.isSafeInteger(value.sourceGeneration) &&
    (value.sourceGeneration as number) > 0 &&
    typeof value.fencingToken === "string" &&
    FENCE.test(value.fencingToken) &&
    typeof value.leaseExpiresAt === "string" &&
    !Number.isNaN(Date.parse(value.leaseExpiresAt))
  );
}

export function isStudyAdmissionRequest(value: unknown): value is StudyAdmissionRequest {
  if (!object(value)) return false;
  if (
    typeof value.admissionKey !== "string" ||
    !UUID.test(value.admissionKey) ||
    typeof value.sourceGeneration !== "number" ||
    !Number.isSafeInteger(value.sourceGeneration) ||
    value.sourceGeneration < 1 ||
    typeof value.fencingToken !== "string" ||
    !FENCE.test(value.fencingToken) ||
    typeof value.studyInstanceUid !== "string" ||
    value.studyInstanceUid.length > 64 ||
    !UID.test(value.studyInstanceUid) ||
    typeof value.orthancStudyId !== "string" ||
    !value.orthancStudyId.trim() ||
    value.orthancStudyId.length > 200
  )
    return false;
  const bounds: Readonly<Record<string, number>> = {
    patientId: 64,
    patientIssuerOfPatientId: 64,
    patientName: 200,
    patientBirthDate: 8,
    patientSex: 16,
    studyDate: 8,
    studyTime: 16,
    studyDescription: 256,
    accessionNumber: 64,
    modalities: 128,
  };
  return Object.entries(bounds).every(([key, maximum]) => {
    const entry = value[key];
    return (
      entry === undefined ||
      entry === null ||
      (typeof entry === "string" &&
        entry.length <= maximum &&
        !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(entry))
    );
  });
}

export function isStudyAdmissionResponse(value: unknown): value is StudyAdmissionResponse {
  if (!(
    object(value) &&
    typeof value.reportId === "string" &&
    UUID.test(value.reportId) &&
    typeof value.studyInstanceUid === "string" &&
    UID.test(value.studyInstanceUid) &&
    Number.isSafeInteger(value.version) &&
    (value.version as number) > 0
  ))
    return false;

  const { currentManifestRevision, currentManifestDigest, currentManifestGeneration } = value;
  if (
    currentManifestRevision === null &&
    currentManifestDigest === null &&
    currentManifestGeneration === null
  )
    return true;
  return (
    Number.isSafeInteger(currentManifestRevision) &&
    (currentManifestRevision as number) > 0 &&
    typeof currentManifestDigest === "string" &&
    /^[a-f0-9]{64}$/u.test(currentManifestDigest) &&
    Number.isSafeInteger(currentManifestGeneration) &&
    (currentManifestGeneration as number) > 0
  );
}

export function isUploadAdmissionResponse(value: unknown): value is UploadAdmissionResponse {
  if (!object(value) || typeof value.uploadId !== "string" || !UUID.test(value.uploadId))
    return false;
  if (value.status === "received" || value.status === "completed") return true;
  if (typeof value.expiresAt !== "string" || Number.isNaN(Date.parse(value.expiresAt)))
    return false;
  if (value.mode === "put") return isSignedUploadRequest(value.put);
  if (
    value.mode !== "multipart" ||
    typeof value.multipartUploadId !== "string" ||
    !value.multipartUploadId ||
    !Array.isArray(value.parts) ||
    value.parts.length < 1 ||
    value.parts.length > 10_000
  )
    return false;
  let offset = 0;
  const numbers = new Set<number>();
  for (const part of value.parts) {
    if (
      !object(part) ||
      !Number.isInteger(part.partNumber) ||
      (part.partNumber as number) < 1 ||
      numbers.has(part.partNumber as number) ||
      part.offset !== offset ||
      !Number.isSafeInteger(part.byteCount) ||
      (part.byteCount as number) < 1 ||
      !isSignedUploadRequest(part.put) ||
      (part.acknowledgedEtag !== undefined && typeof part.acknowledgedEtag !== "string")
    )
      return false;
    numbers.add(part.partNumber as number);
    offset += part.byteCount as number;
  }
  return true;
}

export function isUploadStatusResponse(value: unknown): value is UploadStatusResponse {
  return (
    object(value) &&
    ["admitted", "uploading", "received", "completed", "expired", "aborted"].includes(
      String(value.status),
    )
  );
}

export function isManifestBeginResponse(value: unknown): value is ManifestBeginResponse {
  return object(value) && (value.revision === null || isPositiveInteger(value.revision));
}

export function isManifestBeginRequest(value: unknown): value is ManifestBeginRequest {
  return (
    object(value) &&
    hasManifestFence(value) &&
    typeof value.inventoryAttemptId === "string" &&
    UUID.test(value.inventoryAttemptId) &&
    (value.expectedCurrentRevision === null || isPositiveInteger(value.expectedCurrentRevision)) &&
    isPositiveInteger(value.expectedReportVersion)
  );
}

export function isManifestPageResponse(value: unknown): value is ManifestPageResponse {
  return object(value) && Number.isSafeInteger(value.accepted) && (value.accepted as number) >= 0;
}

export function isManifestSealResponse(value: unknown): value is ManifestSealResponse {
  return object(value) && typeof value.sealed === "boolean";
}

export function isManifestMember(value: unknown): value is ManifestMember {
  return (
    object(value) &&
    typeof value.sopInstanceUid === "string" &&
    value.sopInstanceUid.length <= 64 &&
    UID.test(value.sopInstanceUid) &&
    typeof value.sha256 === "string" &&
    SHA256.test(value.sha256)
  );
}

export function isManifestPageRequest(value: unknown): value is ManifestPageRequest {
  return (
    object(value) &&
    hasManifestFence(value) &&
    typeof value.inventoryAttemptId === "string" &&
    UUID.test(value.inventoryAttemptId) &&
    isPositiveInteger(value.revision) &&
    isPositiveInteger(value.expectedReportVersion) &&
    Array.isArray(value.members) &&
    value.members.length > 0 &&
    value.members.length <= 500 &&
    value.members.every(isManifestMember)
  );
}

export function isManifestSealRequest(value: unknown): value is ManifestSealRequest {
  return (
    object(value) &&
    hasManifestFence(value) &&
    typeof value.inventoryAttemptId === "string" &&
    UUID.test(value.inventoryAttemptId) &&
    isPositiveInteger(value.revision) &&
    (value.expectedCurrentRevision === null || isPositiveInteger(value.expectedCurrentRevision)) &&
    isPositiveInteger(value.expectedReportVersion) &&
    typeof value.sourceObservedAt === "string" &&
    !Number.isNaN(Date.parse(value.sourceObservedAt)) &&
    value.sourceStable === true &&
    value.inventoryComplete === true &&
    typeof value.observedManifestDigest === "string" &&
    SHA256.test(value.observedManifestDigest)
  );
}

function hasManifestFence(value: Record<string, unknown>): boolean {
  return (
    isPositiveInteger(value.sourceGeneration) &&
    typeof value.fencingToken === "string" &&
    FENCE.test(value.fencingToken)
  );
}

function isSignedUploadRequest(value: unknown): value is SignedUploadRequest {
  if (!object(value) || typeof value.url !== "string" || !object(value.headers)) return false;
  return Object.entries(value.headers).every(
    ([name, headerValue]) =>
      /^[a-z0-9-]{1,80}$/i.test(name) &&
      typeof headerValue === "string" &&
      headerValue.length <= 2048 &&
      name.toLowerCase() !== "authorization",
  );
}
