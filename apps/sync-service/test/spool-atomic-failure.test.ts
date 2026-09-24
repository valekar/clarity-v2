import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { CheckpointStore } from "../src/persistence/checkpoint-store.js";
import { OrthancDiscoveryClient } from "../src/orthanc/discovery-client.js";
import { spoolInstance } from "../src/transfers/spool-instance.js";
import type { SpoolOptions } from "../src/transfers/spool-instance.js";

const sourceKey = "synthetic-enospc-source";
const studyUid = "2.25.701";
const seriesUid = "2.25.702";
const sopUid = "2.25.703";
const bytes = Buffer.concat([Buffer.from("DICM"), Buffer.alloc(128 * 1024, 0x5a)]);
const digest = createHash("sha256").update(bytes).digest("hex");
let directory: string;
let source: Server;
let sourceUrl: string;
let reads: number;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "clarity-spool-enospc-"));
  reads = 0;
  source = createServer((_request, response) => {
    reads += 1;
    const middle = Math.floor(bytes.length / 2);
    response.writeHead(200, { "content-length": String(bytes.length) });
    response.write(bytes.subarray(0, middle));
    response.end(bytes.subarray(middle));
  });
  await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
  const address = source.address();
  if (!address || typeof address === "string") throw new Error("source fixture did not bind");
  sourceUrl = `http://127.0.0.1:${address.port}/`;
});

after(async () => {
  await new Promise<void>((resolve) => source.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

async function failThenRetry(
  name: string,
  options: Pick<SpoolOptions, "writeChunk" | "renameFile">,
  failureMessage: RegExp,
): Promise<void> {
  const initialReads = reads;
  const databasePath = join(directory, `${name}.sqlite`);
  const spoolDirectory = join(directory, name);
  const instance = {
    orthancInstanceId: "synthetic-instance",
    orthancStudyId: "synthetic-study",
    studyInstanceUid: studyUid,
    seriesInstanceUid: seriesUid,
    sopInstanceUid: sopUid,
  };
  const orthanc = new OrthancDiscoveryClient({ baseUrl: sourceUrl });
  let store = new CheckpointStore(databasePath);
  store.capturePage(
    sourceKey,
    { databaseServerIdentifier: "synthetic-db", databaseVersion: 6 },
    0,
    { last: 0, done: true, changes: [] },
  );
  const spoolOptions: SpoolOptions = {
    directory: spoolDirectory,
    maximumObjectBytes: 1024 * 1024,
    reserveFreeBytes: 4096,
    ...options,
  };
  try {
    await assert.rejects(
      spoolInstance(sourceKey, 0, instance, orthanc, store, spoolOptions),
      failureMessage,
    );
    assert.equal(store.uploads.findBySop(sourceKey, sopUid), null);
    assert.deepEqual(await readdir(spoolDirectory), []);
    store.close();

    store = new CheckpointStore(databasePath);
    assert.equal(store.uploads.findBySop(sourceKey, sopUid), null);
    const upload = await spoolInstance(sourceKey, 0, instance, orthanc, store, {
      directory: spoolDirectory,
      maximumObjectBytes: 1024 * 1024,
      reserveFreeBytes: 4096,
    });
    assert.equal(upload.state, "spooled");
    assert.equal(upload.sha256, digest);
    assert.equal(upload.byteCount, bytes.length);
    assert.deepEqual(await readFile(upload.spoolPath!), bytes);
    assert.equal(store.uploads.listSpoolPaths().length, 1);
    store.close();

    store = new CheckpointStore(databasePath);
    const durable = store.uploads.findBySop(sourceKey, sopUid);
    assert.equal(durable?.state, "spooled");
    assert.equal(durable?.sha256, digest);
    assert.equal(durable?.byteCount, bytes.length);
    assert.equal(reads - initialReads, 2);
  } finally {
    store.close();
  }
}

test("ENOSPC during spool write removes the partial and retries exact source bytes", async () => {
  let writes = 0;
  await failThenRetry(
    "write-enospc",
    {
      writeChunk: async (file, chunk, offset, length) => {
        if (writes++ > 0) {
          const failure = new Error("synthetic ENOSPC during spool write") as NodeJS.ErrnoException;
          failure.code = "ENOSPC";
          throw failure;
        }
        return (await file.write(chunk, offset, Math.min(length, 4096))).bytesWritten;
      },
    },
    /synthetic ENOSPC/,
  );
});

test("rename failure removes the complete partial and retries exact source bytes", async () => {
  await failThenRetry(
    "rename-error",
    {
      renameFile: async () => {
        throw new Error("synthetic rename failure after file sync");
      },
    },
    /synthetic rename failure/,
  );
});

test("invalid file writer byte counts fail closed and allow an exact retry", async () => {
  await failThenRetry(
    "invalid-write-count",
    { writeChunk: async (_file, _chunk, _offset, length) => length + 1 },
    /invalid byte count/,
  );
});
