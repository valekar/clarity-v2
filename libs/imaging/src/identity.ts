export type DicomIdentity = Readonly<{
  studyInstanceUid: string;
  seriesInstanceUid: string;
  sopInstanceUid: string;
}>;

const targetTags = new Map<number, keyof DicomIdentity>([
  [0x0020000d, "studyInstanceUid"],
  [0x0020000e, "seriesInstanceUid"],
  [0x00080018, "sopInstanceUid"],
]);

export class InvalidDicomError extends Error {}
const MAX_FILE_META_BYTES = 64 * 1024;
const MAX_FILE_META_ELEMENTS = 128;
const MAX_FILE_META_UID_BYTES = 128;

class StreamReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private current: Uint8Array<ArrayBufferLike> = new Uint8Array();
  private offset = 0;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.iterator = stream[Symbol.asyncIterator]();
  }

  async close(): Promise<void> {
    await this.iterator.return?.();
  }

  async exact(size: number): Promise<Uint8Array> {
    const output = new Uint8Array(size);
    let written = 0;
    while (written < size) {
      if (this.offset === this.current.length) {
        const next = await this.iterator.next();
        if (next.done) throw new InvalidDicomError("DICOM object ended before the required tags.");
        this.current = next.value;
        this.offset = 0;
      }
      const count = Math.min(size - written, this.current.length - this.offset);
      output.set(this.current.subarray(this.offset, this.offset + count), written);
      this.offset += count;
      written += count;
    }
    return output;
  }

  async skip(size: number): Promise<void> {
    let remaining = size;
    while (remaining > 0) {
      const count = Math.min(remaining, 65536);
      await this.exact(count);
      remaining -= count;
    }
  }
}

function uint16(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(
    offset,
    littleEndian,
  );
}

function uint32(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    offset,
    littleEndian,
  );
}

function uidValue(bytes: Uint8Array): string {
  return new TextDecoder("ascii").decode(bytes).replace(/[\0 ]+$/g, "");
}

/** Reads only bounded DICOM headers; pixel data and other values are skipped as a stream. */
export async function readDicomIdentity(
  stream: ReadableStream<Uint8Array>,
): Promise<DicomIdentity> {
  const reader = new StreamReader(stream);
  try {
    const preamble = await reader.exact(132);
    if (new TextDecoder("ascii").decode(preamble.subarray(128)) !== "DICM") {
      throw new InvalidDicomError("DICOM Part 10 marker is missing.");
    }
    let transferSyntax = "";
    let mediaSopUid = "";
    let metaBytes = 0;
    for (let metaElements = 0; metaElements < MAX_FILE_META_ELEMENTS; metaElements += 1) {
      const header = await reader.exact(8);
      const group = uint16(header, 0, true);
      if (group !== 0x0002) {
        return await readDataset(reader, header, transferSyntax, mediaSopUid);
      }
      let encodedHeaderBytes = 8;
      const vr = new TextDecoder("ascii").decode(header.subarray(4, 6));
      if (!/^[A-Z]{2}$/.test(vr)) throw new InvalidDicomError("Invalid DICOM file meta header.");
      const longVr = ["OB", "OD", "OF", "OL", "OV", "OW", "SQ", "UC", "UR", "UT", "UN"].includes(
        vr,
      );
      let length: number;
      let valuePrefix: Uint8Array | undefined;
      if (longVr) {
        const rest = await reader.exact(4);
        encodedHeaderBytes += 4;
        length = uint32(rest, 0, true);
      } else {
        length = uint16(header, 6, true);
        if (length > 0) valuePrefix = await reader.exact(length);
      }
      const tag = (group << 16) | uint16(header, 2, true);
      if (length === 0xffffffff || length > MAX_FILE_META_BYTES) {
        throw new InvalidDicomError("DICOM file meta element exceeds the bounded header limit.");
      }
      metaBytes += encodedHeaderBytes + length;
      if (metaBytes > MAX_FILE_META_BYTES) {
        throw new InvalidDicomError("DICOM file meta header exceeds the bounded size limit.");
      }
      if (tag === 0x00020010) {
        if (vr !== "UI" || length < 1 || length > MAX_FILE_META_UID_BYTES) {
          throw new InvalidDicomError("Transfer Syntax UID has an invalid file meta encoding.");
        }
        if (valuePrefix === undefined) valuePrefix = await reader.exact(length);
        transferSyntax = uidValue(valuePrefix);
      } else if (tag === 0x00020003) {
        if (vr !== "UI" || length < 1 || length > MAX_FILE_META_UID_BYTES) {
          throw new InvalidDicomError("Media Storage SOP UID has an invalid file meta encoding.");
        }
        if (valuePrefix === undefined) valuePrefix = await reader.exact(length);
        mediaSopUid = uidValue(valuePrefix);
      } else if (longVr && length > 0) {
        await reader.skip(length);
      }
    }
    throw new InvalidDicomError("DICOM file meta header exceeded the element limit.");
  } finally {
    await reader.close();
  }
}

async function readDataset(
  reader: StreamReader,
  firstHeader: Uint8Array,
  transferSyntax: string,
  mediaSopUid: string,
): Promise<DicomIdentity> {
  const implicit = transferSyntax === "1.2.840.10008.1.2";
  if (!implicit && transferSyntax !== "1.2.840.10008.1.2.1") {
    throw new InvalidDicomError(
      "Unsupported transfer syntax; only implicit or explicit little endian is accepted.",
    );
  }
  const identity: Partial<Record<keyof DicomIdentity, string>> = {};
  let header = firstHeader;
  for (let count = 0; count < 100_000; count += 1) {
    const group = uint16(header, 0, true);
    const element = uint16(header, 2, true);
    const tag = (group << 16) | element;
    let length: number;
    if (implicit) {
      length = uint32(header, 4, true);
    } else {
      const vr = new TextDecoder("ascii").decode(header.subarray(4, 6));
      if (!/^[A-Z]{2}$/.test(vr))
        throw new InvalidDicomError("Invalid explicit VR dataset header.");
      const longVr = ["OB", "OD", "OF", "OL", "OV", "OW", "SQ", "UC", "UR", "UT", "UN"].includes(
        vr,
      );
      if (longVr) {
        const rest = await reader.exact(4);
        length = uint32(rest, 0, true);
      } else {
        length = uint16(header, 6, true);
      }
    }
    const key = targetTags.get(tag);
    if (key !== undefined) {
      if (length > 128 || length === 0xffffffff)
        throw new InvalidDicomError("Invalid DICOM UID length.");
      const value = await reader.exact(length);
      identity[key] = uidValue(value);
      if (identity.studyInstanceUid && identity.seriesInstanceUid && identity.sopInstanceUid) {
        if (mediaSopUid !== "" && identity.sopInstanceUid !== mediaSopUid) {
          throw new InvalidDicomError("DICOM file meta SOP UID differs from the dataset SOP UID.");
        }
        return identity as DicomIdentity;
      }
    } else {
      if (length === 0xffffffff)
        throw new InvalidDicomError(
          "Undefined-length values before required UIDs are unsupported.",
        );
      await reader.skip(length);
    }
    header = await reader.exact(8);
  }
  throw new InvalidDicomError("DICOM header exceeded the element limit before required UIDs.");
}
