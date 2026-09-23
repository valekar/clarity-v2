import { resolve } from "node:path";
import { InventoryCoordinator } from "./discovery/inventory-coordinator.js";
import { CheckpointStore } from "./persistence/checkpoint-store.js";
import { OrthancChangeFeedAdapter } from "./orthanc/change-feed.js";
import { OrthancDiscoveryClient } from "./orthanc/discovery-client.js";

interface Options {
  baseUrl: string;
  databasePath: string;
  sourceKey: string;
  maxSteps: number;
  pageBudget: number;
}

function options(args: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--synthetic-only") continue;
    if (!flag?.startsWith("--") || !args[index + 1])
      throw new Error("invalid synthetic probe arguments");
    values.set(flag, args[++index]!);
  }
  if (!args.includes("--synthetic-only")) {
    throw new Error("synthetic service process requires --synthetic-only");
  }
  const baseUrl = values.get("--base-url");
  const databasePath = values.get("--database");
  const sourceKey = values.get("--source");
  const maxSteps = Number(values.get("--max-steps"));
  const pageBudget = Number(values.get("--page-budget"));
  if (!baseUrl || !databasePath || !sourceKey)
    throw new Error("missing required synthetic probe option");
  const url = new URL(baseUrl);
  if (!new Set(["127.0.0.1", "localhost", "[::1]"]).has(url.hostname)) {
    throw new Error("synthetic probe accepts loopback Orthanc URLs only");
  }
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 1000) {
    throw new Error("max steps must be between 1 and 1000");
  }
  if (!Number.isInteger(pageBudget) || pageBudget < 1 || pageBudget > 500) {
    throw new Error("page budget must be between 1 and 500");
  }
  return {
    baseUrl: url.href,
    databasePath: resolve(databasePath),
    sourceKey,
    maxSteps,
    pageBudget,
  };
}

async function main(): Promise<void> {
  const config = options(process.argv.slice(2));
  const store = new CheckpointStore(config.databasePath);
  try {
    const feed = new OrthancChangeFeedAdapter(store, {
      baseUrl: config.baseUrl,
      sourceKey: config.sourceKey,
      pageSize: 100,
    });
    const orthanc = new OrthancDiscoveryClient({ baseUrl: config.baseUrl, pageSize: 100 });
    const coordinator = new InventoryCoordinator(store, feed, orthanc, config.sourceKey);
    let result = await coordinator.runInitial(config.pageBudget);
    let steps = 1;
    while (result.status !== "complete" && result.status !== "reconciliation-pending") {
      if (steps >= config.maxSteps)
        throw new Error("synthetic inventory exceeded its finite step budget");
      result = await coordinator.runInitial(config.pageBudget);
      steps += 1;
    }
    if (result.status !== "complete") {
      throw new Error("synthetic inventory reached its finite step budget with feed work pending");
    }
    process.stdout.write(
      `${JSON.stringify({
        status: result.status,
        steps,
        runId: result.run?.id ?? null,
        generation: result.run?.generation ?? null,
        checkpointCursor: store.getCheckpoint(config.sourceKey)?.cursor ?? null,
        reports: store.discovery.listReports(config.sourceKey).length,
        instances: store.discovery
          .listReports(config.sourceKey)
          .reduce(
            (count, report) =>
              count +
              store.discovery.listInstances(config.sourceKey, report.studyInstanceUid).length,
            0,
          ),
      })}\n`,
    );
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `synthetic sync probe failed: ${error instanceof Error ? error.message : "unknown failure"}\n`,
  );
  process.exitCode = 1;
});
