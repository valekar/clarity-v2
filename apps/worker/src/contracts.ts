import type { DicomIdentity } from "@clarity/imaging";

export type { DicomIdentity } from "@clarity/imaging";

export type ReceivedUpload = Readonly<{
  uploadId: string;
  reportId: string;
  sourceId: string;
  reportFileId: string;
  objectKey: string;
  expectedSha256: string;
  byteCount: number;
  studyInstanceUid: string;
  seriesInstanceUid: string;
  sopInstanceUid: string;
}>;

export interface IntakeObjects {
  open(upload: ReceivedUpload): Promise<ReadableStream<Uint8Array>>;
  remove(upload: ReceivedUpload): Promise<void>;
}

export interface CloudIndex {
  findBySopInstanceUid(uid: string): Promise<string | undefined>;
  importInstance(bytes: ReadableStream<Uint8Array>, byteCount: number): Promise<string>;
  readIdentity(instanceId: string): Promise<DicomIdentity>;
  readBytes(instanceId: string): Promise<ReadableStream<Uint8Array>>;
}

export interface WorkerRepository {
  listReceived(limit: number): Promise<readonly ReceivedUpload[]>;
  listCleanupPending(limit: number): Promise<readonly ReceivedUpload[]>;
  authorizeImport(upload: ReceivedUpload): Promise<boolean>;
  assertUidOwnership(upload: ReceivedUpload): Promise<boolean>;
  completeIndexed(upload: ReceivedUpload, instanceId: string): Promise<void>;
  markIntakeCleaned(upload: ReceivedUpload): Promise<void>;
  markAttention(upload: ReceivedUpload): Promise<void>;
}

export type WorkerDependencies = Readonly<{
  repository: WorkerRepository;
  intake: IntakeObjects;
  index: CloudIndex;
  maxObjectBytes: number;
  stagingDirectory: string;
  onProgress?: (
    event:
      | "fence-authorized"
      | "ownership-verified"
      | "orthanc-reconciled"
      | "staged"
      | "dicom-validated"
      | "fence-rechecked"
      | "orthanc-imported"
      | "readback-verified"
      | "database-committed"
      | "intake-cleaned"
      | "attempt-retry",
  ) => void;
}>;
