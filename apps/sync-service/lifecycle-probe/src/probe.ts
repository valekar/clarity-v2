import Database from "better-sqlite3";
import { createHmac, randomUUID } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

interface Options {
  databasePath: string;
  credentialPath: string;
  challenge: string;
  responsePath: string;
  heartbeatMilliseconds: number;
}

interface Credential {
  secret: string;
}

interface StateRow {
  startup_id: string;
  committed_sequence: number;
  admission_open: number;
}

const require = createRequire(import.meta.url);
const sqliteVersion = String(require("better-sqlite3/package.json").version);
const retainedHeartbeats = 32;
const retainedStartups = 16;

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function parseOptions(argv: string[]): Options | { inspectPath: string } {
  if (argv[0] === "--inspect") {
    const inspectPath = argv[1];
    if (!inspectPath) throw new Error("bad arguments");
    return { inspectPath };
  }
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || values.has(key)) throw new Error("bad arguments");
    values.set(key, value);
  }
  const databasePath = values.get("--db");
  const credentialPath = values.get("--credential");
  const challenge = values.get("--challenge");
  const responsePath = values.get("--response-file");
  const heartbeatMilliseconds = Number(values.get("--heartbeat-ms") ?? 100);
  if (
    !databasePath ||
    !credentialPath ||
    !challenge ||
    !responsePath ||
    !/^[0-9a-f]{64}$/i.test(challenge) ||
    !Number.isInteger(heartbeatMilliseconds) ||
    heartbeatMilliseconds < 50 ||
    heartbeatMilliseconds > 5_000
  ) {
    throw new Error("bad arguments");
  }
  return { databasePath, credentialPath, challenge, responsePath, heartbeatMilliseconds };
}

function readCredentialResponse(path: string, challenge: string): string {
  let parsed: Credential;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Credential;
  } catch {
    throw new Error("credential unavailable");
  }
  if (typeof parsed.secret !== "string" || !/^[0-9a-f]{64}$/i.test(parsed.secret)) {
    throw new Error("credential unavailable");
  }
  const response = createHmac("sha256", Buffer.from(parsed.secret, "hex"))
    .update(Buffer.from(challenge, "hex"))
    .digest("hex");
  writeFileSync(optionsResponsePath, response, { mode: 0o600 });
  chmodSync(optionsResponsePath, 0o600);
  return response;
}

let optionsResponsePath = "";

