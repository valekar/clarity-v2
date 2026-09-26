import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertSameOrthancIdentity,
  basicAuthorization,
  getSourceSettings,
  normalizeOrthancUrl,
  testOrthanc,
} from "../src/source-settings.ts";

test("Orthanc URL permits HTTPS or explicit loopback HTTP only", () => {
  assert.equal(
    normalizeOrthancUrl("https://orthanc.example.test/", false),
    "https://orthanc.example.test",
  );
  assert.equal(normalizeOrthancUrl("http://127.0.0.1:8042/", true), "http://127.0.0.1:8042");
  assert.throws(() => normalizeOrthancUrl("http://orthanc.example.test", true), /HTTPS/);
  assert.throws(() => normalizeOrthancUrl("https://user:secret@orthanc.example.test", false));
});

test("unchanged source identity keeps the local credential private and rejects silent rebinding", () => {
  const authorization = basicAuthorization("user", "secret", undefined, false);
  assert.equal(authorization, `Basic ${Buffer.from("user:secret").toString("base64")}`);
  assert.equal(basicAuthorization("renamed-user", "", authorization, true), authorization);
  assertSameOrthancIdentity("http://127.0.0.1:8042", "http://127.0.0.1:8042");
  assert.throws(
    () => assertSameOrthancIdentity("http://127.0.0.1:8042", "http://127.0.0.1:8043"),
    /new source pairing/,
  );
  assert.equal(
    JSON.stringify({
      configured: true,
      orthancUrl: "http://127.0.0.1:8042",
      pollIntervalMinutes: 5,
    }).includes(authorization),
    false,
  );
});

test("connection test requires a bounded Orthanc /system response", async () => {
  let captured: Request | undefined;
  const result = await testOrthanc("http://127.0.0.1:8042", "Basic abc", async (input, init) => {
    captured = new Request(input, init);
    return Response.json({
      Name: "Local clinic source",
      Version: "1.12.0",
      DicomAet: "ORTHANC",
      ApiVersion: 30,
      HttpPort: 8042,
    });
  });
  assert.equal(result, true);
  assert.equal(captured?.url, "http://127.0.0.1:8042/system");
  assert.equal(captured?.headers.get("authorization"), "Basic abc");
  assert.equal(captured?.redirect, "manual");
  assert.equal(
    await testOrthanc("http://127.0.0.1:8042", "Basic abc", async () =>
      Response.json({ Name: "other service", Version: "1" }),
    ),
    false,
  );
  assert.equal(
    await testOrthanc("http://127.0.0.1:8042", "Basic abc", async () =>
      Response.json(
        { Name: "Orthanc", Version: "1", DicomAet: "ORTHANC", ApiVersion: 30, HttpPort: 8042 },
        { status: 302 },
      ),
    ),
    false,
  );
});

test("settings read returns only public connection state, never saved authorization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clarity-desktop-source-"));
  const path = join(directory, "config.json");
  const authorization = "Basic c2VjcmV0OnZhbHVl";
  try {
    await writeFile(
      path,
      JSON.stringify({
        CLARITY_SYNC_SOURCE_KEY: "source-id",
        CLARITY_SYNC_STATE_DB: "/private/state.db",
        CLARITY_SYNC_SPOOL_DIR: "/private/spool",
        CLARITY_ORTHANC_URL: "http://127.0.0.1:8042",
        CLARITY_ORTHANC_AUTHORIZATION: authorization,
        CLARITY_INGESTION_API_URL: "http://127.0.0.1:3000",
        CLARITY_DEVICE_AUTHORIZATION: "device-secret",
        CLARITY_SYNC_ALLOW_INSECURE_LOCALHOST: "1",
        CLARITY_SYNC_POLL_INTERVAL_MINUTES: "10",
        CLARITY_SYNC_SYNTHETIC_POLL_INTERVAL_SECONDS: "5",
      }),
      { mode: 0o600 },
    );
    const settings = await getSourceSettings(path);
    assert.deepEqual(settings, {
      configured: true,
      orthancUrl: "http://127.0.0.1:8042",
      pollIntervalMinutes: 10,
      syntheticFastPolling: true,
    });
    assert.equal(JSON.stringify(settings).includes(authorization), false);
    assert.equal(JSON.stringify(settings).includes("device-secret"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
