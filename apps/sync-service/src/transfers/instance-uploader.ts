import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { unlink } from "node:fs/promises";
import type { OrthancDiscoveryClient } from "../orthanc/discovery-client.js";
import type { CheckpointStore } from "../persistence/checkpoint-store.js";
import type { LocalPartReceipt, LocalUpload } from "../persistence/upload-spool-store.js";
import {
  IngestionClient,
  UploadAuthorizationExpiredError,
  type UploadPartPlan,
  type UploadSession,
} from "./ingestion-client.js";
import {
  SourceBytesChangedError,
  StaleUploadGenerationError,
  verifySourceUnchanged,
} from "./spool-instance.js";

export interface UploadResult {
  state: "received" | "already-received";
  byteCount: number;
  sha256: string;
}

export class LocalSpoolChangedError extends Error {}

async function hashRange(path: string, offset: number, byteCount: number): Promise<string> {
  const digest = createHash("sha256");
  const stream = createReadStream(path, { start: offset, end: offset + byteCount - 1 });
  for await (const chunk of stream) digest.update(chunk as Buffer);
  return digest.digest("hex");
}

async function hashFile(
  path: string,
  maximumBytes: number,
): Promise<{ sha256: string; byteCount: number }> {
  const digest = createHash("sha256");
  let byteCount = 0;
  for await (const chunk of createReadStream(path)) {
    byteCount += chunk.byteLength;
    if (byteCount > maximumBytes)
      throw new LocalSpoolChangedError("local spool exceeded its configured size bound");
    digest.update(chunk as Buffer);
  }
  return { sha256: digest.digest("hex"), byteCount };
}

function assertPartCoverage(parts: readonly UploadPartPlan[], byteCount: number): void {
  if (parts.length < 1 || parts.length > 10_000)
    throw new Error("multipart plan has an invalid part count");
  let offset = 0;
  const numbers = new Set<number>();
  for (const part of [...parts].sort((left, right) => left.offset - right.offset)) {
    if (numbers.has(part.partNumber) || part.offset !== offset) {
      throw new Error("multipart ranges have duplicate numbers, gaps, or overlap");
    }
    numbers.add(part.partNumber);
    offset += part.byteCount;
  }
  if (offset !== byteCount)
    throw new Error("multipart ranges do not cover the complete spool file");
}

export class InstanceUploader {
  constructor(
    private readonly sourceKey: string,
    private readonly store: CheckpointStore,
    private readonly orthanc: OrthancDiscoveryClient,
    private readonly cloud: IngestionClient,
    private readonly maximumObjectBytes: number,
  ) {}

  async send(upload: LocalUpload): Promise<UploadResult> {
    if (upload.state === "received" && !upload.spoolPath) {
      return { state: "already-received", byteCount: upload.byteCount, sha256: upload.sha256 };
    }
    const owner = randomUUID();
    if (!this.store.acquireQueueLease(this.sourceKey, owner, 60_000)) {
      throw new Error("another local worker owns the source upload lease");
    }
    let cloudHeartbeat: Awaited<ReturnType<IngestionClient["startLeaseHeartbeat"]>> | null = null;
    let lost = false;
    const renew = (): void => {
      if (!this.store.renewQueueLease(this.sourceKey, owner, 60_000)) lost = true;
    };
    const timer = setInterval(renew, 15_000);
    const assertLease = (): void => {
      if (cloudHeartbeat?.signal.aborted) {
        throw cloudHeartbeat.signal.reason ?? new Error("cloud source lease was lost");
      }
      if (lost || !this.store.renewQueueLease(this.sourceKey, owner, 60_000)) {
        lost = true;
        throw new Error("source upload lease was lost");
      }
      if (this.store.getCheckpoint(this.sourceKey)?.generation !== upload.generation) {
        throw new StaleUploadGenerationError("upload belongs to a previous source generation");
      }
    };
    try {
      cloudHeartbeat = await this.cloud.startLeaseHeartbeat();
      return await this.#sendWithLease(upload, assertLease, cloudHeartbeat.signal);
    } catch (error) {
      if (cloudHeartbeat?.signal.aborted) {
        try {
          this.store.uploads.markAttention(
            upload.admissionKey,
            upload.generation,
            "Cloud source lease ownership changed during upload; reconcile before retry",
          );
        } catch {
          // A simultaneous local generation reset already fenced this row.
        }
      }
      throw error;
    } finally {
      clearInterval(timer);
      cloudHeartbeat?.stop();
      this.store.releaseQueueLease(this.sourceKey, owner);
    }
  }

