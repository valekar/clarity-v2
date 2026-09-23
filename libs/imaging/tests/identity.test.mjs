import assert from "node:assert/strict";
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
