import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  CloudIndex,
  DicomIdentity,
  IntakeObjects,
  ReceivedUpload,
  WorkerDependencies,
  WorkerRepository,
} from "../src/contracts.js";
import { cleanupCompletedUpload, processReceivedUpload } from "../src/import-instance.js";
import { readDicomIdentity } from "../src/dicom.js";

const expected: DicomIdentity = {
  studyInstanceUid: "1.2.840.10008.1.1",
  seriesInstanceUid: "1.2.840.10008.1.1.1",
  sopInstanceUid: "1.2.840.10008.1.1.1.1",
};

function element(group: number, tag: number, vr: string, value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value.length % 2 === 0 ? value : `${value}\0`);
  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);
  view.setUint16(0, group, true);
  view.setUint16(2, tag, true);
  header.set(new TextEncoder().encode(vr), 4);
  view.setUint16(6, encoded.length, true);
  return concat(header, encoded);
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function longElement(group: number, tag: number, vr: string, value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value);
  const header = new Uint8Array(12);
  const view = new DataView(header.buffer);
  view.setUint16(0, group, true);
  view.setUint16(2, tag, true);
  header.set(new TextEncoder().encode(vr), 4);
  view.setUint32(8, encoded.length, true);
  return concat(header, encoded);
}

function dicomFixture(): Uint8Array {
  const preamble = new Uint8Array(128);
  const marker = new TextEncoder().encode("DICM");
  const mediaSop = element(0x0002, 0x0003, "UI", expected.sopInstanceUid);
  const meta = element(0x0002, 0x0010, "UI", "1.2.840.10008.1.2.1");
  return concat(
    preamble,
    marker,
    mediaSop,
    meta,
    element(0x0008, 0x0018, "UI", expected.sopInstanceUid),
    longElement(0x0008, 0x1110, "SQ", "1234"),
    element(0x0020, 0x000d, "UI", expected.studyInstanceUid),
    element(0x0020, 0x000e, "UI", expected.seriesInstanceUid),
    element(0x7fe0, 0x0010, "OB", "synthetic-pixel-data"),
  );
}

const bytes = dicomFixture();
const upload: ReceivedUpload = {
  uploadId: "60000000-0000-4000-8000-000000000001",
  reportId: "40000000-0000-4000-8000-000000000001",
  sourceId: "20000000-0000-4000-8000-000000000001",
  reportFileId: "50000000-0000-4000-8000-000000000001",
  objectKey: "synthetic/upload",
  expectedSha256: createHash("sha256").update(bytes).digest("hex"),
  byteCount: bytes.length,
  ...expected,
};

const stream = (value: Uint8Array): ReadableStream<Uint8Array> =>
  new Response(value).body as ReadableStream<Uint8Array>;

class MemoryIntake implements IntakeObjects {
  removed = 0;
  openCalls = 0;
  async open(upload: ReceivedUpload): Promise<ReadableStream<Uint8Array>> {
    void upload;
    this.openCalls += 1;
    return stream(bytes);
  }
  async remove(upload: ReceivedUpload): Promise<void> {
    void upload;
    this.removed += 1;
  }
}

class MemoryIndex implements CloudIndex {
  imports = 0;
  indexed?: Uint8Array;
  async findBySopInstanceUid(): Promise<string | undefined> {
    return this.indexed ? "orthanc-instance-1" : undefined;
  }
  async importInstance(body: ReadableStream<Uint8Array>): Promise<string> {
    this.imports += 1;
    this.indexed = new Uint8Array(await new Response(body).arrayBuffer());
    return "orthanc-instance-1";
  }
  async readIdentity(): Promise<DicomIdentity> {
    return expected;
  }
  async readBytes(): Promise<ReadableStream<Uint8Array>> {
    return stream(this.indexed ?? new Uint8Array());
  }
}

class MemoryRepository implements WorkerRepository {
  completed = false;
  attention = false;
  loseFirstReply = false;
  cleaned = false;
  authorized = true;
  async listReceived(): Promise<readonly ReceivedUpload[]> {
    return this.completed ? [] : [upload];
  }
  async listCleanupPending(): Promise<readonly ReceivedUpload[]> {
    return this.completed && !this.cleaned ? [upload] : [];
  }
  async authorizeImport(_upload: ReceivedUpload): Promise<boolean> {
    void _upload;
    return this.authorized;
  }
  async assertUidOwnership(): Promise<boolean> {
    return true;
  }
  async completeIndexed(_upload: ReceivedUpload, _instanceId: string): Promise<void> {
    void _upload;
    void _instanceId;
    this.completed = true;
    if (this.loseFirstReply) {
      this.loseFirstReply = false;
      throw new Error("simulated lost database reply");
    }
  }
  async markAttention(): Promise<void> {
    this.attention = true;
  }
  async markIntakeCleaned(): Promise<void> {
    this.cleaned = true;
  }
}

