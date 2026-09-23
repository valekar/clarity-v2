import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireServiceLock, DuplicateServiceInstanceError } from "../src/runtime/service-lock.js";

test("concurrent process starts have one exclusive owner and shutdown releases it", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarity-sync-lock-"));
  const databasePath = join(root, "state.sqlite");
  let releaseFirst: (() => Promise<void>) | null = null;
  let releaseWinner: (() => Promise<void>) | null = null;
  try {
    const outcomes = await Promise.allSettled([
      acquireServiceLock(databasePath),
      acquireServiceLock(databasePath),
    ]);
    const winners = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const blocked = outcomes.filter((outcome) => outcome.status === "rejected");
    assert.equal(winners.length, 1);
    assert.equal(blocked.length, 1);
    assert.ok(
      blocked[0]?.status === "rejected" &&
        blocked[0].reason instanceof DuplicateServiceInstanceError,
    );
    if (winners[0]?.status === "fulfilled") releaseFirst = winners[0].value;
    await releaseFirst?.();

    releaseWinner = await acquireServiceLock(databasePath);
    await assert.rejects(acquireServiceLock(databasePath), DuplicateServiceInstanceError);
    await releaseWinner();
    releaseWinner = null;
    const afterShutdown = await acquireServiceLock(databasePath);
    await afterShutdown();
  } finally {
    await releaseWinner?.();
    await releaseFirst?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("a killed owner releases SQLite locking and simultaneous crash recovery remains exclusive", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarity-sync-lock-crash-"));
  const databasePath = join(root, "state.sqlite");
  const moduleUrl = new URL("../src/runtime/service-lock.js", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { acquireServiceLock } from ${JSON.stringify(moduleUrl)}; await acquireServiceLock(${JSON.stringify(databasePath)}); console.log("locked"); setInterval(() => {}, 1000);`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  try {
    const deadline = Date.now() + 3_000;
    while (!output.includes("locked") && Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error("lock holder exited before acquiring lock");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    assert.match(output, /locked/);
    child.kill("SIGKILL");
    await once(child, "exit");

    const outcomes = await Promise.allSettled([
      acquireServiceLock(databasePath),
      acquireServiceLock(databasePath),
    ]);
    const winners = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const blocked = outcomes.filter((outcome) => outcome.status === "rejected");
    assert.equal(winners.length, 1);
    assert.equal(blocked.length, 1);
    assert.ok(
      blocked[0]?.status === "rejected" &&
        blocked[0].reason instanceof DuplicateServiceInstanceError,
    );
    if (winners[0]?.status === "fulfilled") await winners[0].value();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    await rm(root, { recursive: true, force: true });
  }
});
