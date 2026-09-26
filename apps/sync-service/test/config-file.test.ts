import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { pollIntervalMs } from "../src/runtime/poll-interval.js";
import {
  configPathFromArgs,
  loadRuntimeEnvironment,
  MAX_CONFIG_BYTES,
  readPrivateConfigUpdate,
  writePrivateRuntimeConfig,
} from "../src/runtime/config-file.js";

const config = {
  CLARITY_SYNC_SOURCE_KEY: "synthetic-source",
  CLARITY_SYNC_STATE_DB: "/private/state/sync.sqlite",
  CLARITY_SYNC_SPOOL_DIR: "/private/state/spool",
  CLARITY_ORTHANC_URL: "https://orthanc.example.invalid/",
  CLARITY_ORTHANC_AUTHORIZATION: "Basic dGVzdDp0ZXN0",
  CLARITY_INGESTION_API_URL: "https://cloud.example.invalid/",
  CLARITY_DEVICE_AUTHORIZATION: `ClarityDevice 123e4567-e89b-42d3-a456-426614174000.${"A".repeat(43)}`,
  CLARITY_SYNC_POLL_INTERVAL_MINUTES: "5",
};

test("config CLI accepts only one absolute --config path and preserves env-only launch", async () => {
  assert.equal(configPathFromArgs([]), null);
  assert.equal(configPathFromArgs(["--config", "/private/config.json"]), "/private/config.json");
  assert.throws(() => configPathFromArgs(["--config", "relative.json"]));
  assert.throws(() => configPathFromArgs(["--unknown", "x"]));
  const environment = { CLARITY_SYNC_SOURCE_KEY: "environment-source" };
  assert.deepEqual(await loadRuntimeEnvironment([], environment, "darwin"), environment);
});