function createDatabase(path: string): Database.Database {
  const database = new Database(path);
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = FULL");
  database.pragma("busy_timeout = 5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS probe_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      startup_id TEXT NOT NULL,
      committed_sequence INTEGER NOT NULL CHECK (committed_sequence >= 0),
      admission_open INTEGER NOT NULL CHECK (admission_open IN (0, 1))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS probe_startup (
      startup_id TEXT PRIMARY KEY,
      pid INTEGER NOT NULL,
      uid INTEGER,
      started_at TEXT NOT NULL,
      stopped_at TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS probe_heartbeat (
      committed_sequence INTEGER PRIMARY KEY,
      startup_id TEXT NOT NULL,
      pid INTEGER NOT NULL,
      uid INTEGER,
      committed_at TEXT NOT NULL
    ) STRICT;
  `);
  return database;
}

function inspect(path: string): void {
  const database = createDatabase(path);
  const state = database.prepare("SELECT * FROM probe_state WHERE singleton = 1").get() as
    StateRow | undefined;
  const count = database.prepare("SELECT COUNT(*) AS count FROM probe_heartbeat").get() as {
    count: number;
  };
  const startups = database
    .prepare(
      "SELECT startup_id, pid, uid, started_at, stopped_at FROM probe_startup ORDER BY rowid",
    )
    .all();
  writeJson({ state: state ?? null, heartbeatCount: count.count, startups });
  database.close();
}

function run(options: Options): void {
  optionsResponsePath = options.responsePath;
  readCredentialResponse(options.credentialPath, options.challenge);
  const uid = process.getuid?.() ?? null;
  const pid = process.pid;
  const startupId = randomUUID();
  const database = createDatabase(options.databasePath);
  const start = database.transaction(() => {
    const previous = database
      .prepare("SELECT committed_sequence FROM probe_state WHERE singleton = 1")
      .get() as { committed_sequence: number } | undefined;
    const sequence = previous?.committed_sequence ?? 0;
    const now = new Date().toISOString();
    database
      .prepare("INSERT INTO probe_startup (startup_id, pid, uid, started_at) VALUES (?, ?, ?, ?)")
      .run(startupId, pid, uid, now);
    database
      .prepare(
        `INSERT INTO probe_state (singleton, startup_id, committed_sequence, admission_open)
         VALUES (1, ?, ?, 1)
         ON CONFLICT(singleton) DO UPDATE SET
           startup_id = excluded.startup_id, committed_sequence = excluded.committed_sequence,
           admission_open = 1`,
      )
      .run(startupId, sequence);
    database
      .prepare(
        `DELETE FROM probe_startup WHERE startup_id NOT IN
         (SELECT startup_id FROM probe_startup ORDER BY started_at DESC LIMIT ?)`,
      )
      .run(retainedStartups);
  });
  start();
  writeJson({
    type: "started",
    startupId,
    pid,
    uid,
    sqliteVersion,
    nodeVersion: process.versions.node,
    executable: process.execPath,
  });

  let accepting = true;
  let stopping = false;
  const heartbeat = setInterval(() => {
    if (!accepting) return;
    const commit = database.transaction(() => {
      const current = database
        .prepare("SELECT committed_sequence FROM probe_state WHERE singleton = 1")
        .get() as { committed_sequence: number };
      const sequence = current.committed_sequence + 1;
      const now = new Date().toISOString();
      database
        .prepare("UPDATE probe_state SET committed_sequence = ? WHERE singleton = 1")
        .run(sequence);
      database
        .prepare(
          `INSERT INTO probe_heartbeat
            (committed_sequence, startup_id, pid, uid, committed_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(sequence, startupId, pid, uid, now);
      database
        .prepare(`DELETE FROM probe_heartbeat WHERE committed_sequence <= ?`)
        .run(Math.max(0, sequence - retainedHeartbeats));
    });
    commit();
  }, options.heartbeatMilliseconds);

  const stop = () => {
    if (stopping) return;
    stopping = true;
    accepting = false;
    clearInterval(heartbeat);
    const transaction = database.transaction(() => {
      const state = database
        .prepare("SELECT committed_sequence FROM probe_state WHERE singleton = 1")
        .get() as { committed_sequence: number };
      database.prepare("UPDATE probe_state SET admission_open = 0 WHERE singleton = 1").run();
      database
        .prepare("UPDATE probe_startup SET stopped_at = ? WHERE startup_id = ?")
        .run(new Date().toISOString(), startupId);
      return state.committed_sequence;
    });
    const finalSequence = transaction();
    database.pragma("wal_checkpoint(TRUNCATE)");
    database.close();
    writeJson({ type: "stopped", startupId, sequence: finalSequence });
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

try {
  const argv = process.argv.slice(2);
  if (argv[0] === "--validate-arguments") {
    const validated = parseOptions(argv.slice(1));
    if ("inspectPath" in validated) throw new Error("bad arguments");
    writeJson({ type: "valid-arguments", databasePath: validated.databasePath });
  } else {
    const parsed = parseOptions(argv);
    if ("inspectPath" in parsed) inspect(parsed.inspectPath);
    else run(parsed);
  }
} catch (error) {
  const diagnostic = error instanceof Error ? error.message : "probe failed";
  process.stderr.write(
    `${diagnostic === "credential unavailable" ? "credential unavailable" : "probe failed"}\n`,
  );
  process.exitCode = diagnostic === "credential unavailable" ? 78 : 1;
}
