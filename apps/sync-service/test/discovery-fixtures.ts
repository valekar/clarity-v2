import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before } from "node:test";
import { InventoryCoordinator } from "../src/discovery/inventory-coordinator.js";
import { CheckpointStore } from "../src/persistence/checkpoint-store.js";
import { OrthancChangeFeedAdapter } from "../src/orthanc/change-feed.js";
import { OrthancDiscoveryClient } from "../src/orthanc/discovery-client.js";

export interface SyntheticInstance {
  id: string;
  sopUid: string;
}

export interface SyntheticStudy {
  id: string;
  uid: string;
  seriesId: string;
  seriesUid: string;
  instances: SyntheticInstance[];
  optionalMetadata?: boolean;
  patientId?: string;
  patientIssuerOfPatientId?: string;
  patientName?: string;
}

export interface SyntheticChange {
  Seq: number;
  ChangeType: string;
  ResourceType: string;
  ID: string;
}

export interface SyntheticSource {
  databaseServerIdentifier: string;
  studies: Map<string, SyntheticStudy>;
  studyOrder: string[];
  changes: SyntheticChange[];
  requests: string[];
  activeInstanceRequests: number;
  maxActiveInstanceRequests: number;
  instancePageRequests: number;
  injectLateInstanceAfterEmptyPage: boolean;
  deleteFirstInstanceOnOffsetPage: boolean;
  injectPatientEventsDuringStudyScan: number;
  replaceStudyOnOffsetPage: SyntheticStudy | null;
}

export let directory: string;
const servers: Server[] = [];

before(() => {
  directory = mkdtempSync(join(tmpdir(), "clarity-sync-discovery-"));
});

after(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  rmSync(directory, { recursive: true, force: true });
});

