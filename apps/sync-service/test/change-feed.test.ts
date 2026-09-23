import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { CheckpointStore } from "../src/persistence/checkpoint-store.js";
import { OrthancChangeFeedAdapter } from "../src/orthanc/change-feed.js";

let directory: string;
const servers: Server[] = [];

before(() => {
  directory = mkdtempSync(join(tmpdir(), "clarity-sync-feed-"));
});

after(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  rmSync(directory, { recursive: true, force: true });
});

async function fixture(
  handler: (path: string, query: URLSearchParams) => unknown,
): Promise<string> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    try {
      const value = handler(url.pathname, url.searchParams);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server failed to bind");
  return `http://127.0.0.1:${address.port}/`;
}

test("uses bounded Orthanc change pages and persists the next cursor", async () => {
  const requests: Array<{ since: string; limit: string }> = [];
  const baseUrl = await fixture((path, query) => {
    if (path === "/system") return { DatabaseServerIdentifier: "synthetic-A", DatabaseVersion: 6 };
    if (path !== "/changes") throw new Error(`unexpected path ${path}`);
    const since = query.get("since") ?? "";
    const limit = query.get("limit") ?? "";
    requests.push({ since, limit });
    if (since === "0") {
      return {
        Last: 2,
        Done: false,
        Changes: [
          { Seq: 1, ChangeType: "NewInstance", ResourceType: "Instance", ID: "instance-1" },
          { Seq: 2, ChangeType: "StableStudy", ResourceType: "Study", ID: "study-1" },
        ],
      };
    }
    return {
      Last: 3,
      Done: true,
      Changes: [{ Seq: 3, ChangeType: "NewInstance", ResourceType: "Instance", ID: "instance-2" }],
    };
  });
  const store = new CheckpointStore(join(directory, "bounded.sqlite"));
  const adapter = new OrthancChangeFeedAdapter(store, {
    baseUrl,
    sourceKey: "site-1",
    pageSize: 2,
  });
  const first = await adapter.pollOnce();
  const second = await adapter.pollOnce();
  assert.deepEqual(requests, [
    { since: "0", limit: "2" },
    { since: "2", limit: "2" },
  ]);
  assert.equal(first.done, false);
  assert.equal(second.checkpoint.cursor, 3);
  assert.deepEqual(
    store.listPending("site-1").map((job) => job.changeType),
    ["reconcile-source", "NewInstance", "StableStudy", "NewInstance"],
  );
  store.close();
});

test("source identity change starts a new generation from sequence zero", async () => {
  let identity = "synthetic-A";
  let latestSequence = 5;
  const requests: string[] = [];
  const baseUrl = await fixture((path, query) => {
    if (path === "/system") return { DatabaseServerIdentifier: identity, DatabaseVersion: 6 };
    if (path !== "/changes") throw new Error(`unexpected path ${path}`);
    const since = Number(query.get("since"));
    requests.push(String(since));
    const changes = Array.from({ length: Math.max(0, latestSequence - since) }, (_, index) => {
      const sequence = since + index + 1;
      return {
        Seq: sequence,
        ChangeType: "NewInstance",
        ResourceType: "Instance",
        ID: `instance-${sequence}`,
      };
    }).slice(0, Number(query.get("limit")));
    const last = changes.at(-1)?.Seq ?? since;
    return { Last: last, Done: last >= latestSequence, Changes: changes };
  });
  const store = new CheckpointStore(join(directory, "identity.sqlite"));
  const adapter = new OrthancChangeFeedAdapter(store, {
    baseUrl,
    sourceKey: "site-2",
    pageSize: 10,
  });
  await adapter.pollOnce();
  identity = "synthetic-B";
  latestSequence = 2;
  const reset = await adapter.pollOnce();
  assert.deepEqual(requests, ["0", "0"]);
  assert.equal(reset.resetDetected, true);
  assert.equal(reset.checkpoint.generation, 1);
  assert.equal(reset.checkpoint.cursor, 2);
  assert.equal(store.listPending("site-2").filter((job) => job.generation === 1).length, 3);
  store.close();
});

test("cursor regression discards the stale page, bumps generation, then replays from zero", async () => {
  const requests: string[] = [];
  let changed = false;
  const baseUrl = await fixture((path, query) => {
    if (path === "/system") return { DatabaseServerIdentifier: "stable-id", DatabaseVersion: 6 };
    if (path !== "/changes") throw new Error(`unexpected path ${path}`);
    const since = Number(query.get("since"));
    requests.push(String(since));
    if (!changed) {
      return {
        Last: 5,
        Done: true,
        Changes: Array.from({ length: 5 }, (_, index) => ({
          Seq: index + 1,
          ChangeType: "NewInstance",
          ResourceType: "Instance",
          ID: `old-${index + 1}`,
        })),
      };
    }
    if (since === 5) return { Last: 0, Done: false, Changes: [] };
    return {
      Last: 5,
      Done: true,
      Changes: Array.from({ length: 5 }, (_, index) => ({
        Seq: index + 1,
        ChangeType: "NewInstance",
        ResourceType: "Instance",
        ID: `new-${index + 1}`,
      })),
    };
  });
  const store = new CheckpointStore(join(directory, "regression.sqlite"));
  const adapter = new OrthancChangeFeedAdapter(store, {
    baseUrl,
    sourceKey: "site-3",
    pageSize: 10,
  });
  await adapter.pollOnce();
  changed = true;
  const reset = await adapter.pollOnce();
  assert.deepEqual(requests, ["0", "5", "0"]);
  assert.equal(reset.fetchedFrom, 0);
  assert.equal(reset.resetDetected, true);
  assert.equal(reset.checkpoint.generation, 1);
  assert.equal(reset.checkpoint.cursor, 5);
  const jobs = store.listPending("site-3");
  assert.equal(
    jobs.filter((job) => job.generation === 1 && job.changeType === "reconcile-source").length,
    1,
  );
  assert.equal(
    jobs.filter((job) => job.generation === 1 && job.orthancId?.startsWith("new-")).length,
    5,
  );
  assert.equal(
    jobs.some((job) => job.orthancId === null && job.sequence === 0),
    false,
  );
  store.close();
});
