import "server-only";
import { createHash } from "node:crypto";

export async function verifyIntakeObject(
  stream: ReadableStream<Uint8Array>,
  expectedBytes: number,
): Promise<Readonly<{ sha256: string; byteCount: number }>> {
  const reader = stream.getReader();
  const hash = createHash("sha256");
  let byteCount = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteCount += value.byteLength;
      if (byteCount > expectedBytes) throw new Error("intake_object_too_large");
      hash.update(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (byteCount !== expectedBytes) throw new Error("intake_object_size_mismatch");
  return Object.freeze({ sha256: hash.digest("hex"), byteCount });
}
