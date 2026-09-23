import assert from "node:assert/strict";
import test from "node:test";
import { OrthancClient } from "../src/orthanc-client.js";

test("aborts a stalled Orthanc request at its configured deadline", async () => {
  const stalledFetch: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  const client = new OrthancClient(
    new URL("http://orthanc.invalid/"),
    "worker",
    "secret",
    stalledFetch,
    5,
  );
  const keepAlive = setTimeout(() => undefined, 25);
  try {
    await assert.rejects(client.findBySopInstanceUid("1.2.3"), { name: "TimeoutError" });
  } finally {
    clearTimeout(keepAlive);
  }
});

test("rejects and cancels oversized Orthanc metadata responses", async () => {
  let canceled = false;
  const fetcher: typeof fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(70_000));
        },
        cancel() {
          canceled = true;
        },
      }),
      { headers: { "content-length": "70000" } },
    );
  const client = new OrthancClient(
    new URL("http://orthanc.invalid/"),
    "worker",
    "secret",
    fetcher,
    1000,
  );
  await assert.rejects(
    client.findBySopInstanceUid("1.2.3"),
    /metadata response exceeded its limit/,
  );
  assert.equal(canceled, true);
});
