import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, rename, rm, statfs, readdir } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import type { InstanceObservation } from "../discovery/model.js";
import type { OrthancDiscoveryClient } from "../orthanc/discovery-client.js";
import type { CheckpointStore } from "../persistence/checkpoint-store.js";
import type { LocalUpload } from "../persistence/upload-spool-store.js";

export class SpoolCapacityError extends Error {}
export class SourceBytesChangedError extends Error {}
export class StaleUploadGenerationError extends Error {}

export interface SpoolOptions {
  directory: string;
  maximumObjectBytes: number;
  reserveFreeBytes: number;
  freeBytes?: (directory: string) => Promise<number>;
  reopenReceived?: boolean;
  signal?: AbortSignal;
}

const availableBytes = async (directory: string): Promise<number> => {
  const stats = await statfs(directory);
  return stats.bavail * stats.bsize;
};

async function digestSource(
  orthanc: OrthancDiscoveryClient,
  instanceId: string,
  maximumBytes: number,
): Promise<{ sha256: string; byteCount: number }> {
  const response = await orthanc.openInstanceFile(instanceId);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isSafeInteger(declared) && declared > maximumBytes) {
    await response.body?.cancel();
    throw new SpoolCapacityError("Orthanc instance exceeds the configured spool object limit");
  }
  const digest = createHash("sha256");
  const reader = response.body!.getReader();
  let byteCount = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      byteCount += part.value.byteLength;
      if (byteCount > maximumBytes) {
        await reader.cancel();
        throw new SpoolCapacityError("Orthanc stream exceeded the configured spool object limit");
      }
      digest.update(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return { sha256: digest.digest("hex"), byteCount };
}

/** Stable RFC 4122 UUIDv5 using the DNS namespace and local source+SOP identity. */
export function stableAdmissionKey(sourceKey: string, sopInstanceUid: string): string {
  return stableUuidV5(`${sourceKey}\0sop\0${sopInstanceUid}`);
}

export function stableStudyAdmissionKey(sourceKey: string, studyInstanceUid: string): string {
  return stableUuidV5(`${sourceKey}\0study\0${studyInstanceUid}`);
}

