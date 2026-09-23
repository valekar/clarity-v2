import Database from "better-sqlite3";

export class DuplicateServiceInstanceError extends Error {}

/** Hold SQLite's cross-process exclusive lock on a dedicated file until shutdown. */
export async function acquireServiceLock(databasePath: string): Promise<() => Promise<void>> {
  const lockDatabase = new Database(`${databasePath}.service-lock.sqlite`, {
    timeout: 0,
  });
  try {
    lockDatabase.pragma("journal_mode = DELETE");
    lockDatabase.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    lockDatabase.close();
    if (isBusy(error)) {
      throw new DuplicateServiceInstanceError("another sync process owns this local database");
    }
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      lockDatabase.exec("ROLLBACK");
    } finally {
      lockDatabase.close();
    }
  };
}

function isBusy(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "SQLITE_BUSY"
  );
}
