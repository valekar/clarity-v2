import { writeFileSync } from "node:fs";

function encodeValue(value: string | Buffer, vr: string): Buffer {
  if (Buffer.isBuffer(value)) return value;
  const pad = value.length % 2 ? (vr === "UI" ? "\0" : " ") : "";
  return Buffer.from(value + pad, "ascii");
}

function element(group: number, tag: number, vr: string, value: string | Buffer): Buffer {
  const bytes = encodeValue(value, vr);
  const longLength = new Set([
    "OB",
    "OD",
    "OF",
    "OL",
    "OV",
    "OW",
    "SQ",
    "UC",
    "UN",
    "UR",
    "UT",
  ]).has(vr);
  const header = Buffer.alloc(longLength ? 12 : 8);
  header.writeUInt16LE(group, 0);
  header.writeUInt16LE(tag, 2);
  header.write(vr, 4, 2, "ascii");
  if (longLength) header.writeUInt32LE(bytes.length, 8);
  else header.writeUInt16LE(bytes.length, 6);
  return Buffer.concat([header, bytes]);
}

const [path, studyUid, seriesUid, sopUid] = process.argv.slice(2);
if (!path || !studyUid || !seriesUid || !sopUid) {
  throw new Error("output path and synthetic study, series, and SOP UIDs are required");
}
const sopClass = "1.2.840.10008.5.1.4.1.1.7";
const transferSyntax = "1.2.840.10008.1.2.1";
const fileMeta = Buffer.concat([
  element(2, 1, "OB", Buffer.from([0, 1])),
  element(2, 2, "UI", sopClass),
  element(2, 3, "UI", sopUid),
  element(2, 0x10, "UI", transferSyntax),
  element(2, 0x12, "UI", "2.25.123456789012345678901234567890123456"),
]);
const groupLength = Buffer.alloc(12);
groupLength.writeUInt16LE(2, 0);
groupLength.writeUInt16LE(0, 2);
groupLength.write("UL", 4, 2, "ascii");
groupLength.writeUInt16LE(4, 6);
groupLength.writeUInt32LE(fileMeta.length, 8);
const dataSet = Buffer.concat([
  element(8, 0x16, "UI", sopClass),
  element(8, 0x18, "UI", sopUid),
  element(8, 0x60, "CS", "CT"),
  element(0x10, 0x10, "PN", "Synthetic^V2"),
  element(0x10, 0x20, "LO", "SYNTHETIC-V2"),
  element(0x20, 0x0d, "UI", studyUid),
  element(0x20, 0x0e, "UI", seriesUid),
  element(0x20, 0x13, "IS", "1"),
  element(0x28, 2, "US", Buffer.from([1, 0])),
  element(0x28, 4, "CS", "MONOCHROME2"),
  element(0x28, 0x10, "US", Buffer.from([2, 0])),
  element(0x28, 0x11, "US", Buffer.from([2, 0])),
  element(0x28, 0x100, "US", Buffer.from([8, 0])),
  element(0x28, 0x101, "US", Buffer.from([8, 0])),
  element(0x28, 0x102, "US", Buffer.from([7, 0])),
  element(0x28, 0x103, "US", Buffer.from([0, 0])),
  element(0x7fe0, 0x10, "OB", Buffer.from([0, 1, 2, 3])),
]);
writeFileSync(
  path,
  Buffer.concat([Buffer.alloc(128), Buffer.from("DICM"), groupLength, fileMeta, dataSet]),
);
