import assert from "node:assert/strict";
import test from "node:test";
import { createDeviceAdminBridge } from "../src/device-admin-bridge.ts";

const dashboard = "https://staff.example.test";
const trustedFrame = `${dashboard}/staff/settings`;
const sourceId = "5b2c204a-9970-409b-9065-72ea9a762c08";

test("device admin IPC rejects untrusted frames and keeps local status explicitly unavailable", async () => {
  const calls: Request[] = [];
  const bridge = createDeviceAdminBridge({
    dashboardOrigin: dashboard,
    cookieName: "hanko",
    async getHankoCookie() {
      return "provider-session";
    },
    async fetcher(input, init) {
      calls.push(new Request(input, init));
      return Response.json({});
    },
  });
  assert.deepEqual(
    await bridge.invoke("https://attacker.invalid/", true, { operation: "readSyncStatus" }),
    {
      ok: false,
      error: "forbidden",
    },
  );
  assert.deepEqual(await bridge.invoke(trustedFrame, true, { operation: "readSyncStatus" }), {
    ok: true,
    status: "unavailable",
  });
  assert.equal(calls.length, 0);
});

test("pairing IPC forwards only the fixed admin request with the HttpOnly session cookie", async () => {
  let captured: Request | undefined;
  const bridge = createDeviceAdminBridge({
    dashboardOrigin: dashboard,
    cookieName: "clarity_session",
    async getHankoCookie() {
      return "session-value";
    },
    async fetcher(input, init) {
      captured = new Request(input, init);
      return Response.json(
        {
          pairingId: "2495f83e-2e3f-41cd-82ec-88c5f30635d1",
          pairingCode: "one-time-code",
          expiresAt: "2026-09-23T12:00:00.000Z",
        },
        { status: 201 },
      );
    },
  });
  const result = await bridge.invoke(trustedFrame, true, { operation: "createPairing", sourceId });
  assert.deepEqual(result, {
    ok: true,
    pairingId: "2495f83e-2e3f-41cd-82ec-88c5f30635d1",
    pairingCode: "one-time-code",
    expiresAt: "2026-09-23T12:00:00.000Z",
  });
  assert.ok(captured);
  assert.equal(captured.url, `${dashboard}/api/device-admin/pairings`);
  assert.equal(captured.headers.get("cookie"), "clarity_session=session-value");
  assert.equal(captured.headers.get("origin"), dashboard);
  assert.deepEqual(await captured.json(), { sourceId });
  assert.equal(captured.redirect, "manual");
});

test("revoke is a fixed operation and HTTP failures do not expose response details", async () => {
  let captured: Request | undefined;
  const bridge = createDeviceAdminBridge({
    dashboardOrigin: dashboard,
    cookieName: "hanko",
    async getHankoCookie() {
      return "session-value";
    },
    async fetcher(input, init) {
      captured = new Request(input, init);
      return Response.json({ error: "conflict details must not cross IPC" }, { status: 409 });
    },
  });
  assert.deepEqual(
    await bridge.invoke(trustedFrame, true, {
      operation: "revokeDevice",
      deviceId: "1495f83e-2e3f-41cd-82ec-88c5f30635d1",
      expectedVersion: "3",
    }),
    { ok: false, error: "conflict" },
  );
  assert.ok(captured);
  assert.equal(captured.url, `${dashboard}/api/device-admin/revoke`);
  assert.deepEqual(await captured.json(), {
    deviceId: "1495f83e-2e3f-41cd-82ec-88c5f30635d1",
    expectedVersion: "3",
  });
});
