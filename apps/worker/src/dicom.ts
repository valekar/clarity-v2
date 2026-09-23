import { createHash } from "node:crypto";

export { InvalidDicomError, readDicomIdentity } from "@clarity/imaging";

export class ObjectLimitError extends Error {}

export async function hashStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Readonly<{ sha256: string; byteCount: number }>> {
  const hash = createHash("sha256");
  let byteCount = 0;
  for await (const chunk of stream) {
    byteCount += chunk.byteLength;
    if (byteCount > maxBytes)
      throw new ObjectLimitError("Intake object exceeds the configured size limit.");
    hash.update(chunk);
  }
  return { sha256: hash.digest("hex"), byteCount };
}