  async #sendWithLease(
    upload: LocalUpload,
    assertLease: () => void,
    cloudLeaseSignal: AbortSignal,
  ): Promise<UploadResult> {
    if (upload.state === "received") {
      if (upload.spoolPath) {
        await unlink(upload.spoolPath).catch(() => undefined);
        this.store.uploads.clearReceivedSpoolPath(upload.admissionKey);
      }
      return { state: "already-received", byteCount: upload.byteCount, sha256: upload.sha256 };
    }
    if (upload.sourceKey !== this.sourceKey || !upload.spoolPath) {
      throw new Error("local upload does not have an active spool file");
    }
    if (upload.byteCount > this.maximumObjectBytes) {
      throw new Error("spooled instance exceeds the configured upload size limit");
    }
    assertLease();
    if (upload.state === "completion-unknown" && upload.uploadId) {
      const status = await this.cloud.status(upload.uploadId);
      assertLease();
      if (status === "received" || status === "completed") {
        await this.#clearReceived(upload, assertLease);
        return { state: "received", byteCount: upload.byteCount, sha256: upload.sha256 };
      }
    }
    assertLease();
    const local = await hashFile(upload.spoolPath, this.maximumObjectBytes);
    if (local.byteCount !== upload.byteCount || local.sha256 !== upload.sha256) {
      this.store.uploads.markAttention(
        upload.admissionKey,
        upload.generation,
        "Local spool bytes changed after hashing",
      );
      throw new LocalSpoolChangedError("Local spool bytes changed after hashing");
    }
    try {
      await verifySourceUnchanged(upload, this.orthanc, this.maximumObjectBytes);
      assertLease();
    } catch (error) {
      if (error instanceof SourceBytesChangedError) {
        this.store.uploads.markAttention(upload.admissionKey, upload.generation, error.message);
      }
      throw error;
    }

    let accepted = false;
    let activeUploadId = upload.uploadId;
    let activeMode: UploadSession["mode"] | null = null;
    for (let attempt = 0; attempt < 2 && !accepted; attempt += 1) {
      assertLease();
      const authorization = await this.cloud.authorize(upload);
      assertLease();
      if ("status" in authorization) {
        if (authorization.status !== "received" && authorization.status !== "completed") {
          throw new Error(
            `cloud returned unexpected idempotent upload state ${authorization.status}`,
          );
        }
        await this.#clearReceived(upload, assertLease);
        return { state: "received", byteCount: upload.byteCount, sha256: upload.sha256 };
      }
      const session = authorization;
      activeUploadId = session.uploadId;
      activeMode = session.mode;
      this.store.uploads.recordAuthorization(
        upload.admissionKey,
        upload.generation,
        session.uploadId,
        session.expiresAt,
      );
      if (Date.parse(session.expiresAt) <= Date.now()) {
        if (attempt === 0) continue;
        throw new UploadAuthorizationExpiredError(
          "cloud issued an already-expired upload authorization",
        );
      }
      try {
        if (session.mode === "put") {
          await this.#putWholeFile(upload, session, assertLease, cloudLeaseSignal);
        } else {
          await this.#putParts(upload, session, assertLease, cloudLeaseSignal);
        }
        accepted = true;
      } catch (error) {
        if (!(error instanceof UploadAuthorizationExpiredError) || attempt > 0) throw error;
      }
    }

    assertLease();
    try {
      await verifySourceUnchanged(upload, this.orthanc, this.maximumObjectBytes);
      assertLease();
    } catch (error) {
      if (error instanceof SourceBytesChangedError) {
        this.store.uploads.markAttention(upload.admissionKey, upload.generation, error.message);
      }
      throw error;
    }
    const receipts = this.store.uploads.listParts(upload.admissionKey);
    assertLease();
    this.store.uploads.markCompletionUnknown(upload.admissionKey, upload.generation);
    let state: string;
    try {
      state = await this.cloud.complete(
        activeUploadId!,
        upload.byteCount,
        upload.sha256,
        activeMode === "put" ? [] : receipts,
      );
      assertLease();
    } catch (error) {
      try {
        state = await this.cloud.status(activeUploadId!);
        assertLease();
      } catch {
        throw error;
      }
    }
    if (state !== "received" && state !== "completed") {
      if (state === "expired")
        throw new UploadAuthorizationExpiredError("cloud upload expired before completion");
      throw new Error(`cloud upload is not durably received (state ${state})`);
    }
    assertLease();
    await this.#clearReceived(upload, assertLease);
    return { state: "received", byteCount: upload.byteCount, sha256: upload.sha256 };
  }

  async #clearReceived(upload: LocalUpload, assertLease: () => void): Promise<void> {
    assertLease();
    this.store.uploads.markReceived(upload.admissionKey, upload.generation);
    try {
      await unlink(upload.spoolPath!);
      this.store.uploads.clearReceivedSpoolPath(upload.admissionKey);
    } catch {
      // The durable received state keeps the spool path for startup cleanup.
    }
  }

  async #putWholeFile(
    upload: LocalUpload,
    session: UploadSession,
    assertLease: () => void,
    cloudLeaseSignal: AbortSignal,
  ): Promise<void> {
    if (session.mode !== "put") {
      throw new Error("single PUT authorization contains multipart fields");
    }
    assertLease();
    const etag = await this.cloud.putFile(
      session.put,
      upload.spoolPath!,
      upload.byteCount,
      cloudLeaseSignal,
    );
    assertLease();
    const receipt: LocalPartReceipt = {
      partNumber: 1,
      offset: 0,
      byteCount: upload.byteCount,
      sha256: upload.sha256,
      etag,
    };
    this.store.uploads.recordPart(upload.admissionKey, upload.generation, receipt);
  }

  async #putParts(
    upload: LocalUpload,
    session: UploadSession,
    assertLease: () => void,
    cloudLeaseSignal: AbortSignal,
  ): Promise<void> {
    if (session.mode !== "multipart") {
      throw new Error("multipart authorization is incomplete");
    }
    assertPartCoverage(session.parts, upload.byteCount);
    for (const part of [...session.parts].sort(
      (left, right) => left.partNumber - right.partNumber,
    )) {
      assertLease();
      const sha256 = await hashRange(upload.spoolPath!, part.offset, part.byteCount);
      const etag =
        part.acknowledgedEtag ??
        (await this.cloud.putPart(part.put, upload.spoolPath!, part, cloudLeaseSignal));
      assertLease();
      this.store.uploads.recordPart(upload.admissionKey, upload.generation, {
        partNumber: part.partNumber,
        offset: part.offset,
        byteCount: part.byteCount,
        sha256,
        etag,
      });
    }
  }
}
