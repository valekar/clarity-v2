import { createHash } from "node:crypto";
import { statfs } from "node:fs/promises";
import { OrthancUnavailableError } from "../orthanc/errors.js";
import type { InventoryCoordinator } from "../discovery/inventory-coordinator.js";
import type { OrthancDiscoveryClient } from "../orthanc/discovery-client.js";
import type { OrthancChangeFeedAdapter } from "../orthanc/change-feed.js";
import type { CheckpointStore } from "../persistence/checkpoint-store.js";
import { DiscoveryQueueProcessor } from "../discovery/queue-processor.js";
import { IngestionClient, UploadApiError } from "../transfers/ingestion-client.js";
import { InstanceUploader } from "../transfers/instance-uploader.js";
import { recoverReceivedUpload } from "../transfers/received-recovery.js";
import {
  pruneOrphanedSpools,
  spoolInstance,
  stableStudyAdmissionKey,
  StaleUploadGenerationError,
} from "../transfers/spool-instance.js";

export function classifySyncFailure(error: unknown) {
  const sourceUnavailable = error instanceof OrthancUnavailableError;
  return Object.freeze({
    sourceReachable: !sourceUnavailable,
    lastErrorCode: sourceUnavailable ? ("orthanc_unavailable" as const) : ("sync_failed" as const),
  });
}

export function nextPollDelayMs(pollIntervalMs: number, failures: number): number {
  return Math.min(pollIntervalMs * 2 ** failures, 60 * 60_000);
}

