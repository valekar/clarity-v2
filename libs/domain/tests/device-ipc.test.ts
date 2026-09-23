import assert from "node:assert/strict";
import test from "node:test";
import {
  checkDeviceLease,
  isTrustedDeviceIpcSender,
  parseDeviceAdminIpcRequest,
} from "../src/index.ts";

test("accepts only the named device administration operations and exact fields", () => {
  assert.deepEqual(parseDeviceAdminIpcRequest({ operation: "readSyncStatus" }), {
    operation: "readSyncStatus",
  });
  assert.deepEqual(
    parseDeviceAdminIpcRequest({
      operation: "createPairing",
      sourceId: "5b2c204a-9970-409b-9065-72ea9a762c08",
    }),
    {
      operation: "createPairing",
      sourceId: "5b2c204a-9970-409b-9065-72ea9a762c08",
    },
  );
  assert.deepEqual(
    parseDeviceAdminIpcRequest({
      operation: "revokeDevice",
      deviceId: "1495f83e-2e3f-41cd-82ec-88c5f30635d1",
      expectedVersion: "2",
    }),
    {
      operation: "revokeDevice",
      deviceId: "1495f83e-2e3f-41cd-82ec-88c5f30635d1",
      expectedVersion: "2",
    },
  );
});

test("rejects generic effects, secrets, arbitrary paths and invalid versions", () => {
  for (const input of [
    { operation: "fetch", url: "https://attacker.invalid" },
    { operation: "readSyncStatus", path: "/etc/passwd" },
    { operation: "createPairing", sourceId: "not-a-uuid" },
    {
      operation: "revokeDevice",
      deviceId: "1495f83e-2e3f-41cd-82ec-88c5f30635d1",
      expectedVersion: "0",
    },
    {
      operation: "revokeDevice",
      deviceId: "1495f83e-2e3f-41cd-82ec-88c5f30635d1",
      expectedVersion: "1",
      role: "admin",
    },
    {
      operation: "createPairing",
      sourceId: "5b2c204a-9970-409b-9065-72ea9a762c08",
      displayName: "Host",
      pairingSecret: "do-not-expose",
    },
  ]) {
    assert.equal(parseDeviceAdminIpcRequest(input), null);
  }
});

test("accepts only the trusted dashboard main frame as an IPC sender", () => {
  const origin = "https://staff.example.test";
  assert.equal(
    isTrustedDeviceIpcSender("https://staff.example.test/staff/settings", origin, true),
    true,
  );
  assert.equal(isTrustedDeviceIpcSender("https://attacker.example.test/", origin, true), false);
  assert.equal(isTrustedDeviceIpcSender("https://staff.example.test/", origin, false), false);
  assert.equal(isTrustedDeviceIpcSender("file:///tmp/index.html", origin, true), false);
  assert.equal(
    isTrustedDeviceIpcSender(
      "https://staff.example.test/",
      "https://operator:secret@staff.example.test",
      true,
    ),
    false,
  );
});

test("requires current paired source lease and fencing token for device mutations", () => {
  const proof = {
    sourceId: "5b2c204a-9970-409b-9065-72ea9a762c08",
    deviceId: "1495f83e-2e3f-41cd-82ec-88c5f30635d1",
    deviceSourceId: "5b2c204a-9970-409b-9065-72ea9a762c08",
    deviceStatus: "paired" as const,
    sourceStatus: "active" as const,
    leaseDeviceId: "1495f83e-2e3f-41cd-82ec-88c5f30635d1",
    fencingToken: "4",
    currentFencingToken: "4",
    leaseExpiresAt: new Date("2026-09-23T10:00:00.000Z"),
    now: new Date("2026-09-23T09:00:00.000Z"),
  };
  assert.deepEqual(checkDeviceLease(proof), { allowed: true });
  assert.deepEqual(checkDeviceLease({ ...proof, deviceStatus: "revoked" }), {
    allowed: false,
    reason: "device-revoked",
  });
  assert.deepEqual(checkDeviceLease({ ...proof, fencingToken: "3" }), {
    allowed: false,
    reason: "stale-fence",
  });
  assert.deepEqual(checkDeviceLease({ ...proof, leaseExpiresAt: proof.now }), {
    allowed: false,
    reason: "lease-expired",
  });
});
