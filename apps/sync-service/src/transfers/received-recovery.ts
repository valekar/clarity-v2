import type { CheckpointStore } from "../persistence/checkpoint-store.js";
import type { LocalUpload } from "../persistence/upload-spool-store.js";
import type { InstanceObservation } from "../discovery/model.js";
import { OrthancHttpError } from "../orthanc/discovery-client.js";
import type { OrthancDiscoveryClient } from "../orthanc/discovery-client.js";
import type { IngestionClient } from "./ingestion-client.js";
import { spoolInstance, type SpoolOptions } from "./spool-instance.js";

/** Reconciles a received row under the current cloud fence before touching source bytes. */
export async function recoverReceivedUpload(
  upload: LocalUpload,
  generation: number,
  instance: InstanceObservation,
  orthanc: OrthancDiscoveryClient,
  store: CheckpointStore,
  cloud: IngestionClient,
  options: SpoolOptions,
): Promise<LocalUpload | "pending" | "completed"> {
  if (upload.state !== "received" || upload.spoolPath !== null) {
    throw new Error("received recovery requires a terminal local row without a spool");
  }
  if (upload.generation !== generation) {
    throw new Error("received recovery cannot cross a local source generation");
  }
  if (
    upload.studyInstanceUid !== instance.studyInstanceUid ||
    upload.seriesInstanceUid !== instance.seriesInstanceUid ||
    upload.sopInstanceUid !== instance.sopInstanceUid
  ) {
    store.uploads.markAttention(
      upload.admissionKey,
      generation,
      "Discovered DICOM UID identity changed after cloud receipt; operator review required",
    );
    throw new Error("discovered DICOM UID identity differs from the received upload");
  }

  const heartbeat = await cloud.startLeaseHeartbeat();
  try {
    if (upload.uploadId) {
      try {
        if ((await cloud.status(upload.uploadId)) === "completed") return "completed";
      } catch {
        // Current-fence authorization below is the authoritative reconciliation operation.
      }
    }
    const authorization = await cloud.authorize(upload);
    if (heartbeat.signal.aborted) {
      throw heartbeat.signal.reason ?? new Error("cloud source lease was lost during recovery");
    }
    if ("status" in authorization) {
      if (authorization.status === "received") return "pending";
      if (authorization.status === "completed") return "completed";
      throw new Error("cloud did not provide a current authorization for the received upload");
    }

    let reopened: LocalUpload;
    try {
      reopened = await spoolInstance(upload.sourceKey, generation, instance, orthanc, store, {
        ...options,
        reopenReceived: true,
        signal: heartbeat.signal,
      });
    } catch (error) {
      if (error instanceof OrthancHttpError && (error.status === 404 || error.status === 410)) {
        store.uploads.markAttention(
          upload.admissionKey,
          generation,
          "Source instance is missing while recovering a cloud receipt; operator review required",
        );
      }
      throw error;
    }
    if (heartbeat.signal.aborted) {
      throw heartbeat.signal.reason ?? new Error("cloud source lease was lost during recovery");
    }
    return reopened;
  } finally {
    heartbeat.stop();
  }
}
