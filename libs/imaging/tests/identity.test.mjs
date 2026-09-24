import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { InvalidDicomError, readDicomIdentity } from "../dist/index.js";

const encoder = new TextEncoder();

function concat(...parts) {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

function element(group, number, vr, value) {
  const body = encoder.encode(value.length % 2 === 0 ? value : `${value}\0`);
  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);
  view.setUint16(0, group, true);
  view.setUint16(2, number, true);
  header.set(encoder.encode(vr), 4);
  view.setUint16(6, body.length, true);
  return concat(header, body);
}

function part10({ modality, sopClass, transferSyntax = "1.2.840.10008.1.2.1", mediaSop, sop }) {
  const study = "1.2.826.0.1.3680043.10.987.20";
  const series = `${study}.1`;
  const instance = sop ?? `${series}.1`;
  const fileMeta = concat(
    element(0x0002, 0x0003, "UI", mediaSop ?? instance),
    element(0x0002, 0x0010, "UI", transferSyntax),
  );
  const dataset = concat(
    element(0x0008, 0x0016, "UI", sopClass),
    element(0x0008, 0x0018, "UI", instance),
    element(0x0008, 0x0060, "CS", modality),
    element(0x0020, 0x000d, "UI", study),
    element(0x0020, 0x000e, "UI", series),
  );
  const groupLength = new Uint8Array(12);
  const view = new DataView(groupLength.buffer);
  view.setUint16(0, 0x0002, true);
  view.setUint16(2, 0x0000, true);
  groupLength.set(encoder.encode("UL"), 4);
  view.setUint16(6, 4, true);
  view.setUint32(8, fileMeta.length, true);
  return concat(new Uint8Array(128), encoder.encode("DICM"), groupLength, fileMeta, dataset);
}

function stream(bytes) {
  return new Response(bytes).body;
}

function hasTag(bytes, group, number) {
  const tag = Buffer.from([group & 0xff, group >> 8, number & 0xff, number >> 8]);
  return Buffer.from(bytes).includes(tag);
}

test("generated synthetic viewer fixtures have bounded identities and expected object classes", async (t) => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const generator = resolve(root, "deploy/cloud/scripts/make-synthetic-dicom.py");
  const directory = mkdtempSync(resolve(tmpdir(), "clarity-viewer-fixtures-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const expected = [
    { profile: "ct", modality: "CT", sopClass: "1.2.840.10008.5.1.4.1.1.2", pixels: true },
    { profile: "mr", modality: "MR", sopClass: "1.2.840.10008.5.1.4.1.1.4", pixels: true },
    { profile: "sr", modality: "SR", sopClass: "1.2.840.10008.5.1.4.1.1.88.11", pixels: false },
    { profile: "pdf", modality: "DOC", sopClass: "1.2.840.10008.5.1.4.1.1.104.1", pixels: false },
  ];
  for (const [index, fixture] of expected.entries()) {
    await t.test(fixture.profile, async () => {
      const path = resolve(directory, `${fixture.profile}.dcm`);
      execFileSync("python3", [generator, path, String(index + 31), "2", fixture.profile]);
      const bytes = readFileSync(path);
      const identity = await readDicomIdentity(stream(bytes));
      assert.equal(identity.studyInstanceUid, `1.2.826.0.1.3680043.10.987.${index + 31}`);
      assert.equal(identity.seriesInstanceUid, `${identity.studyInstanceUid}.1`);
      assert.equal(identity.sopInstanceUid, `${identity.seriesInstanceUid}.2`);
      assert.ok(bytes.includes(Buffer.from(fixture.modality)));
      assert.ok(bytes.includes(Buffer.from(fixture.sopClass)));
      assert.equal(hasTag(bytes, 0x7fe0, 0x0010), fixture.pixels);
      if (fixture.profile === "sr") {
        assert.ok(bytes.includes(Buffer.from("Synthetic finding only")));
        assert.ok(hasTag(bytes, 0x0040, 0xa730));
      }
      if (fixture.profile === "pdf") {
        assert.ok(bytes.includes(Buffer.from("application/pdf")));
        assert.ok(bytes.includes(Buffer.from("%PDF-1.4")));
      }
    });
  }
});

test("reads synthetic CT, MR and SR identity headers", async (t) => {
  const fixtures = [
    { modality: "CT", sopClass: "1.2.840.10008.5.1.4.1.1.2" },
    { modality: "MR", sopClass: "1.2.840.10008.5.1.4.1.1.4" },
    { modality: "SR", sopClass: "1.2.840.10008.5.1.4.1.1.88.11" },
  ];
  for (const profile of fixtures) {
    await t.test(profile.modality, async () => {
      const identity = await readDicomIdentity(stream(part10(profile)));
      assert.equal(identity.studyInstanceUid, "1.2.826.0.1.3680043.10.987.20");
      assert.equal(identity.seriesInstanceUid, "1.2.826.0.1.3680043.10.987.20.1");
      assert.equal(identity.sopInstanceUid, "1.2.826.0.1.3680043.10.987.20.1.1");
    });
  }
});

test("rejects compressed transfer syntax before importing unsupported bytes", async () => {
  const compressed = part10({
    modality: "CT",
    sopClass: "1.2.840.10008.5.1.4.1.1.2",
    transferSyntax: "1.2.840.10008.1.2.4.50",
  });
  await assert.rejects(readDicomIdentity(stream(compressed)), InvalidDicomError);
});

test("rejects file-meta and dataset SOP UID mismatch", async () => {
  const mismatch = part10({
    modality: "MR",
    sopClass: "1.2.840.10008.5.1.4.1.1.4",
    mediaSop: "1.2.826.0.1.3680043.10.987.20.1.9",
  });
  await assert.rejects(readDicomIdentity(stream(mismatch)), /file meta SOP UID differs/);
});

test("rejects a file-meta long-VR element declaring a 4 GiB value without buffering it", async () => {
  const oversizedElement = new Uint8Array(12);
  const view = new DataView(oversizedElement.buffer);
  view.setUint16(0, 0x0002, true);
  view.setUint16(2, 0x0001, true);
  oversizedElement.set(encoder.encode("OB"), 4);
  view.setUint32(8, 0xffffffff, true);
  const malformed = concat(new Uint8Array(128), encoder.encode("DICM"), oversizedElement);
  await assert.rejects(readDicomIdentity(stream(malformed)), /bounded header limit/);
});
