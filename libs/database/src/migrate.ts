import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const migrationDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const databaseName = process.env.PGDATABASE;

function assertV2Database(): void {
  if (!databaseName?.startsWith("clarity_v2_")) {
    throw new Error("Set PGDATABASE to an isolated clarity_v2_* database before migrating.");
  }
}

function runPsql(input: string, quiet: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.PSQL_BIN ?? "psql",
      [
        "-X",
        "--tuples-only",
        "--no-align",
        "--set",
        "ON_ERROR_STOP=1",
        ...(quiet ? ["--quiet"] : []),
      ],
      {
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`psql exited ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.end(input);
  });
}

function quoteSql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function loadAppliedMigrations(): Promise<Map<string, string>> {
  await runPsql(
    "CREATE TABLE IF NOT EXISTS public.schema_migrations (name text PRIMARY KEY, checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'), applied_at timestamptz NOT NULL DEFAULT clock_timestamp());",
    true,
  );
  const result = await runPsql(
    "SELECT name || '|' || checksum FROM public.schema_migrations ORDER BY name;",
    true,
  );
  const applied = new Map<string, string>();
  for (const row of result.split(/\r?\n/).filter(Boolean)) {
    const separator = row.indexOf("|");
    if (separator < 1) throw new Error("Invalid row in schema_migrations.");
    applied.set(row.slice(0, separator), row.slice(separator + 1));
  }
  return applied;
}

async function main(): Promise<void> {
  assertV2Database();
  const names = (await readdir(migrationDirectory))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  if (names.length === 0) throw new Error("No valid SQL migrations found.");
  const applied = await loadAppliedMigrations();
  for (const name of applied.keys()) {
    if (!names.includes(name))
      throw new Error(`Applied migration is missing from this package: ${name}`);
  }
  let newlyApplied = 0;
  for (const name of names) {
    const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
    const checksum = createHash("sha256").update(sql, "utf8").digest("hex");
    const priorChecksum = applied.get(name);
    if (priorChecksum !== undefined) {
      if (priorChecksum !== checksum)
        throw new Error(`Applied migration checksum changed: ${name}`);
      continue;
    }
    const transaction = [
      "BEGIN;",
      sql,
      `INSERT INTO public.schema_migrations (name, checksum) VALUES (${quoteSql(name)}, ${quoteSql(checksum)});`,
      "COMMIT;",
    ].join("\n");
    await runPsql(transaction, true);
    newlyApplied += 1;
    console.log(`Applied ${name}`);
  }
  console.log(
    newlyApplied === 0 ? "Database schema is up to date." : `Applied ${newlyApplied} migration(s).`,
  );
}

await main();
