import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rm, stat, statfs } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { join } from "node:path";
import type { IntakeObjects, ReceivedUpload } from "./contracts.js";

export class StagingValidationError extends Error {}
export class StagingCapacityError extends Error {}

export type StagedObject = Readonly<{
  open(): ReadableStream<Uint8Array>;
  remove(): Promise<void>;
}>;

export async function stageIntakeObject(
  upload: ReceivedUpload,
  intake: IntakeObjects,
  directory: string,
  maximumBytes: number,
): Promise<StagedObject> {
  if (upload.byteCount > maximumBytes)
    throw new StagingValidationError("Intake object exceeds the configured size limit.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const disk = await statfs(directory);
  if (disk.bavail * disk.bsize < upload.byteCount)
    throw new StagingCapacityError("Worker staging volume has insufficient free space.");
  const path = join(directory, `${randomUUID()}.stage`);
  const file = await open(path, "wx", 0o600);
  const hash = createHash("sha256");
  let byteCount = 0;
  try {
    for await (const chunk of await intake.open(upload)) {
      byteCount += chunk.byteLength;
      if (byteCount > maximumBytes)
        throw new StagingValidationError("Intake object exceeds the configured size limit.");
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const result = await file.write(chunk, offset, chunk.byteLength - offset);
        if (result.bytesWritten === 0) throw new Error("Worker staging write made no progress.");
        offset += result.bytesWritten;
      }
    }
    if (byteCount !== upload.byteCount || hash.digest("hex") !== upload.expectedSha256) {
      throw new StagingValidationError(
        "Intake bytes do not match the durable size and SHA-256 reservation.",
      );
    }
  } catch (error) {
    await file.close();
    await rm(path, { force: true });
    throw error;
  }
  await file.close();
  return {
    open: () => Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>,
    remove: () => rm(path, { force: true }),
  };
}

/** Removes only abandoned worker snapshots older than the maximum request lifetime. */
export async function pruneAbandonedStages(directory: string, now = Date.now()): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/^[0-9a-f-]{36}\.stage$/.test(entry.name)) continue;
    const path = join(directory, entry.name);
    const age = now - (await stat(path)).mtimeMs;
    if (age > 2 * 60 * 60 * 1000) await rm(path, { force: true });
  }
}
