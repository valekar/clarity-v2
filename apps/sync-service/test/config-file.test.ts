import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  configPathFromArgs,
  loadRuntimeEnvironment,
  MAX_CONFIG_BYTES,
} from "../src/runtime/config-file.js";

const config = {
  CLARITY_SYNC_SOURCE_KEY: "synthetic-source",
  CLARITY_SYNC_STATE_DB: "/private/state/sync.sqlite",
  CLARITY_SYNC_SPOOL_DIR: "/private/state/spool",
  CLARITY_ORTHANC_URL: "https://orthanc.example.invalid/",
  CLARITY_ORTHANC_AUTHORIZATION: "Basic dGVzdDp0ZXN0",
  CLARITY_INGESTION_API_URL: "https://cloud.example.invalid/",
  CLARITY_DEVICE_AUTHORIZATION: `ClarityDevice 123e4567-e89b-42d3-a456-426614174000.${"A".repeat(43)}`,
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
    await chmod(path, 0o000);
    await assert.rejects(
      loadRuntimeEnvironment(["--config", path], {}, "darwin"),
      /permissions are too broad/,
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
