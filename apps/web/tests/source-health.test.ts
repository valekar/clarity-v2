import assert from "node:assert/strict";
import test from "node:test";
import {
  formatCapacity,
  parseSourceHealthResponse,
  requestSourceHealth,
  sourceHealthMessage,
} from "../src/app/staff/source-health.ts";

const baseItem = {
  sourceId: "source-1",
  sourceName: "Synthetic centre",
  status: "healthy",
  observedAt: "2026-09-24T10:00:00.000Z",
  lastSuccessfulSyncAt: "2026-09-24T09:59:00.000Z",
  lastErrorCode: null,
  queuedStudies: 1,
  queuedUploads: 2,
  spoolFreeBytes: 4 * 1024 ** 3,
  spoolCapacityBytes: 8 * 1024 ** 3,
  sourceReachable: true,
  cloudReachable: true,
};

test("parses bounded source status and labels healthy as last-reported reachability", () => {
  const result = parseSourceHealthResponse({ items: [baseItem], nextCursor: null });
  assert.ok(result);
  assert.equal(result.items.length, 1);
  assert.equal(
    sourceHealthMessage(result.items[0]!),
    "Source and cloud were reachable at the last report.",
  );
});

test("shows stale and unavailable health as unknown", () => {
  const stale = parseSourceHealthResponse({
    items: [
      {
        ...baseItem,
        status: "stale",
        observedAt: null,
        sourceReachable: null,
        cloudReachable: null,
      },
    ],
  });
  assert.ok(stale);
  assert.equal(
    sourceHealthMessage(stale.items[0]!),
    "No recent source report. Current source and cloud status is unknown.",
  );
});

test("distinguishes low local space and preserves a zero-byte reading", () => {
  const lowSpace = parseSourceHealthResponse({
    items: [{ ...baseItem, status: "attention", spoolFreeBytes: 0 }],
  });
  assert.ok(lowSpace);
  assert.equal(sourceHealthMessage(lowSpace.items[0]!), "Local storage is low: 0 MB free.");
  assert.equal(formatCapacity(1), "<1 MB");
  assert.equal(formatCapacity(2 * 1024 ** 3), "2.0 GB");
});

test("rejects invalid state, timestamp, capacity and unbounded source rows", () => {
  assert.equal(parseSourceHealthResponse({ items: [{ ...baseItem, status: "maybe" }] }), null);
  assert.equal(
    parseSourceHealthResponse({ items: [{ ...baseItem, observedAt: "not-a-date" }] }),
    null,
  );
  assert.equal(
    parseSourceHealthResponse({ items: [{ ...baseItem, spoolFreeBytes: 9 * 1024 ** 3 }] }),
    null,
  );
  assert.equal(
    parseSourceHealthResponse({ items: Array.from({ length: 101 }, () => baseItem) }),
    null,
  );
});

test("aborts a source-health request that does not settle within its bound", async () => {
  const hangingFetch: typeof fetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
        once: true,
      });
    });
  const request = requestSourceHealth(hangingFetch, new AbortController().signal, 5);
  const outcome = request.then(
    () => null,
    (error: unknown) => error,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  const error = await outcome;
  assert.ok(error instanceof DOMException);
  assert.equal(error.name, "AbortError");
});
