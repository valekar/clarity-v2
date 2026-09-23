import { randomUUID } from "node:crypto";
import type { CheckpointStore, QueueJob } from "../persistence/checkpoint-store.js";
import { OrthancHttpError, type OrthancDiscoveryClient } from "../orthanc/discovery-client.js";

export interface QueueProcessResult {
  completed: number;
  reconciliationPending: number;
  remaining: number;
}

/** Applies durable change jobs to the local logical Reports and UID manifest. */
export class DiscoveryQueueProcessor {
  readonly #store: CheckpointStore;
  readonly #orthanc: OrthancDiscoveryClient;
  readonly #ownerId = randomUUID();

  constructor(store: CheckpointStore, orthanc: OrthancDiscoveryClient) {
    this.#store = store;
    this.#orthanc = orthanc;
  }

  async process(
    sourceKey: string,
    limit = 100,
    throughSequence?: number,
  ): Promise<QueueProcessResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("queue limit must be an integer between 1 and 500");
    }
    if (!this.#store.acquireQueueLease(sourceKey, this.#ownerId)) {
      return {
        completed: 0,
        reconciliationPending: this.#store
          .listPending(sourceKey, 500)
          .filter((job) => job.changeType === "reconcile-source").length,
        remaining: this.#store.listPendingWork(sourceKey, 500, throughSequence).length,
      };
    }
    try {
      const jobs = this.#store.listPendingWork(sourceKey, limit, throughSequence);
      let completed = 0;
      let reconciliationPending = 0;
      for (const job of jobs) {
        if (job.changeType === "reconcile-source") {
          reconciliationPending += 1;
          continue;
        }
        if (!this.#store.renewQueueLease(sourceKey, this.#ownerId)) {
          throw new Error("lost exclusive source queue lease before processing job");
        }
        await this.#processJob(job);
        completed += 1;
      }
      return {
        completed,
        reconciliationPending,
        remaining: this.#store.listPendingWork(sourceKey, 500, throughSequence).length,
      };
    } finally {
      this.#store.releaseQueueLease(sourceKey, this.#ownerId);
    }
  }

  async #processJob(job: QueueJob): Promise<void> {
    this.#store.markProcessing(job.id);
    if (job.changeType === "Deleted") {
      this.#store.discovery.commitQueueDeletion(
        job.id,
        job.sourceKey,
        job.resourceType ?? "",
        job.orthancId ?? "",
        this.#ownerId,
      );
      return;
    }
    if (job.resourceType === "Instance" && job.orthancId) {
      let result;
      try {
        result = await this.#orthanc.getInstance(job.orthancId);
      } catch (error) {
        if (!this.#isNotFound(error)) throw error;
        this.#renewLease(job.sourceKey);
        this.#store.discovery.commitMissingQueueObservation(
          job.id,
          job.sourceKey,
          job.resourceType,
          job.orthancId,
          this.#ownerId,
        );
        return;
      }
      this.#renewLease(job.sourceKey);
      this.#store.discovery.commitQueueStudy(
        job.id,
        job.sourceKey,
        this.#ownerId,
        result.study,
        result.instance,
      );
      return;
    }
    if (job.resourceType === "Study" && job.orthancId) {
      let study;
      try {
        study = await this.#orthanc.getStudy(job.orthancId);
      } catch (error) {
        if (!this.#isNotFound(error)) throw error;
        this.#renewLease(job.sourceKey);
        this.#store.discovery.commitMissingQueueObservation(
          job.id,
          job.sourceKey,
          job.resourceType,
          job.orthancId,
          this.#ownerId,
        );
        return;
      }
      this.#renewLease(job.sourceKey);
      this.#store.discovery.commitQueueStudy(job.id, job.sourceKey, this.#ownerId, study);
      return;
    }
    // Patient/series-only notices do not establish Report identity. Their
    // related Study or Instance event is the durable discovery unit.
    this.#store.discovery.completeIgnoredQueueJob(job.id, job.sourceKey, this.#ownerId);
  }

  #isNotFound(error: unknown): boolean {
    return error instanceof OrthancHttpError && error.status === 404;
  }

  #renewLease(sourceKey: string): void {
    if (!this.#store.renewQueueLease(sourceKey, this.#ownerId)) {
      throw new Error("lost exclusive source queue lease while fetching Orthanc metadata");
    }
  }
}