test("stale received upload is rejected before intake or Orthanc effects", async () => {
  const repository = new MemoryRepository();
  repository.authorized = false;
  const intake = new MemoryIntake();
  const index = new MemoryIndex();
  const dependencies: WorkerDependencies = {
    repository,
    intake,
    index,
    maxObjectBytes: 1024 * 1024,
    stagingDirectory: "/tmp/clarity-worker-test",
  };
  await processReceivedUpload(upload, dependencies);
  assert.equal(intake.openCalls, 0);
  assert.equal(intake.removed, 0);
  assert.equal(index.imports, 0);
  assert.equal(repository.completed, false);
});

test("rechecks the source fence after validation and before the Orthanc POST", async () => {
  let revoked = false;
  const state = setup((stage) => {
    if (stage === "dicom-validated") revoked = true;
  });
  let authorizations = 0;
  state.repository.authorizeImport = async () => {
    authorizations += 1;
    return !revoked;
  };
  await processReceivedUpload(upload, state.dependencies);
  assert.equal(authorizations, 2);
  assert.equal(state.index.imports, 0);
  assert.equal(state.repository.completed, false);
  assert.equal(state.intake.removed, 0);
});

function setup(onProgress?: WorkerDependencies["onProgress"]) {
  const repository = new MemoryRepository();
  const intake = new MemoryIntake();
  const index = new MemoryIndex();
  const dependencies: WorkerDependencies = {
    repository,
    intake,
    index,
    maxObjectBytes: 1_000_000,
    stagingDirectory: join(tmpdir(), "clarity-v2-worker-test-staging"),
    ...(onProgress === undefined ? {} : { onProgress }),
  };
  return { repository, intake, index, dependencies };
}

test("reconciles an uncertain import after Orthanc accepted bytes but the DB reply was lost", async () => {
  const state = setup();
  state.repository.loseFirstReply = true;
  await assert.rejects(processReceivedUpload(upload, state.dependencies), /lost database reply/);
  assert.equal(state.index.imports, 1);
  assert.equal(state.intake.removed, 0);

  await processReceivedUpload(upload, state.dependencies);
  assert.equal(
    state.index.imports,
    1,
    "retry verifies the existing Orthanc object instead of importing twice",
  );
  assert.equal(state.repository.completed, true);
  assert.equal(state.intake.removed, 1);
});

test("a new authorized owner adopts an exact stale Orthanc effect without a second POST", async (t) => {
  await t.test("same SOP and digest", async () => {
    const state = setup();
    const replacement: ReceivedUpload = {
      ...upload,
      uploadId: "60000000-0000-4000-8000-000000000002",
    };
    let authorizedUploadId = upload.uploadId;
    let authorizationCount = 0;
    state.repository.authorizeImport = async (candidate) => {
      authorizationCount += 1;
      return candidate.uploadId === authorizedUploadId;
    };
    state.repository.completeIndexed = async (candidate) => {
      if (candidate.uploadId === upload.uploadId) throw new Error("fence superseded at commit");
      state.repository.completed = true;
    };
    const oldProgress = state.dependencies.onProgress;
    state.dependencies = {
      ...state.dependencies,
      onProgress: (event) => {
        oldProgress?.(event);
        if (event === "fence-rechecked") {
          // Model takeover after the successful pre-POST authorization query
          // returned, in the unavoidable DB-to-Orthanc effect gap.
          authorizedUploadId = replacement.uploadId;
        }
      },
    };
    await assert.rejects(processReceivedUpload(upload, state.dependencies), /fence superseded/);
    assert.equal(authorizationCount, 2);
    assert.equal(state.index.imports, 1);
    assert.equal(state.repository.completed, false);
    assert.deepEqual(state.index.indexed, bytes);
    assert.equal(state.intake.removed, 0, "stale completion retains intake for reconciliation");

    await processReceivedUpload(replacement, state.dependencies);
    assert.equal(state.index.imports, 1);
    assert.equal(state.repository.completed, true);
    assert.equal(state.intake.removed, 1);
  });

  await t.test("same SOP with a conflicting digest", async () => {
    const state = setup();
    const replacement: ReceivedUpload = {
      ...upload,
      uploadId: "60000000-0000-4000-8000-000000000003",
      expectedSha256: "f".repeat(64),
    };
    state.index.indexed = bytes;
    await assert.rejects(
      processReceivedUpload(replacement, state.dependencies),
      /readback does not match/,
    );
    assert.equal(state.repository.completed, false);
    assert.equal(state.repository.attention, true);
    assert.equal(state.index.imports, 0);
  });
});

test("retries cleanup after the durable completion committed but cleanup failed", async () => {
  const state = setup();
  const originalRemove = state.intake.remove.bind(state.intake);
  let fail = true;
  state.intake.remove = async (item) => {
    if (fail) {
      fail = false;
      throw new Error("simulated cleanup timeout");
    }
    await originalRemove(item);
  };
  await assert.rejects(processReceivedUpload(upload, state.dependencies), /cleanup timeout/);
  assert.equal(state.repository.completed, true);
  await processReceivedUpload(upload, state.dependencies);
  assert.equal(state.index.imports, 1);
  assert.equal(state.intake.removed, 1);
});

