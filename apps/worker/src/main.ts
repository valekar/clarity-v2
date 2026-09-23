import { Pool } from "pg";
import { S3IntakeObjects } from "@clarity/storage/intake-objects";
import type { IntakeObjects, ReceivedUpload, WorkerDependencies } from "./contracts.js";
import { OrthancClient } from "./orthanc-client.js";
import { PostgresWorkerRepository } from "./postgres-repository.js";
import { cleanupCompletedUpload, processReceivedUpload } from "./import-instance.js";
import { mkdir } from "node:fs/promises";
import { pruneAbandonedStages } from "./staging.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required worker setting: ${name}`);
  return value;
}

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} is outside its supported range.`);
  }
  return parsed;
}

async function run(): Promise<void> {
  const stagingDirectory = required("WORKER_STAGING_DIR");
  await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
  await pruneAbandonedStages(stagingDirectory);
  const pool = new Pool({
    connectionString: required("DATABASE_URL"),
    application_name: "clarity-v2-worker",
    max: 4,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    query_timeout: 30_000,
    statement_timeout: 30_000,
  });
  // Do not start a container that only appears healthy while its durable queue
  // is unreachable. Pool and server-side query timeouts keep this check bounded.
  try {
    await pool.query("SELECT 1");
  } catch (error) {
    await pool.end();
    throw error;
  }
  const shutdown = new AbortController();
  const objects = new S3IntakeObjects(
    {
      endpoint: new URL(required("INTAKE_S3_ENDPOINT")),
      bucket: required("INTAKE_S3_BUCKET"),
      region: process.env.INTAKE_S3_REGION ?? "us-east-1",
      accessKey: required("INTAKE_S3_ACCESS_KEY"),
      secretKey: required("INTAKE_S3_SECRET_KEY"),
    },
    fetch,
    shutdown.signal,
  );
  const intake: IntakeObjects = {
    open: (upload: ReceivedUpload) => objects.open(upload.objectKey),
    remove: (upload: ReceivedUpload) => objects.remove(upload.objectKey),
  };
  const index = new OrthancClient(
    new URL(required("CLOUD_ORTHANC_URL")),
    required("CLOUD_ORTHANC_USERNAME"),
    required("CLOUD_ORTHANC_PASSWORD"),
    fetch,
    30_000,
    shutdown.signal,
  );
  const dependencies: WorkerDependencies = {
    repository: new PostgresWorkerRepository(pool),
    intake,
    index,
    maxObjectBytes: boundedInteger(
      "WORKER_MAX_OBJECT_BYTES",
      2_000_000_000,
      1_048_576,
      5_000_000_000,
    ),
    stagingDirectory,
    ...(process.env.WORKER_TRACE === "1"
      ? {
          onProgress: (event: Parameters<NonNullable<WorkerDependencies["onProgress"]>>[0]) => {
            process.stderr.write(`worker proof event: ${event}\n`);
          },
        }
      : {}),
  };
  const limit = boundedInteger("WORKER_BATCH_SIZE", 4, 1, 8);
  let stopping = false;
  process.once("SIGTERM", () => {
    stopping = true;
    shutdown.abort();
  });
  process.once("SIGINT", () => {
    stopping = true;
    shutdown.abort();
  });
  try {
    while (!stopping) {
      try {
        const cleanupPending = await dependencies.repository.listCleanupPending(limit);
        for (const upload of cleanupPending) {
          if (stopping) break;
          try {
            await cleanupCompletedUpload(upload, dependencies);
          } catch {
            /* retry from durable cleanup state */
          }
        }
        const uploads = await dependencies.repository.listReceived(limit);
        for (const upload of uploads) {
          if (stopping) break;
          try {
            await processReceivedUpload(upload, dependencies);
          } catch {
            // Status is durable in PostgreSQL; retry after the bounded poll delay.
            dependencies.onProgress?.("attempt-retry");
          }
        }
      } catch {
        // Keep service logs free of URLs, object keys, credentials and DICOM identifiers.
      }
      if (!stopping)
        await new Promise((resolve) =>
          setTimeout(resolve, boundedInteger("WORKER_POLL_MS", 2000, 250, 60_000)),
        );
    }
  } finally {
    await pool.end();
  }
}

run().catch(() => {
  process.stderr.write(
    "Clarity cloud worker could not start. Check its secret configuration and database reachability.\n",
  );
  process.exitCode = 78;
});
