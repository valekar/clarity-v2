import { chmod, lstat, mkdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { InventoryCoordinator } from "./discovery/inventory-coordinator.js";
import { CheckpointStore } from "./persistence/checkpoint-store.js";
import { OrthancChangeFeedAdapter } from "./orthanc/change-feed.js";
import { OrthancDiscoveryClient } from "./orthanc/discovery-client.js";
import { SyncLoop } from "./runtime/sync-loop.js";
import { acquireServiceLock } from "./runtime/service-lock.js";
import {
  loadRuntimeEnvironment,
  readPrivateConfigUpdate,
  writePrivateRuntimeConfig,
} from "./runtime/config-file.js";
import { pollIntervalMs } from "./runtime/poll-interval.js";
import { IngestionClient } from "./transfers/ingestion-client.js";

interface RuntimeConfig {
  sourceKey: string;
  databasePath: string;
  spoolDirectory: string;
  orthancUrl: string;
  orthancAuthorization: string;
  apiUrl: string;
  deviceAuthorization: string;
  insecureLoopback: boolean;
  pollIntervalMs: number;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value || value.length > 4096) throw new Error("required setting missing or too long");
  return value;
}

function privateEndpoint(value: string, allowHttpLoopback: boolean, label: string): string {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    (url.protocol === "http:" && !(allowHttpLoopback && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${label} must use HTTPS, or explicit loopback HTTP`);
  }
  return url.href;
}

function config(environment: NodeJS.ProcessEnv): RuntimeConfig {
  const insecureLoopback = environment.CLARITY_SYNC_ALLOW_INSECURE_LOCALHOST === "1";
  const sourceKey = required(environment, "CLARITY_SYNC_SOURCE_KEY");
  if (sourceKey.length > 200 || /[\u0000-\u001f\u007f]/u.test(sourceKey)) {
    throw new Error("source identity is invalid");
  }
  const orthancAuthorization = required(environment, "CLARITY_ORTHANC_AUTHORIZATION");
  if (!/^Basic [A-Za-z0-9+/=]{1,2048}$/.test(orthancAuthorization)) {
    throw new Error("Orthanc authorization must be a Basic credential");
  }
  const deviceAuthorization = required(environment, "CLARITY_DEVICE_AUTHORIZATION");
  if (
    deviceAuthorization.length > 256 ||
    !/^ClarityDevice [0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/i.test(
      deviceAuthorization,
    )
  ) {
    throw new Error("issued device authorization is invalid");
  }
  const orthancUrl = privateEndpoint(
    required(environment, "CLARITY_ORTHANC_URL"),
    insecureLoopback,
    "Orthanc URL",
  );
  const apiUrl = privateEndpoint(
    required(environment, "CLARITY_INGESTION_API_URL"),
    insecureLoopback,
    "ingestion API URL",
  );
  return {
    sourceKey,
    databasePath: resolve(required(environment, "CLARITY_SYNC_STATE_DB")),
    spoolDirectory: resolve(required(environment, "CLARITY_SYNC_SPOOL_DIR")),
    orthancUrl,
    orthancAuthorization,
    apiUrl,
    deviceAuthorization,
    insecureLoopback,
    pollIntervalMs: pollIntervalMs(environment),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--write-config") {
    if (args.length !== 2 || !isAbsolute(args[1]!)) {
      process.stderr.write("configuration writer requires one absolute path\n");
      process.exitCode = 64;
      return;
    }
    try {
      const updates = await readPrivateConfigUpdate(process.stdin);
      await writePrivateRuntimeConfig(args[1]!, updates);
      process.stdout.write("private source settings saved\n");
    } catch {
      process.stderr.write("private source settings could not be saved\n");
      process.exitCode = 78;
    }
    return;
  }

  let runtime: RuntimeConfig;
  try {
    runtime = config(await loadRuntimeEnvironment(args));
  } catch {
    process.stderr.write(
      "sync service configuration is missing or invalid; service remains inactive\n",
    );
    process.exitCode = 78;
    return;
  }

  process.umask(0o077);
  await mkdir(dirname(runtime.databasePath), { recursive: true, mode: 0o700 });
  await mkdir(runtime.spoolDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    const stateDirectory = await stat(dirname(runtime.databasePath));
    if ((stateDirectory.mode & 0o077) !== 0) {
      throw new Error("sync state directory must be private to its service account");
    }
  }
  const spoolStat = await lstat(runtime.spoolDirectory);
  if (!spoolStat.isDirectory() || spoolStat.isSymbolicLink()) {
    throw new Error("spool path must be a private directory, not a link");
  }
  await chmod(runtime.spoolDirectory, 0o700);
  const cloud = new IngestionClient({
    apiBaseUrl: runtime.apiUrl,
    deviceAuthorization: runtime.deviceAuthorization,
    allowInsecureLocalhost: runtime.insecureLoopback,
  });
  const releaseLock = await acquireServiceLock(runtime.databasePath);
  let store: CheckpointStore | null = null;
  try {
    const databaseEntry = await lstat(runtime.databasePath).catch(() => null);
    if (databaseEntry?.isSymbolicLink())
      throw new Error("state database cannot be a symbolic link");
    store = new CheckpointStore(runtime.databasePath);
    store.clearQueueLeaseAfterExclusiveServiceLock(runtime.sourceKey);
    await chmod(runtime.databasePath, 0o600);
    const feed = new OrthancChangeFeedAdapter(store, {
      baseUrl: runtime.orthancUrl,
      sourceKey: runtime.sourceKey,
      authorization: runtime.orthancAuthorization,
      pageSize: 100,
    });
    const orthanc = new OrthancDiscoveryClient({
      baseUrl: runtime.orthancUrl,
      authorization: runtime.orthancAuthorization,
      pageSize: 100,
      maxConcurrency: 4,
    });
    const coordinator = new InventoryCoordinator(store, feed, orthanc, runtime.sourceKey);
    const loop = new SyncLoop(store, feed, coordinator, orthanc, cloud, {
      sourceKey: runtime.sourceKey,
      spoolDirectory: runtime.spoolDirectory,
      maximumObjectBytes: 2 * 1024 * 1024 * 1024,
      reserveFreeBytes: 1024 * 1024 * 1024,
      pageBudget: 10,
      uploadBatchSize: 10,
      pollIntervalMs: runtime.pollIntervalMs,
      reconciliationIntervalMs: 60 * 60 * 1000,
      onDiagnostic: (message) => process.stderr.write(`sync: ${message.slice(0, 300)}\n`),
    });
    const shutdown = new AbortController();
    const stop = (): void => shutdown.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.stdout.write(
      "sync service started with private Orthanc and cloud ingestion adapters\n",
    );
    await loop.run(shutdown.signal);
  } finally {
    store?.close();
    await releaseLock();
  }
}

main().catch(() => {
  process.stderr.write("sync service stopped after an internal startup failure\n");
  process.exitCode = 1;
});