function sendJson(response: import("node:http").ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

export async function createOrthancFixture(source: SyntheticSource): Promise<string> {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = decodeURIComponent(url.pathname);
    source.requests.push(`${request.method} ${path}${url.search}`);
    if (path === "/system") {
      sendJson(response, {
        DatabaseServerIdentifier: source.databaseServerIdentifier,
        DatabaseVersion: 6,
      });
      return;
    }
    if (path === "/statistics") {
      const count = [...source.studies.values()].reduce(
        (total, study) => total + study.instances.length,
        0,
      );
      sendJson(response, { CountInstances: count });
      if (source.injectLateInstanceAfterEmptyPage) {
        source.injectLateInstanceAfterEmptyPage = false;
        const study = source.studies.values().next().value as SyntheticStudy | undefined;
        study?.instances.push({ id: "orthanc-late-instance", sopUid: "2.25.300" });
        source.changes.push({
          Seq: 6,
          ChangeType: "NewInstance",
          ResourceType: "Instance",
          ID: "orthanc-late-instance",
        });
      }
      if (source.injectPatientEventsDuringStudyScan > 0) {
        const count = source.injectPatientEventsDuringStudyScan;
        source.injectPatientEventsDuringStudyScan = 0;
        for (let index = 1; index <= count; index += 1) {
          source.changes.push({
            Seq: index,
            ChangeType: "StableStudy",
            ResourceType: "Patient",
            ID: `patient-${index}`,
          });
        }
      }
      return;
    }
    if (path === "/changes") {
      const since = Number(url.searchParams.get("since") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const all = source.changes.filter((change) => change.Seq > since);
      const page = all.slice(0, limit);
      const last = page.at(-1)?.Seq ?? since;
      sendJson(response, { Last: last, Done: page.length === all.length, Changes: page });
      return;
    }
    if (path === "/studies") {
      const since = Number(url.searchParams.get("since") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 100);
      sendJson(response, source.studyOrder.slice(since, since + limit));
      return;
    }
    if (path === "/instances") {
      const since = Number(url.searchParams.get("since") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 100);
      source.instancePageRequests += 1;
      if (
        source.deleteFirstInstanceOnOffsetPage &&
        source.instancePageRequests >= 5 &&
        since > 0 &&
        limit >= 2
      ) {
        source.deleteFirstInstanceOnOffsetPage = false;
        for (const studyId of source.studyOrder) {
          const study = source.studies.get(studyId);
          const removed = study?.instances.shift();
          if (study && removed) break;
        }
      }
      if (
        source.replaceStudyOnOffsetPage &&
        source.instancePageRequests >= 5 &&
        since > 0 &&
        limit >= 2
      ) {
        const replacement = source.replaceStudyOnOffsetPage;
        source.replaceStudyOnOffsetPage = null;
        source.studies.clear();
        source.studies.set(replacement.id, replacement);
        source.studyOrder = [replacement.id];
        source.databaseServerIdentifier = "synthetic-db-restarted";
      }
      const all = source.studyOrder
        .flatMap((studyId) => source.studies.get(studyId)?.instances ?? [])
        .sort((left, right) => left.id.localeCompare(right.id));
      const page = all.slice(since, since + limit).map((instance) => instance.id);
      sendJson(response, page);
      return;
    }
    const studyList = path.match(/^\/studies\/([^/]+)$/);
    if (studyList) {
      const study = source.studies.get(studyList[1]!);
      if (!study) {
        response.writeHead(404).end();
        return;
      }
      sendJson(response, {
        MainDicomTags: {
          StudyInstanceUID: study.uid,
          ...(study.optionalMetadata ? { StudyDescription: "Synthetic study" } : {}),
        },
        ...(study.optionalMetadata
          ? {
              PatientMainDicomTags: {
                PatientID: study.patientId ?? "SYNTHETIC",
                ...(study.patientIssuerOfPatientId
                  ? { IssuerOfPatientID: study.patientIssuerOfPatientId }
                  : {}),
                ...(study.patientName ? { PatientName: study.patientName } : {}),
              },
            }
          : {}),
      });
      return;
    }
    const instance = path.match(/^\/instances\/([^/]+)$/);
    if (instance) {
      const [study, value] = findInstance(source, instance[1]!);
      if (!study || !value) {
        response.writeHead(404).end();
        return;
      }
      source.activeInstanceRequests += 1;
      source.maxActiveInstanceRequests = Math.max(
        source.maxActiveInstanceRequests,
        source.activeInstanceRequests,
      );
      await new Promise((resolve) => setTimeout(resolve, 8));
      source.activeInstanceRequests -= 1;
      sendJson(response, {
        ParentSeries: study.seriesId,
        MainDicomTags: { SOPInstanceUID: value.sopUid },
      });
      return;
    }
    const series = path.match(/^\/series\/([^/]+)$/);
    if (series) {
      const study = [...source.studies.values()].find(
        (candidate) => candidate.seriesId === series[1],
      );
      if (!study) {
        response.writeHead(404).end();
        return;
      }
      sendJson(response, {
        ParentStudy: study.id,
        MainDicomTags: { SeriesInstanceUID: study.seriesUid },
      });
      return;
    }
    response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("synthetic Orthanc fixture failed to bind");
  return `http://127.0.0.1:${address.port}/`;
}

function findInstance(
  source: SyntheticSource,
  id: string,
): [SyntheticStudy | undefined, SyntheticInstance | undefined] {
  for (const study of source.studies.values()) {
    const instance = study.instances.find((candidate) => candidate.id === id);
    if (instance) return [study, instance];
  }
  return [undefined, undefined];
}

export function sourceState(
  studies: SyntheticStudy[],
  changes: SyntheticChange[] = [],
): SyntheticSource {
  return {
    databaseServerIdentifier: "synthetic-db",
    studies: new Map(studies.map((study) => [study.id, study])),
    studyOrder: studies.map((study) => study.id),
    changes,
    requests: [],
    activeInstanceRequests: 0,
    maxActiveInstanceRequests: 0,
    instancePageRequests: 0,
    injectLateInstanceAfterEmptyPage: false,
    deleteFirstInstanceOnOffsetPage: false,
    injectPatientEventsDuringStudyScan: 0,
    replaceStudyOnOffsetPage: null,
  };
}

export function makeCoordinator(path: string, baseUrl: string, sourceKey: string, pageSize = 2) {
  const store = new CheckpointStore(path);
  const feed = new OrthancChangeFeedAdapter(store, { baseUrl, sourceKey, pageSize });
  const orthanc = new OrthancDiscoveryClient({ baseUrl, pageSize, maxConcurrency: 4 });
  return {
    store,
    feed,
    orthanc,
    coordinator: new InventoryCoordinator(store, feed, orthanc, sourceKey),
  };
}

export async function finishInventory(
  coordinator: InventoryCoordinator,
  kind: "initial" | "periodic",
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result =
      kind === "initial"
        ? await coordinator.runInitial(3)
        : await coordinator.runPeriodicReconciliation(3);
    if (result.status === "complete") return;
    assert.notEqual(result.status, "reconciliation-pending");
  }
  throw new Error("synthetic inventory did not complete within the test page bound");
}

export function syntheticStudy(
  id: string,
  uid: string,
  instanceIds: string[],
  opts: { instancePrefix?: string; sopStart?: number; optionalMetadata?: boolean } = {},
): SyntheticStudy {
  return {
    id,
    uid,
    seriesId: `series-${id}`,
    seriesUid: `2.25.${uid.split(".").at(-1)}99`,
    instances: instanceIds.map((instanceId, index) => ({
      id: instanceId,
      sopUid: `2.25.${(opts.sopStart ?? 100) + index}`,
    })),
    ...(opts.optionalMetadata === undefined ? {} : { optionalMetadata: opts.optionalMetadata }),
  };
}
