import assert from "node:assert/strict";
import test from "node:test";
import { createDeviceHttpApi } from "../dist/device/device-http-api.js";

const sourceId = "5b2c204a-9970-409b-9065-72ea9a762c08";
const adminId = "a495f83e-2e3f-41cd-82ec-88c5f30635d1";

function createApi() {
  const calls: string[] = [];
  const api = createDeviceHttpApi({
    dashboardOrigin: "https://staff.example.test",
    staff: {
      async requireStaffAdmin(cookie) {
        calls.push(`staff:${cookie ?? "none"}`);
        return cookie === "hanko=valid"
          ? { ok: true, principal: { staffUserId: adminId, role: "admin" } }
          : { ok: false, status: 401, reason: "unauthenticated" };
      },
    },
    adminRepository: {
      async createPairing(input) {
        calls.push(`create:${input.actorUserId}:${input.sourceId}`);
        return input.pairingId;
      },
      async revokeDevice(input) {
        calls.push(`revoke:${input.actorUserId}:${input.deviceId}:${input.expectedVersion}`);
        return true;
      },
    },
    deviceRepository: {
      async consumePairing(input) {
        calls.push("consume");
        return { deviceId: input.deviceId, sourceId };
      },
    },
    now: () => new Date("2026-09-23T09:00:00.000Z"),
  });
  return { api, calls };
}

function jsonRequest(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://staff.example.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("admin pairing requires same-origin staff authorization and returns only a short-lived code", async () => {
  const { api, calls } = createApi();
  const denied = await api.handle(
    jsonRequest(
      "/api/device-admin/pairings",
      { sourceId },
      { origin: "https://attacker.example.test", cookie: "hanko=valid" },
    ),
  );
  assert.equal(denied.status, 403);
  const unauthorized = await api.handle(
    jsonRequest(
      "/api/device-admin/pairings",
      { sourceId },
      { origin: "https://staff.example.test" },
    ),
  );
  assert.equal(unauthorized.status, 401);
  const created = await api.handle(
    jsonRequest(
      "/api/device-admin/pairings",
      { sourceId },
      { origin: "https://staff.example.test", cookie: "hanko=valid" },
    ),
  );
  assert.equal(created.status, 201);
  assert.match(created.headers.get("cache-control") ?? "", /no-store/);
  const value = (await created.json()) as Record<string, unknown>;
  assert.match(String(value.pairingCode), /^cp2_[A-Za-z0-9_-]{43}$/);
  assert.equal("authorization" in value, false);
  assert.equal(calls.filter((call) => call.startsWith("create:")).length, 1);
});

test("device-initiated pairing rejects staff cookies and returns credentials once over its own route", async () => {
  const { api, calls } = createApi();
  const cookieOnly = await api.handle(
    jsonRequest(
      "/api/device/pair",
      { pairingCode: `cp2_${"a".repeat(43)}`, displayName: "Synthetic" },
      { cookie: "hanko=valid" },
    ),
  );
  assert.equal(cookieOnly.status, 401);
  const paired = await api.handle(
    jsonRequest("/api/device/pair", {
      pairingCode: `cp2_${"a".repeat(43)}`,
      displayName: "Synthetic service",
    }),
  );
  assert.equal(paired.status, 201);
  assert.match(
    String(((await paired.json()) as { authorization: string }).authorization),
    /^ClarityDevice /,
  );
  assert.deepEqual(
    calls.filter((call) => call === "consume"),
    ["consume"],
  );
});

test("device Authorization cannot administer, and staff cookies cannot pair a device", async () => {
  const { api, calls } = createApi();
  const adminAttempt = await api.handle(
    jsonRequest(
      "/api/device-admin/pairings",
      { sourceId },
      {
        origin: "https://staff.example.test",
        authorization:
          "ClarityDevice 1495f83e-2e3f-41cd-82ec-88c5f30635d1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    ),
  );
  assert.equal(adminAttempt.status, 401);
  const staffPair = await api.handle(
    jsonRequest(
      "/api/device/pair",
      { pairingCode: `cp2_${"a".repeat(43)}`, displayName: "Synthetic service" },
      { cookie: "hanko=valid" },
    ),
  );
  assert.equal(staffPair.status, 401);
  assert.equal(calls.filter((call) => call === "consume").length, 0);
});

test("pair route rejects malformed/oversized requests", async () => {
  const { api } = createApi();
  const mismatch = await api.handle(
    jsonRequest("/api/device/pair", {
      pairingCode: "not-a-pairing-code",
      displayName: "Synthetic",
    }),
  );
  assert.equal(mismatch.status, 400);
  const oversized = new Request("https://staff.example.test/api/device/pair", {
    method: "POST",
    headers: { "content-length": "9000" },
    body: "{}",
  });
  assert.equal((await api.handle(oversized)).status, 400);
});