test("quarantines digest mismatch before any cloud Orthanc side effect", async () => {
  const state = setup();
  state.intake.open = async () => stream(new TextEncoder().encode("not the admitted object"));
  await assert.rejects(processReceivedUpload(upload, state.dependencies), /do not match/);
  assert.equal(state.index.imports, 0);
  assert.equal(state.repository.attention, true);
  assert.equal(state.repository.completed, false);
});

test("quarantines cloud Orthanc UID or byte readback mismatch", async (t) => {
  await t.test("UID mismatch", async () => {
    const state = setup();
    state.index.readIdentity = async () => ({ ...expected, sopInstanceUid: "1.2.3.999" });
    await assert.rejects(
      processReceivedUpload(upload, state.dependencies),
      /UID values do not match/,
    );
    assert.equal(state.repository.completed, false);
    assert.equal(state.repository.attention, true);
  });
  await t.test("byte mismatch", async () => {
    const state = setup();
    state.index.readBytes = async () => stream(new TextEncoder().encode("different indexed bytes"));
    await assert.rejects(
      processReceivedUpload(upload, state.dependencies),
      /readback does not match/,
    );
    assert.equal(state.repository.completed, false);
    assert.equal(state.repository.attention, true);
  });
});

test("leaves transient object-store failures eligible for retry", async () => {
  const state = setup();
  state.intake.open = async () => {
    throw new Error("simulated object-store outage");
  };
  await assert.rejects(processReceivedUpload(upload, state.dependencies), /outage/);
  assert.equal(state.repository.attention, false);
  assert.equal(state.repository.completed, false);
  state.intake.open = async () => stream(bytes);
  await processReceivedUpload(upload, state.dependencies);
  assert.equal(state.repository.completed, true);
});

test("does not turn a transient stream error during DICOM header read into attention", async () => {
  const state = setup();
  state.intake.open = async () => {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 50));
        controller.error(new Error("simulated intake stream reset"));
      },
    });
  };
  await assert.rejects(processReceivedUpload(upload, state.dependencies), /stream reset/);
  assert.equal(state.repository.attention, false);
  assert.equal(state.repository.completed, false);
});

test("persists attention for an object that exceeds the configured per-instance limit", async () => {
  const state = setup();
  const dependencies = { ...state.dependencies, maxObjectBytes: bytes.length - 1 };
  await assert.rejects(processReceivedUpload(upload, dependencies), /size limit/);
  assert.equal(state.index.imports, 0);
  assert.equal(state.repository.attention, true);
});

test("imports the validated staged snapshot if the intake key changes after its first read", async () => {
  const state = setup();
  const changed = bytes.slice();
  changed[changed.length - 1] = (changed.at(-1) ?? 0) ^ 1;
  state.intake.open = async () => {
    state.intake.openCalls += 1;
    return stream(state.intake.openCalls === 1 ? bytes : changed);
  };
  await processReceivedUpload(upload, state.dependencies);
  assert.equal(
    state.intake.openCalls,
    1,
    "hash, parser and Orthanc consume one staged byte snapshot",
  );
  assert.deepEqual(state.index.indexed, bytes);
  assert.equal(state.repository.completed, true);
});

test("retries durable cleanup work after a worker restart", async () => {
  const state = setup();
  state.repository.completed = true;
  let fail = true;
  state.intake.remove = async () => {
    if (fail) {
      fail = false;
      throw new Error("simulated delete outage");
    }
  };
  await assert.rejects(cleanupCompletedUpload(upload, state.dependencies), /delete outage/);
  assert.equal(state.repository.cleaned, false);
  await cleanupCompletedUpload(upload, state.dependencies);
  assert.equal(state.repository.cleaned, true);
});

test("fails closed on unsupported transfer syntax and undefined-length pre-UID values", async () => {
  const unsupported = dicomFixture().slice();
  const syntaxStart = 132 + 30 + 8;
  const explicitBigEndian = new TextEncoder().encode("1.2.840.10008.1.2.2\0");
  unsupported.set(explicitBigEndian, syntaxStart);
  await assert.rejects(readDicomIdentity(stream(unsupported)), /Unsupported transfer syntax/);

  const preamble = new Uint8Array(128);
  const marker = new TextEncoder().encode("DICM");
  const syntax = element(0x0002, 0x0010, "UI", "1.2.840.10008.1.2.1");
  const undefinedSequence = new Uint8Array(12);
  const view = new DataView(undefinedSequence.buffer);
  view.setUint16(0, 0x0008, true);
  view.setUint16(2, 0x1110, true);
  undefinedSequence.set(new TextEncoder().encode("SQ"), 4);
  view.setUint32(8, 0xffffffff, true);
  await assert.rejects(
    readDicomIdentity(stream(concat(preamble, marker, syntax, undefinedSequence))),
    /Undefined-length/,
  );
});

test("releases the staged stream when the required header fields are found early", async () => {
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
    },
    cancel() {
      cancelled = true;
    },
  });
  assert.deepEqual(await readDicomIdentity(source), expected);
  assert.equal(cancelled, true);
});
