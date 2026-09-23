import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CheckpointStore } from "../src/persistence/checkpoint-store.js";
import {
  createOrthancFixture,
  directory,
  sourceState,
  syntheticStudy,
} from "./discovery-fixtures.js";

test("compiled synthetic sync process completes bounded discovery in its own process", async () => {
  const source = sourceState([
    syntheticStudy("study-process", "2.25.82", ["instance-process-a", "instance-process-b"], {
      sopStart: 820,
    }),
  ]);
  const baseUrl = await createOrthancFixture(source);
  const databasePath = join(directory, "synthetic-process.sqlite");
  const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const entry = join(appDirectory, "dist", "synthetic-main.js");
  const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolvePromise, reject) => {
      const child = spawn(
        process.execPath,
        [
          entry,
          "--synthetic-only",
          "--base-url",
          baseUrl,
          "--database",
          databasePath,
          "--source",
          "synthetic-process-source",
          "--max-steps",
          "100",
          "--page-budget",
          "1",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.once("error", reject);
      child.once("exit", (code) => resolvePromise({ code, stdout, stderr }));
    },
  );
  assert.equal(output.code, 0, output.stderr);
  const result = JSON.parse(output.stdout) as Record<string, unknown>;
  assert.equal(result.status, "complete");
  assert.equal(result.reports, 1);
  assert.equal(result.instances, 2);
  assert.ok(Number(result.steps) > 1);
  const store = new CheckpointStore(databasePath);
  assert.equal(
    store.discovery.findInventoryRun("synthetic-process-source", "initial", true)?.status,
    "complete",
  );
  store.close();
  assert.ok(source.requests.some((request) => request.startsWith("GET /instances?")));
});
