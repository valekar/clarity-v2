import type { CheckpointStore, QueueJob } from "../persistence/checkpoint-store.js";
import type { OrthancChangeFeedAdapter } from "../orthanc/change-feed.js";
import type { OrthancDiscoveryClient } from "../orthanc/discovery-client.js";
import { DiscoveryQueueProcessor } from "./queue-processor.js";
import type { InventoryRun } from "./model.js";
import { decideAnchoredInstancePage } from "./anchored-instance-page.js";

export interface InventoryStepResult {
  run: InventoryRun | null;
  status:
    | "catching-up"
    | "scanning"
    | "revalidating"
    | "replaying"
    | "complete"
    | "reconciliation-pending";
  pagesProcessed: number;
}

/**
 * Bounded initial discovery and periodic reconciliation. Each call has a page
 * budget; SQLite progress makes the same run resumable after process restart.
 */
export class InventoryCoordinator {
  readonly #store: CheckpointStore;
  readonly #feed: OrthancChangeFeedAdapter;
  readonly #orthanc: OrthancDiscoveryClient;
  readonly #queue: DiscoveryQueueProcessor;
  readonly #sourceKey: string;

  constructor(
    store: CheckpointStore,
    feed: OrthancChangeFeedAdapter,
    orthanc: OrthancDiscoveryClient,
    sourceKey: string,
  ) {
    this.#store = store;
    this.#feed = feed;
    this.#orthanc = orthanc;
    this.#queue = new DiscoveryQueueProcessor(store, orthanc);
    this.#sourceKey = sourceKey;
  }

  runInitial(pageBudget = 10): Promise<InventoryStepResult> {
    return this.#run("initial", pageBudget);
  }

  runPeriodicReconciliation(pageBudget = 10): Promise<InventoryStepResult> {
    return this.#run("periodic", pageBudget);
  }

  async #run(kind: "initial" | "periodic", pageBudget: number): Promise<InventoryStepResult> {
    if (!Number.isInteger(pageBudget) || pageBudget < 1 || pageBudget > 500) {
      throw new Error("pageBudget must be an integer between 1 and 500");
    }
    let run = this.#findRun(kind);
    if (run) run = this.#store.discovery.reconcileInventoryGeneration(run.id);
    let pagesProcessed = 0;
    if (!run) {
      const caughtUp = await this.#catchUp(pageBudget);
      pagesProcessed += caughtUp.pages;
      if (!caughtUp.done) return { run: null, status: "catching-up", pagesProcessed };
      const reconcileJob = this.#pendingReconciliation()[0] ?? null;
      const upperBound = await this.#orthanc.getGlobalInstanceUpperBound();
      run = this.#store.discovery.startInventory(
        this.#sourceKey,
        kind,
        reconcileJob?.id ?? null,
        upperBound,
      );
      run = this.#store.discovery.reconcileInventoryGeneration(run.id);
      if (run.status === "complete") return { run, status: "complete", pagesProcessed };
    }

    while (pagesProcessed < pageBudget && run.status === "scanning-instances") {
      if (!run.upperBoundCaptured) {
        run = this.#store.discovery.captureInventoryUpperBound(
          run.id,
          await this.#orthanc.getGlobalInstanceUpperBound(),
        );
      }
      const page = await this.#orthanc.listInstanceIds(
        run.nextInstanceOffset,
        this.#orthanc.inventoryPageSize,
      );
      pagesProcessed += 1;
      const decision = decideAnchoredInstancePage(
        run.nextInstanceOffset,
        page.ids,
        run.lastInstanceId,
        run.upperInstanceId,
        this.#orthanc.inventoryPageSize,
      );
      if (decision.action === "retry") {
        run = this.#store.discovery.repositionInventoryOffset(
          run.id,
          run.nextInstanceOffset,
          decision.nextOffset,
        );
        break;
      }
      const pairs = await this.#orthanc.resolveInstances(decision.acceptedIds);
      run = this.#store.discovery.recordAnchoredInstancePage(
        run.id,
        run.nextInstanceOffset,
        decision.nextOffset,
        run.lastInstanceId,
        decision.nextAnchor,
        pairs,
        decision.action === "complete",
      );
      if (decision.action === "complete") {
        break;
      }
    }

    while (pagesProcessed < pageBudget && run.status === "revalidating") {
      const batch = this.#store.discovery.listInventoryRevalidationBatch(run.id, 100);
      if (batch.length === 0) {
        run = this.#store.discovery.finishInventoryRevalidation(run.id);
        break;
      }
      const outcomes = await this.#orthanc.revalidateKnownInstances(batch);
      run = this.#store.discovery.commitInventoryRevalidationBatch(
        run.id,
        run.revalidationAfterSopUid,
        outcomes,
      );
      pagesProcessed += 1;
    }

    if (run.status === "scanning-studies" || run.status === "scanning-instances") {
      return { run, status: "scanning", pagesProcessed };
    }
    while (pagesProcessed < pageBudget && run.status === "awaiting-replay") {
      let pageDone = run.feedDoneAtHorizon;
      if (run.feedHorizon === null) {
        const page = await this.#feed.pollOnce();
        pagesProcessed += 1;
        pageDone = page.done;
        const restarted = this.#store.discovery.restartInventoryAfterFeedChanges(run.id);
        if (restarted) return { run: restarted, status: "scanning", pagesProcessed };
        run = this.#store.discovery.freezeInventoryFeedHorizon(run.id, page.done);
      }
      const queued = await this.#queue.process(this.#sourceKey, 500, run.feedHorizon!);
      if (queued.remaining > 0) {
        return { run, status: "replaying", pagesProcessed };
      }
      const verification = this.#store.discovery.advanceInventoryVerification(run.id);
      if (verification.id !== run.id) {
        return { run: verification, status: "scanning", pagesProcessed };
      }
      const unrelatedReconciliations = this.#pendingReconciliation().filter(
        (job) => job.id !== run!.reconcileJobId,
      );
      if (pageDone === false) {
        run = this.#store.discovery.releaseDrainedInventoryFeedHorizon(run.id);
        return { run, status: "reconciliation-pending", pagesProcessed };
      }
      run = this.#store.discovery.completeInventory(run.id);
      if (run.status !== "complete") {
        return { run, status: "scanning", pagesProcessed };
      }
      if (unrelatedReconciliations.length > 0) {
        return { run, status: "reconciliation-pending", pagesProcessed };
      }
    }
    return {
      run,
      status:
        run.status === "complete"
          ? "complete"
          : run.status === "revalidating"
            ? "revalidating"
            : run.status.startsWith("scanning-")
              ? "scanning"
              : "replaying",
      pagesProcessed,
    };
  }

  async #catchUp(pageBudget: number): Promise<{ done: boolean; pages: number }> {
    void pageBudget;
    await this.#feed.pollOnce();
    return { done: true, pages: 1 };
  }

  #findRun(kind: "initial" | "periodic"): InventoryRun | null {
    return this.#store.discovery.findInventoryRun(this.#sourceKey, kind, kind === "initial");
  }

  #pendingReconciliation(): QueueJob[] {
    return this.#store
      .listPending(this.#sourceKey, 500)
      .filter((job) => job.changeType === "reconcile-source");
  }
}
