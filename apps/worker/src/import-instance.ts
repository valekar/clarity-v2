import { hashStream, InvalidDicomError, ObjectLimitError, readDicomIdentity } from "./dicom.js";
import type { DicomIdentity, ReceivedUpload, WorkerDependencies } from "./contracts.js";
import { InvalidOrthancResponseError } from "./orthanc-client.js";
import { stageIntakeObject, StagingValidationError } from "./staging.js";

export class InvalidIntakeError extends Error {}

function assertIdentity(actual: DicomIdentity, expected: DicomIdentity): void {
  if (
    actual.studyInstanceUid !== expected.studyInstanceUid ||
    actual.seriesInstanceUid !== expected.seriesInstanceUid ||
    actual.sopInstanceUid !== expected.sopInstanceUid
  ) {
    throw new InvalidIntakeError("DICOM UID values do not match the durable upload reservation.");
  }
}

async function verifyIndexedBytes(
  upload: ReceivedUpload,
  instanceId: string,
  dependencies: WorkerDependencies,
): Promise<void> {
  try {
    assertIdentity(await dependencies.index.readIdentity(instanceId), upload);
  } catch (error) {
    if (error instanceof InvalidOrthancResponseError || error instanceof InvalidIntakeError) {
      throw new InvalidIntakeError(error.message);
    }
    throw error;
  }
  const digest = await hashStream(
    await dependencies.index.readBytes(instanceId),
    dependencies.maxObjectBytes,
  );
  if (digest.byteCount !== upload.byteCount || digest.sha256 !== upload.expectedSha256) {
    throw new InvalidIntakeError("Cloud Orthanc readback does not match the admitted bytes.");
  }
}

export async function importReceivedUpload(
  upload: ReceivedUpload,
  dependencies: WorkerDependencies,
): Promise<void> {
  if (!(await dependencies.repository.authorizeImport(upload))) return;
  dependencies.onProgress?.("fence-authorized");
  if (!(await dependencies.repository.assertUidOwnership(upload))) {
    throw new InvalidIntakeError("Global DICOM UID ownership does not match the upload.");
  }
  dependencies.onProgress?.("ownership-verified");
  const claimed = await dependencies.index.findBySopInstanceUid(upload.sopInstanceUid);
  let instanceId: string;
  if (claimed !== undefined) {
    // Reconcile an uncertain prior import by checking indexed identity and bytes.
    await verifyIndexedBytes(upload, claimed, dependencies);
    dependencies.onProgress?.("orthanc-reconciled");
    instanceId = claimed;
  } else {
    const staged = await stageIntakeObject(
      upload,
      dependencies.intake,
      dependencies.stagingDirectory,
      dependencies.maxObjectBytes,
    );
    try {
      dependencies.onProgress?.("staged");
      let parsedIdentity: DicomIdentity;
      try {
        parsedIdentity = await readDicomIdentity(staged.open());
      } catch (error) {
        if (error instanceof InvalidDicomError) throw new InvalidIntakeError(error.message);
        throw error;
      }
      assertIdentity(parsedIdentity, upload);
      dependencies.onProgress?.("dicom-validated");

      // Staging and parsing can take long enough for a device lease to be
      // revoked or superseded. Recheck immediately before the cloud effect.
      if (!(await dependencies.repository.authorizeImport(upload))) return;
      dependencies.onProgress?.("fence-rechecked");
      instanceId = await dependencies.index.importInstance(staged.open(), upload.byteCount);
      dependencies.onProgress?.("orthanc-imported");
      await verifyIndexedBytes(upload, instanceId, dependencies);
      dependencies.onProgress?.("readback-verified");
    } finally {
      await staged.remove().catch(() => undefined);
    }
  }

  // This transaction commits the file reference and upload completion together.
  await dependencies.repository.completeIndexed(upload, instanceId);
  dependencies.onProgress?.("database-committed");
  await cleanupCompletedUpload(upload, dependencies);
}

export async function cleanupCompletedUpload(
  upload: ReceivedUpload,
  dependencies: WorkerDependencies,
): Promise<void> {
  // Cleanup is safe only after the durable commit; pending cleanup is polled after crashes.
  await dependencies.intake.remove(upload);
  dependencies.onProgress?.("intake-cleaned");
  await dependencies.repository.markIntakeCleaned(upload);
}

export async function processReceivedUpload(
  upload: ReceivedUpload,
  dependencies: WorkerDependencies,
): Promise<void> {
  try {
    await importReceivedUpload(upload, dependencies);
  } catch (error) {
    if (
      error instanceof InvalidIntakeError ||
      error instanceof ObjectLimitError ||
      error instanceof StagingValidationError
    ) {
      await dependencies.repository.markAttention(upload);
    }
    dependencies.onProgress?.("attempt-retry");
    throw error;
  }
}