function stableUuidV5(name: string): string {
  const namespace = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex");
  const digest = createHash("sha1").update(namespace).update(name).digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function verifySourceUnchanged(
  upload: LocalUpload,
  orthanc: OrthancDiscoveryClient,
  maximumObjectBytes: number,
): Promise<void> {
  const current = await digestSource(orthanc, upload.orthancInstanceId, maximumObjectBytes);
  if (current.byteCount !== upload.byteCount || current.sha256 !== upload.sha256) {
    throw new SourceBytesChangedError(
      "Source DICOM bytes changed after the local spool was created",
    );
  }
}

export async function spoolInstance(
  sourceKey: string,
  generation: number,
  instance: InstanceObservation,
  orthanc: OrthancDiscoveryClient,
  store: CheckpointStore,
  options: SpoolOptions,
): Promise<LocalUpload> {
  if (!Number.isSafeInteger(options.maximumObjectBytes) || options.maximumObjectBytes < 1) {
    throw new Error("maximumObjectBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(options.reserveFreeBytes) || options.reserveFreeBytes < 0) {
    throw new Error("reserveFreeBytes must be a non-negative safe integer");
  }
  if (!instance.seriesInstanceUid)
    throw new Error("instance is missing its required SeriesInstanceUID");
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const existing = store.uploads.findBySop(sourceKey, instance.sopInstanceUid);
  let superseding = false;
  let reopeningReceived = false;
  if (existing) {
    if (
      existing.studyInstanceUid !== instance.studyInstanceUid ||
      existing.seriesInstanceUid !== instance.seriesInstanceUid
    ) {
      throw new Error("DICOM UID identity differs from the durable spool reservation");
    }
    if (existing.generation !== generation) {
      if (
        existing.uploadId !== null ||
        (existing.state !== "spooled" && existing.state !== "needs-attention")
      ) {
        store.uploads.markGenerationConflict(
          existing.admissionKey,
          "Source generation changed after cloud admission; reconcile cloud status and source bytes",
        );
        throw new StaleUploadGenerationError(
          "SOPInstanceUID already has cloud state from an older source generation",
        );
      }
      superseding = true;
    } else {
      reopeningReceived =
        options.reopenReceived === true &&
        existing.state === "received" &&
        existing.spoolPath === null;
      if (!reopeningReceived) return existing;
    }
  }

  const freeBytes = options.freeBytes ?? availableBytes;
  if ((await freeBytes(options.directory)) <= options.reserveFreeBytes) {
    throw new SpoolCapacityError("Spool volume is below its protected free-space reserve");
  }
  const response = await orthanc.openInstanceFile(instance.orthancInstanceId, options.signal);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isSafeInteger(declared) && declared > options.maximumObjectBytes) {
    await response.body?.cancel();
    throw new SpoolCapacityError("Orthanc instance exceeds the configured spool object limit");
  }
  if (
    Number.isSafeInteger(declared) &&
    (await freeBytes(options.directory)) < declared + options.reserveFreeBytes
  ) {
    await response.body?.cancel();
    throw new SpoolCapacityError(
      "Spool volume cannot reserve the complete instance and safety margin",
    );
  }

  const admissionKey =
    existing?.admissionKey ?? stableAdmissionKey(sourceKey, instance.sopInstanceUid);
  const finalPath = join(options.directory, `${randomUUID()}.spool`);
  const partialPath = `${finalPath}.partial`;
  const file = await open(partialPath, "wx", 0o600);
  const digest = createHash("sha256");
  const reader = response.body!.getReader();
  let byteCount = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      byteCount += part.value.byteLength;
      if (byteCount > options.maximumObjectBytes) {
        await reader.cancel();
        throw new SpoolCapacityError("Orthanc stream exceeded the configured spool object limit");
      }
      if ((await freeBytes(options.directory)) < part.value.byteLength + options.reserveFreeBytes) {
        await reader.cancel();
        throw new SpoolCapacityError("Spool volume reached its protected free-space reserve");
      }
      digest.update(part.value);
      let offset = 0;
      while (offset < part.value.byteLength) {
        const written = await file.write(part.value, offset, part.value.byteLength - offset);
        if (written.bytesWritten === 0) throw new Error("Spool write made no progress");
        offset += written.bytesWritten;
      }
    }
    if (byteCount === 0 || (Number.isSafeInteger(declared) && declared !== byteCount)) {
      throw new Error("Orthanc instance file length was empty or changed during download");
    }
    await file.sync();
    await file.close();
    await rename(partialPath, finalPath);
    const sha256 = digest.digest("hex");
    try {
      const spoolRecord = {
        admissionKey,
        sourceKey,
        generation,
        orthancInstanceId: instance.orthancInstanceId,
        studyInstanceUid: instance.studyInstanceUid,
        seriesInstanceUid: instance.seriesInstanceUid,
        sopInstanceUid: instance.sopInstanceUid,
        spoolPath: finalPath,
        byteCount,
        sha256,
      };
      if (reopeningReceived) {
        if (existing!.sha256 !== sha256 || existing!.byteCount !== byteCount) {
          store.uploads.markAttention(
            existing!.admissionKey,
            existing!.generation,
            "Source bytes changed after cloud receipt; review required before re-admission",
          );
          throw new SourceBytesChangedError(
            "Source bytes changed after cloud receipt; upload remains blocked",
          );
        }
        if (options.signal?.aborted) {
          throw (
            options.signal.reason ?? new Error("cloud source lease was lost during revalidation")
          );
        }
        return store.uploads.reopenReceivedSpool(spoolRecord);
      }
      if (superseding) {
        if (
          existing!.studyInstanceUid !== instance.studyInstanceUid ||
          existing!.seriesInstanceUid !== instance.seriesInstanceUid
        ) {
          store.uploads.markGenerationConflict(
            existing!.admissionKey,
            "Source generation changed with a different Study or Series UID for this SOP",
          );
          throw new Error("SOPInstanceUID identity changed across source generations");
        }
        if (existing!.sha256 !== sha256 || existing!.byteCount !== byteCount) {
          store.uploads.markGenerationConflict(
            existing!.admissionKey,
            "Source generation changed with different bytes for this SOP; cloud reconciliation required",
          );
          throw new Error("SOPInstanceUID bytes changed across source generations");
        }
        const replaced = store.uploads.supersedeUnadmittedSpool(spoolRecord);
        if (replaced.upload.spoolPath !== finalPath) await rm(finalPath, { force: true });
        if (replaced.previousSpoolPath && replaced.previousSpoolPath !== finalPath) {
          await rm(replaced.previousSpoolPath, { force: true });
        }
        return replaced.upload;
      }
      const stored = store.uploads.insertSpool(spoolRecord);
      if (stored.spoolPath !== finalPath) await rm(finalPath, { force: true });
      return stored;
    } catch (error) {
      await rm(finalPath, { force: true });
      throw error;
    }
  } catch (error) {
    await file.close().catch(() => undefined);
    await rm(partialPath, { force: true });
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Remove only untracked spool artifacts in this private spool directory at startup. */
export async function pruneOrphanedSpools(
  directory: string,
  store: CheckpointStore,
): Promise<{ removedPartial: number; removedSpool: number }> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = resolve(directory);
  const tracked = new Set(store.uploads.listSpoolPaths().map((path) => resolve(path)));
  let removedPartial = 0;
  let removedSpool = 0;
  for (const name of await readdir(root)) {
    const path = join(root, name);
    const isOwnedName = /^[0-9a-f-]{36}\.spool(?:\.partial)?$/i.test(basename(path));
    if (!isOwnedName) continue;
    const resolved = resolve(path);
    if (!resolved.startsWith(`${root}${sep}`)) continue;
    if (name.endsWith(".partial")) {
      await rm(path, { force: true });
      removedPartial += 1;
    } else if (!tracked.has(resolved)) {
      await rm(path, { force: true });
      removedSpool += 1;
    }
  }
  return { removedPartial, removedSpool };
}