test("private config file overrides environment using only known bounded string settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clarity-sync-config-"));
  const path = join(directory, "config.json");
  try {
    await writeFile(path, JSON.stringify(config), { mode: 0o600 });
    await chmod(path, 0o600);
    const environment = await loadRuntimeEnvironment(
      ["--config", path],
      { CLARITY_SYNC_SOURCE_KEY: "old-environment-source" },
      "darwin",
    );
    assert.equal(environment.CLARITY_SYNC_SOURCE_KEY, "synthetic-source");
    assert.equal(environment.CLARITY_SYNC_STATE_DB, config.CLARITY_SYNC_STATE_DB);
    assert.equal(environment.CLARITY_DEVICE_AUTHORIZATION, config.CLARITY_DEVICE_AUTHORIZATION);
    assert.equal(environment.UNRELATED, undefined);

    await writeFile(path, JSON.stringify({ ...config, UNRECOGNIZED_SECRET: "private-value" }));
    await chmod(path, 0o600);
    await assert.rejects(
      loadRuntimeEnvironment(["--config", path], {}, "darwin"),
      (error: Error) => !error.message.includes("private-value"),
    );

    await writeFile(path, JSON.stringify(config));
    await chmod(path, 0o640);
    await assert.rejects(
      loadRuntimeEnvironment(["--config", path], {}, "darwin"),
      /permissions are too broad/,
    );

    await chmod(path, 0o600);
    await writeFile(path, JSON.stringify({ ...config, CLARITY_SYNC_STATE_DB: "relative.sqlite" }));
    await assert.rejects(
      loadRuntimeEnvironment(["--config", path], {}, "darwin"),
      /relative private-data path/,
    );
    await writeFile(
      path,
      JSON.stringify({ ...config, CLARITY_SYNC_ALLOW_INSECURE_LOCALHOST: "true" }),
    );
    await assert.rejects(
      loadRuntimeEnvironment(["--config", path], {}, "darwin"),
      /invalid loopback setting/,
    );
    await writeFile(path, JSON.stringify({ ...config, CLARITY_SYNC_POLL_INTERVAL_MINUTES: "4" }));
    await assert.rejects(
      loadRuntimeEnvironment(["--config", path], {}, "darwin"),
      /invalid poll interval/,
    );
    await chmod(path, 0o000);
    await assert.rejects(
      loadRuntimeEnvironment(["--config", path], {}, "darwin"),
      /permissions are too broad/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("poll interval defaults to five minutes and accepts bounded whole-minute settings", () => {
  assert.equal(pollIntervalMs({}), 5 * 60_000);
  assert.equal(pollIntervalMs({ CLARITY_SYNC_POLL_INTERVAL_MINUTES: "10" }), 10 * 60_000);
  assert.equal(pollIntervalMs({ CLARITY_SYNC_POLL_INTERVAL_MINUTES: "60" }), 60 * 60_000);
  for (const value of ["0", "4", "5.5", "61", " 10", "10x"]) {
    assert.throws(
      () => pollIntervalMs({ CLARITY_SYNC_POLL_INTERVAL_MINUTES: value }),
      /whole number of minutes from 5 to 60/,
    );
  }
});

test("five-second polling is reserved for explicitly opted-in loopback synthetic proofs", () => {
  assert.equal(
    pollIntervalMs({
      CLARITY_SYNC_SYNTHETIC_POLL_INTERVAL_SECONDS: "5",
      CLARITY_SYNC_ALLOW_INSECURE_LOCALHOST: "1",
      CLARITY_ORTHANC_URL: "http://127.0.0.1:8042/",
      CLARITY_INGESTION_API_URL: "http://localhost:3000/",
    }),
    5_000,
  );
  assert.throws(
    () =>
      pollIntervalMs({
        CLARITY_SYNC_SYNTHETIC_POLL_INTERVAL_SECONDS: "5",
        CLARITY_SYNC_ALLOW_INSECURE_LOCALHOST: "1",
        CLARITY_ORTHANC_URL: "https://orthanc.example/",
        CLARITY_INGESTION_API_URL: "http://localhost:3000/",
      }),
    /loopback-only proof settings/,
  );
  assert.throws(
    () =>
      pollIntervalMs({
        CLARITY_SYNC_SYNTHETIC_POLL_INTERVAL_SECONDS: "5",
        CLARITY_ORTHANC_URL: "http://127.0.0.1:8042/",
        CLARITY_INGESTION_API_URL: "http://localhost:3000/",
      }),
    /loopback-only proof settings/,
  );
});

test("private config writer merges validated settings atomically with restrictive permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clarity-sync-config-write-"));
  const path = join(directory, "config.json");
  try {
    const original = {
      CLARITY_SYNC_SOURCE_KEY: "synthetic-source",
      CLARITY_ORTHANC_URL: "http://127.0.0.1:8042/",
      CLARITY_ORTHANC_AUTHORIZATION: "Basic dGVzdDp0ZXN0",
      CLARITY_SYNC_POLL_INTERVAL_MINUTES: "5",
    };
    await writeFile(path, `${JSON.stringify(original)}\n`, { mode: 0o600 });
    await chmod(path, 0o600);

    await writePrivateRuntimeConfig(path, { CLARITY_SYNC_POLL_INTERVAL_MINUTES: "10" }, "darwin");

    const saved = JSON.parse(await readFile(path, "utf8")) as Record<string, string>;
    assert.equal(saved.CLARITY_ORTHANC_AUTHORIZATION, original.CLARITY_ORTHANC_AUTHORIZATION);
    assert.equal(saved.CLARITY_ORTHANC_URL, original.CLARITY_ORTHANC_URL);
    assert.equal(saved.CLARITY_SYNC_POLL_INTERVAL_MINUTES, "10");
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(directory)).sort(), ["config.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("private config writer preserves the previous file after invalid updates and rejects symlinks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clarity-sync-config-write-unsafe-"));
  const path = join(directory, "config.json");
  const target = join(directory, "target.json");
  const link = join(directory, "link.json");
  try {
    const original = { CLARITY_SYNC_POLL_INTERVAL_MINUTES: "5" };
    const originalBytes = `${JSON.stringify(original, null, 2)}\n`;
    await writeFile(path, originalBytes, { mode: 0o600 });
    await chmod(path, 0o600);
    await assert.rejects(
      writePrivateRuntimeConfig(path, { CLARITY_SYNC_POLL_INTERVAL_MINUTES: "4" }, "darwin"),
      /invalid poll interval/,
    );
    assert.equal(await readFile(path, "utf8"), originalBytes);

    await writeFile(target, originalBytes, { mode: 0o600 });
    await symlink(target, link);
    await assert.rejects(writePrivateRuntimeConfig(link, original, "darwin"), /unsafe/);
    assert.equal(await readFile(target, "utf8"), originalBytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("saving a regular poll interval removes any synthetic fast-poll override", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clarity-sync-poll-config-"));
  const path = join(directory, "config.json");
  try {
    await writeFile(
      path,
      JSON.stringify({
        CLARITY_SYNC_POLL_INTERVAL_MINUTES: "5",
        CLARITY_SYNC_SYNTHETIC_POLL_INTERVAL_SECONDS: "5",
      }),
      { mode: 0o600 },
    );
    await chmod(path, 0o600);

    await writePrivateRuntimeConfig(path, { CLARITY_SYNC_POLL_INTERVAL_MINUTES: "10" });

    const saved = JSON.parse(await readFile(path, "utf8")) as Record<string, string>;
    assert.equal(saved.CLARITY_SYNC_POLL_INTERVAL_MINUTES, "10");
    assert.equal(saved.CLARITY_SYNC_SYNTHETIC_POLL_INTERVAL_SECONDS, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("private config writer accepts only bounded source settings updates", async () => {
  async function* stream(value: string): AsyncGenerator<Uint8Array> {
    yield Buffer.from(value.slice(0, 12));
    yield Buffer.from(value.slice(12));
  }

  assert.deepEqual(
    await readPrivateConfigUpdate(
      stream(
        JSON.stringify({
          CLARITY_ORTHANC_URL: "https://orthanc.example.invalid/",
          CLARITY_ORTHANC_AUTHORIZATION: "Basic dGVzdDp0ZXN0",
          CLARITY_SYNC_POLL_INTERVAL_MINUTES: "10",
        }),
      ),
    ),
    {
      CLARITY_ORTHANC_URL: "https://orthanc.example.invalid/",
      CLARITY_ORTHANC_AUTHORIZATION: "Basic dGVzdDp0ZXN0",
      CLARITY_SYNC_POLL_INTERVAL_MINUTES: "10",
    },
  );
  await assert.rejects(
    readPrivateConfigUpdate(stream(JSON.stringify({ CLARITY_DEVICE_AUTHORIZATION: "secret" }))),
    /non-editable setting/,
  );
  await assert.rejects(
    readPrivateConfigUpdate(stream(JSON.stringify({ CLARITY_SYNC_POLL_INTERVAL_MINUTES: "4" }))),
    /invalid poll interval/,
  );
});

test("compiled config writer CLI accepts the bounded stdin patch contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clarity-sync-config-cli-"));
  const path = join(directory, "config.json");
  try {
    const cli = fileURLToPath(new URL("../../dist/main.js", import.meta.url));
    const child = spawn(process.execPath, [cli, "--write-config", path], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (value: string) => (stdout += value));
    child.stderr.setEncoding("utf8").on("data", (value: string) => (stderr += value));
    const exitCode = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    child.stdin.end(
      JSON.stringify({
        CLARITY_ORTHANC_URL: "http://127.0.0.1:8042/",
        CLARITY_ORTHANC_AUTHORIZATION: "Basic dGVzdDp0ZXN0",
        CLARITY_SYNC_POLL_INTERVAL_MINUTES: "10",
      }),
    );
    assert.equal(await exitCode, 0, stderr);
    assert.match(stdout, /private source settings saved/);
    assert.equal(
      (JSON.parse(await readFile(path, "utf8")) as Record<string, string>)
        .CLARITY_SYNC_POLL_INTERVAL_MINUTES,
      "10",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("config loader rejects symlinks and over-limit files before JSON parsing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clarity-sync-config-unsafe-"));
  const target = join(directory, "target.json");
  const link = join(directory, "config.json");
  const oversized = join(directory, "oversized.json");
  try {
    await writeFile(target, JSON.stringify(config), { mode: 0o600 });
    await symlink(target, link);
    await assert.rejects(loadRuntimeEnvironment(["--config", link], {}, "darwin"));
    await writeFile(oversized, `{"padding":"${"x".repeat(MAX_CONFIG_BYTES)}"}`);
    await chmod(oversized, 0o600);
    await assert.rejects(
      loadRuntimeEnvironment(["--config", oversized], {}, "darwin"),
      /too large/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
