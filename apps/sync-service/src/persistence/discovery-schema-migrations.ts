import type Database from "better-sqlite3";

interface MigrationRow {
  version: number;
}

/** Apply additive, versioned local SQLite upgrades without dropping durable sync state. */
export function migrateDiscoverySchema(database: Database.Database): void {
  database.exec(`CREATE TABLE IF NOT EXISTS local_schema_migration (
    version INTEGER PRIMARY KEY CHECK (version > 0), applied_at TEXT NOT NULL
  ) STRICT`);
  const migrate = database.transaction(() => {
    const applied = new Set(
      (database.prepare("SELECT version FROM local_schema_migration").all() as MigrationRow[]).map(
        (row) => row.version,
      ),
    );
    if (!applied.has(1)) {
      ensureColumn(database, "logical_report", "patient_issuer_of_patient_id", "TEXT");
      record(database, 1);
    }
    if (!applied.has(2)) {
      ensureColumn(database, "inventory_run", "completed_at", "TEXT");
      record(database, 2);
    }
  });
  migrate();
}

function ensureColumn(
  database: Database.Database,
  table: string,
  name: string,
  type: string,
): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === name)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

function record(database: Database.Database, version: number): void {
  database
    .prepare("INSERT INTO local_schema_migration (version, applied_at) VALUES (?, ?)")
    .run(version, new Date().toISOString());
}