function waitForDelayOrAbort(delayMs: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    let settled = false;
    const finish = (continued: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(continued);
    };
    const abort = (): void => finish(false);
    const timer = setTimeout(() => finish(true), delayMs);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export interface SyncLoopOptions {
  sourceKey: string;
  spoolDirectory: string;
  maximumObjectBytes: number;
  reserveFreeBytes: number;
  pageBudget: number;
  uploadBatchSize: number;
  pollIntervalMs: number;
  reconciliationIntervalMs: number;
  idleHealthIntervalMs?: number;
  onDiagnostic?: (message: string) => void;
}

/**
 * Continuously advances local discovery and private admission. This orchestration
 * is injectable for synthetic tests; production startup validates its private
 * source/device configuration before opening local state or entering this loop.
 */
export class SyncLoop {
  readonly #store: CheckpointStore;
  readonly #feed: OrthancChangeFeedAdapter;
  readonly #coordinator: InventoryCoordinator;
  readonly #orthanc: OrthancDiscoveryClient;
  readonly #cloud: IngestionClient;
  readonly #options: SyncLoopOptions;
  readonly #queue: DiscoveryQueueProcessor;
  readonly #uploader: InstanceUploader;
  #started = false;
  #initialComplete = false;
  #lastReconciliationAt = 0;
  #stableGeneration: number | null = null;
  #stableObservedAt: string | null = null;
  #manifestCursor = "";
  #lastSuccessfulSyncAt: string | null = null;
  #sourceReachable = true;
  #lastErrorCode:
    "orthanc_unavailable" | "low_spool_space" | "source_changed" | "sync_failed" | null = null;
  #uploadCursor: string | null = null;
  readonly #admittedStudyObservations = new Map<string, string>();
  readonly #completedUploads = new Set<string>();

  constructor(
    store: CheckpointStore,
    feed: OrthancChangeFeedAdapter,
    coordinator: InventoryCoordinator,
    orthanc: OrthancDiscoveryClient,
    cloud: IngestionClient,
    options: SyncLoopOptions,
  ) {
    if (
      !Number.isInteger(options.pageBudget) ||
      options.pageBudget < 1 ||
      options.pageBudget > 500
    ) {
      throw new Error("pageBudget must be between 1 and 500");
    }
    if (
      !Number.isInteger(options.uploadBatchSize) ||
      options.uploadBatchSize < 1 ||
      options.uploadBatchSize > 100
    ) {
      throw new Error("uploadBatchSize must be between 1 and 100");
    }
    if (options.pollIntervalMs < 250 || options.reconciliationIntervalMs < options.pollIntervalMs) {
      throw new Error("sync intervals are invalid or unbounded");
    }
    if (
      options.idleHealthIntervalMs !== undefined &&
      (!Number.isSafeInteger(options.idleHealthIntervalMs) ||
        options.idleHealthIntervalMs < 10 ||
        options.idleHealthIntervalMs > 60_000)
    ) {
      throw new Error("idle health interval must be between 10 and 60000 milliseconds");
    }
    this.#store = store;
    this.#feed = feed;
    this.#coordinator = coordinator;
    this.#orthanc = orthanc;
    this.#cloud = cloud;
    this.#options = options;
    this.#queue = new DiscoveryQueueProcessor(store, orthanc);
    this.#uploader = new InstanceUploader(
      options.sourceKey,
      store,
      orthanc,
      cloud,
      options.maximumObjectBytes,
    );
  }

  async runOnce(now = Date.now()): Promise<void> {
    if (!this.#started) {
      await pruneOrphanedSpools(this.#options.spoolDirectory, this.#store);
      this.#started = true;
    }
    if (!this.#initialComplete) {
      const result = await this.#coordinator.runInitial(this.#options.pageBudget);
      this.#initialComplete = result.status === "complete";
      if (this.#initialComplete) {
        this.#setStableInventory(result.run?.generation ?? null, result.run?.completedAt ?? null);
      }
    } else {
      const feed = await this.#feed.pollOnce();
      if (feed.changesCaptured > 0 || feed.resetDetected || !feed.done) {
        this.#stableGeneration = null;
        this.#stableObservedAt = null;
        this.#lastReconciliationAt = 0;
      }
      await this.#queue.process(this.#options.sourceKey, 500);
      if (now - this.#lastReconciliationAt >= this.#options.reconciliationIntervalMs) {
        const result = await this.#coordinator.runPeriodicReconciliation(this.#options.pageBudget);
        if (result.status === "complete") {
          this.#lastReconciliationAt = now;
          this.#setStableInventory(result.run?.generation ?? null, result.run?.completedAt ?? null);
        }
        if (result.status !== "complete") {
          this.#diagnostic(`Periodic reconciliation remains ${result.status}`);
        }
      }
    }
    if (this.#stableObservedAt === null || now - Date.parse(this.#stableObservedAt) >= 9 * 60_000) {
      this.#stableGeneration = null;
      this.#lastReconciliationAt = 0;
    }
    await this.#admitDiscoveredBatch();
    if (this.#stableGeneration !== null) await this.#publishStableManifests();
    this.#sourceReachable = true;
    this.#lastSuccessfulSyncAt = new Date(now).toISOString();
    try {
      await this.#publishHealth();
    } catch (error) {
      const status = error instanceof UploadApiError ? ` (HTTP ${error.status})` : "";
      this.#diagnostic(
        `Source health report failed${status}; retry scheduled on the next sync iteration`,
      );
    }
  }

  async #publishHealth(
    sourceReachable = this.#sourceReachable,
    errorCode?: "orthanc_unavailable" | "low_spool_space" | "source_changed" | "sync_failed",
  ): Promise<void> {
    if (typeof this.#cloud.reportHealth !== "function") return;
    const counts = this.#store.getHealthCounts(this.#options.sourceKey);
    let spoolFreeBytes: number | null = null;
    let spoolCapacityBytes: number | null = null;
    try {
      const filesystem = await statfs(this.#options.spoolDirectory, { bigint: true });
      const freeBytes = filesystem.bavail * filesystem.bsize;
      const capacityBytes = filesystem.blocks * filesystem.bsize;
      if (
        freeBytes <= BigInt(Number.MAX_SAFE_INTEGER) &&
        capacityBytes <= BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        spoolFreeBytes = Number(freeBytes);
        spoolCapacityBytes = Number(capacityBytes);
      }
    } catch {
      // Unknown capacity is represented as null; it must not be reported as zero.
    }
    const lowSpace = spoolFreeBytes !== null && spoolFreeBytes <= this.#options.reserveFreeBytes;
    const lastErrorCode = lowSpace ? "low_spool_space" : (errorCode ?? this.#lastErrorCode);
    const report = {
      sourceReachable,
      syncState: lastErrorCode
        ? "attention"
        : counts.queuedStudies + counts.queuedUploads > 0
          ? "syncing"
          : "idle",
      lastErrorCode,
      ...counts,
      spoolFreeBytes,
      spoolCapacityBytes,
      lastSuccessfulSyncAt: this.#lastSuccessfulSyncAt,
    } as const;
    await this.#cloud.reportHealth(report);
    this.#lastErrorCode = lowSpace ? "low_spool_space" : null;
  }

  async #publishStableManifests(): Promise<void> {
    const checkpoint = this.#store.getCheckpoint(this.#options.sourceKey);
    if (!checkpoint || checkpoint.generation !== this.#stableGeneration) return;
    let ordered = this.#store.discovery.listReportPage(
      this.#options.sourceKey,
      this.#manifestCursor || null,
      10,
    );
    if (ordered.length === 0 && this.#manifestCursor) {
      this.#manifestCursor = "";
      ordered = this.#store.discovery.listReportPage(this.#options.sourceKey, null, 10);
    }
    for (const report of ordered) {
      this.#manifestCursor = report.studyInstanceUid;
      if (report.sourceMissing) continue;
      const digest = createHash("sha256").update("[");
      let memberCount = 0;
      let memberOffset = 0;
      let snapshotReady = true;
      for (let pageNumber = 0; pageNumber < 10_000; pageNumber += 1) {
        const page = this.#store.discovery.listManifestMemberPage(
          this.#options.sourceKey,
          report.studyInstanceUid,
          checkpoint.generation,
          memberOffset,
          500,
        );
        if (!page.ready) {
          snapshotReady = false;
          break;
        }
        for (const member of page.members) {
          if (memberCount > 0) digest.update(",");
          digest.update(JSON.stringify(member));
          memberCount += 1;
        }
        memberOffset += page.scanned;
        if (page.scanned < 500) break;
        if (pageNumber === 9_999)
          throw new Error("manifest exceeds its finite 5,000,000-member budget");
      }
      if (!snapshotReady || memberCount === 0) continue;
      digest.update("]");
      const manifestDigest = digest.digest("hex");
      const observation = await this.#cloud.admitStudy(
        report,
        stableStudyAdmissionKey(this.#options.sourceKey, report.studyInstanceUid),
      );
      const cloudLease = await this.#cloud.ensureLease();
      this.#store.manifests.reconcileCloudProof(this.#options.sourceKey, report.studyInstanceUid, {
        currentRevision: observation.currentManifestRevision,
        currentDigest: observation.currentManifestDigest,
        currentGeneration: observation.currentManifestGeneration,
        reportVersion: observation.version,
      });
      const attempt = this.#store.manifests.startAttempt({
        sourceKey: this.#options.sourceKey,
        studyInstanceUid: report.studyInstanceUid,
        generation: checkpoint.generation,
        cloudGeneration: cloudLease.sourceGeneration,
        expectedReportVersion: observation.version,
        digest: manifestDigest,
        observedAt: this.#stableObservedAt!,
      });
      if (!attempt.attemptId) continue;
      let revision = attempt.revision;
      if (revision === null) {
        revision = await this.#cloud.beginManifest(observation.reportId, {
          inventoryAttemptId: attempt.attemptId,
          expectedCurrentRevision: attempt.expectedCurrentRevision,
          expectedReportVersion: attempt.expectedReportVersion!,
        });
        if (revision === null) throw new Error("Cloud did not open a manifest revision");
        this.#store.manifests.recordRevision(
          this.#options.sourceKey,
          report.studyInstanceUid,
          attempt.attemptId,
          revision,
        );
      }
      for (let cursor = attempt.nextMember; cursor < memberCount;) {
        const page = this.#store.discovery.listManifestMemberPage(
          this.#options.sourceKey,
          report.studyInstanceUid,
          checkpoint.generation,
          cursor,
          500,
        );
        if (!page.ready || page.members.length === 0) {
          throw new Error("manifest membership changed during bounded page publication");
        }
        const accepted = await this.#cloud.recordManifestPage(observation.reportId, {
          inventoryAttemptId: attempt.attemptId,
          revision,
          expectedReportVersion: attempt.expectedReportVersion!,
          members: page.members,
        });
        if (accepted !== page.members.length)
          throw new Error("Cloud accepted only part of a manifest page");
        const next = cursor + page.members.length;
        this.#store.manifests.advancePage(
          this.#options.sourceKey,
          report.studyInstanceUid,
          attempt.attemptId,
          cursor,
          next,
        );
        cursor = next;
      }
      if (Date.now() - Date.parse(attempt.observedAt!) >= 9 * 60_000) {
        this.#diagnostic("Manifest inventory aged during page upload; a fresh attempt is required");
        continue;
      }
      const sealed = await this.#cloud.sealManifest(observation.reportId, {
        inventoryAttemptId: attempt.attemptId,
        revision,
        expectedCurrentRevision: attempt.expectedCurrentRevision,
        expectedReportVersion: attempt.expectedReportVersion!,
        sourceObservedAt: attempt.observedAt!,
        sourceStable: true,
        inventoryComplete: true,
        observedManifestDigest: manifestDigest,
      });
      if (!sealed) throw new Error("Cloud did not seal the observed manifest");
      this.#store.manifests.finishAttempt(
        this.#options.sourceKey,
        report.studyInstanceUid,
        attempt.attemptId,
      );
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        await this.runOnce();
        failures = 0;
      } catch (error) {
        const failure = classifySyncFailure(error);
        if (error instanceof OrthancUnavailableError) this.#sourceReachable = false;
        this.#lastErrorCode = failure.lastErrorCode;
        try {
          await this.#publishHealth(this.#sourceReachable, failure.lastErrorCode);
        } catch {
          // A cloud outage prevents recording the source outage; the server marks the prior row stale.
        }
        failures = Math.min(failures + 1, 7);
        this.#diagnostic("Sync iteration failed; retry scheduled");
      }
      const delay = nextPollDelayMs(this.#options.pollIntervalMs, failures);
      await this.#waitUntilNextPoll(delay, signal);
    }
  }

  async #waitUntilNextPoll(delayMs: number, signal: AbortSignal): Promise<void> {
    const heartbeatInterval = this.#options.idleHealthIntervalMs ?? 60_000;
    const pollAt = Date.now() + delayMs;
    let heartbeatAt = Date.now() + heartbeatInterval;

    while (!signal.aborted) {
      const wakeAt = Math.min(pollAt, heartbeatAt);
      const elapsed = wakeAt - Date.now();
      if (elapsed > 0 && !(await waitForDelayOrAbort(elapsed, signal))) return;
      if (signal.aborted || Date.now() >= pollAt) return;

      try {
        // Refresh cloud health and its lease without querying Orthanc or
        // moving any inventory/feed cursor during the configured poll wait.
        await this.#publishHealth(this.#sourceReachable);
      } catch (error) {
        const status = error instanceof UploadApiError ? ` (HTTP ${error.status})` : "";
        this.#diagnostic(`Idle source health heartbeat failed${status}; retry scheduled`);
      }
      heartbeatAt = Date.now() + heartbeatInterval;
    }
  }

  async #admitDiscoveredBatch(): Promise<void> {
    const rows = this.#store.discovery.listDiscoveredInstances(
      this.#options.sourceKey,
      this.#uploadCursor,
      this.#options.uploadBatchSize,
    );
    if (rows.length === 0 && this.#uploadCursor !== null) {
      this.#uploadCursor = null;
      rows.push(
        ...this.#store.discovery.listDiscoveredInstances(
          this.#options.sourceKey,
          null,
          this.#options.uploadBatchSize,
        ),
      );
    }
    const checkpoint = this.#store.getCheckpoint(this.#options.sourceKey);
    if (!checkpoint) return;
    for (const instance of rows) {
      this.#uploadCursor = instance.sopInstanceUid;
      if (instance.sourceMissing || !instance.seriesInstanceUid) continue;
      try {
        const report = this.#store.discovery.getReport(
          this.#options.sourceKey,
          instance.studyInstanceUid,
        );
        if (!report || report.sourceMissing) continue;
        const admissionKey = stableStudyAdmissionKey(
          this.#options.sourceKey,
          report.studyInstanceUid,
        );
        const cloudLease = await this.#cloud.ensureLease();
        const observationKey = JSON.stringify([
          cloudLease.sourceGeneration,
          report.orthancStudyId,
          report.patientId,
          report.patientIssuerOfPatientId,
          report.patientName,
          report.patientBirthDate,
          report.patientSex,
          report.studyDate,
          report.studyTime,
          report.studyDescription,
          report.accessionNumber,
          report.modalities,
        ]);
        if (this.#admittedStudyObservations.get(report.studyInstanceUid) !== observationKey) {
          await this.#cloud.admitStudy(report, admissionKey);
          this.#admittedStudyObservations.set(report.studyInstanceUid, observationKey);
        }
        let upload = this.#store.uploads.findBySop(
          this.#options.sourceKey,
          instance.sopInstanceUid,
        );
        if (
          upload &&
          upload.generation !== checkpoint.generation &&
          upload.state === "needs-attention" &&
          upload.attentionReason?.startsWith("Source generation changed")
        ) {
          continue;
        }
        if (!upload || upload.generation !== checkpoint.generation) {
          upload = await spoolInstance(
            this.#options.sourceKey,
            checkpoint.generation,
            instance,
            this.#orthanc,
            this.#store,
            {
              directory: this.#options.spoolDirectory,
              maximumObjectBytes: this.#options.maximumObjectBytes,
              reserveFreeBytes: this.#options.reserveFreeBytes,
            },
          );
        }
        if (upload.state === "received") {
          if (upload.spoolPath !== null) {
            await this.#uploader.send(upload);
            continue;
          }
          if (upload.uploadId && this.#completedUploads.has(upload.uploadId)) continue;
          const recovery = await recoverReceivedUpload(
            upload,
            checkpoint.generation,
            instance,
            this.#orthanc,
            this.#store,
            this.#cloud,
            {
              directory: this.#options.spoolDirectory,
              maximumObjectBytes: this.#options.maximumObjectBytes,
              reserveFreeBytes: this.#options.reserveFreeBytes,
            },
          );
          if (recovery === "pending") continue;
          if (recovery === "completed") {
            if (upload.uploadId) this.#completedUploads.add(upload.uploadId);
            continue;
          }
          upload = recovery;
        }
        if (upload.state === "needs-attention") continue;
        await this.#uploader.send(upload);
      } catch (error) {
        if (error instanceof StaleUploadGenerationError) {
          this.#diagnostic("A discovered SOP has a spool from an older source generation");
          continue;
        }
        this.#diagnostic("Admission for one discovered SOP deferred; retry scheduled");
      }
    }
    if (rows.length < this.#options.uploadBatchSize) this.#uploadCursor = null;
  }

  #diagnostic(message: string): void {
    this.#options.onDiagnostic?.(message.slice(0, 500));
  }

  #setStableInventory(generation: number | null, completedAt: string | null): void {
    if (!completedAt || Number.isNaN(Date.parse(completedAt))) {
      this.#stableGeneration = null;
      this.#stableObservedAt = null;
      return;
    }
    this.#stableGeneration = generation;
    this.#stableObservedAt = completedAt;
  }
}
