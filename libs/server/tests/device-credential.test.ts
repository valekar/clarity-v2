import assert from "node:assert/strict";
import test from "node:test";
import {
  deviceSecretMatches,
  issueDeviceCredential,
  issuePairingSecret,
  parseDeviceAuthorization,
  verifyDeviceAuthorization,
} from "../src/device/device-credential.ts";
import {
  createDeviceAccessGuard,
  deviceAccessForSource,
} from "../dist/device/require-device-access.js";
import { createDevicePairingService, PairingRejectedError } from "../dist/device/device-pairing.js";

const SOURCE_ID = "5b2c204a-9970-409b-9065-72ea9a762c08";
const DEVICE_ID = "1495f83e-2e3f-41cd-82ec-88c5f30635d1";
const activeLease = (deviceId: string, verifier: Uint8Array) => ({
  deviceId,
  sourceId: SOURCE_ID,
  verifier,
  status: "paired" as const,
  version: "1",
  sourceStatus: "active" as const,
  leaseDeviceId: deviceId,
  fencingToken: "4",
  leaseExpiresAt: new Date("2026-09-23T10:00:00.000Z"),
  generation: "3",
});

test("issues an independent high-entropy device credential and verifier", () => {
  const credential = issueDeviceCredential("1495f83e-2e3f-41cd-82ec-88c5f30635d1");
  const parsed = parseDeviceAuthorization(credential.authorization);
  assert.equal(parsed?.deviceId, credential.deviceId);
  assert.equal(parsed && deviceSecretMatches(parsed.secret, credential.verifier), true);
  assert.equal(credential.verifier.byteLength, 32);
  assert.notEqual(credential.authorization, credential.verifier.toString("hex"));
});

test("does not treat a staff bearer token or cookie as device authorization", () => {
  const credential = issueDeviceCredential();
  assert.equal(parseDeviceAuthorization("Bearer staff-session-token"), null);
  assert.equal(parseDeviceAuthorization("hanko=session-cookie"), null);
  assert.equal(
    verifyDeviceAuthorization(
      "Bearer staff-session-token",
      credential.deviceId,
      credential.verifier,
    ),
    false,
  );
  assert.equal(
    verifyDeviceAuthorization("ClarityDevice invalid", credential.deviceId, credential.verifier),
    false,
  );
});

test("binds validation to the named installation and secret verifier", () => {
  const credential = issueDeviceCredential();
  assert.equal(
    verifyDeviceAuthorization(credential.authorization, credential.deviceId, credential.verifier),
    true,
  );
  assert.equal(
    verifyDeviceAuthorization(
      credential.authorization,
      "1495f83e-2e3f-41cd-82ec-88c5f30635d1",
      credential.verifier,
    ),
    false,
  );
  assert.equal(
    verifyDeviceAuthorization(credential.authorization, credential.deviceId, Buffer.alloc(32)),
    false,
  );
});

test("creates pairing secrets that are independent and stored only as verifiers", () => {
  const first = issuePairingSecret();
  const second = issuePairingSecret();
  assert.match(first.secret, /^cp2_[A-Za-z0-9_-]{43}$/);
  assert.equal(first.verifier.byteLength, 32);
  assert.notEqual(first.secret, second.secret);
  assert.equal(deviceSecretMatches(first.secret, first.verifier), true);
});

test("authenticates a paired installation and enforces its single source", async () => {
  const credential = issueDeviceCredential();
  const guard = createDeviceAccessGuard({
    findDeviceCredential: async () => ({
      ...activeLease(credential.deviceId, credential.verifier),
    }),
  });
  const access = await guard.authenticate(credential.authorization);
  assert.equal(access.ok, true);
  assert.equal(deviceAccessForSource(access, SOURCE_ID).ok, true);
  assert.deepEqual(deviceAccessForSource(access, "114da105-7bda-4681-bba0-e0ae52aac7d9"), {
    ok: false,
    status: 403,
    reason: "forbidden",
  });
});

test("revoked installations fail closed and repository outages are unavailable", async () => {
  const credential = issueDeviceCredential();
  const revoked = createDeviceAccessGuard({
    findDeviceCredential: async () => ({
      ...activeLease(credential.deviceId, credential.verifier),
      status: "revoked",
    }),
  });
  assert.deepEqual(await revoked.authenticate(credential.authorization), {
    ok: false,
    status: 401,
    reason: "unauthenticated",
  });
  const unavailable = createDeviceAccessGuard({
    findDeviceCredential: async () => {
      throw new Error();
    },
  });
  assert.deepEqual(await unavailable.authenticate(credential.authorization), {
    ok: false,
    status: 503,
    reason: "unavailable",
  });
});

test("rechecks device status, source generation, lease owner and fence on every mutation", async () => {
  const credential = issueDeviceCredential(DEVICE_ID);
  const record = activeLease(credential.deviceId, credential.verifier);
  const guard = createDeviceAccessGuard({ findDeviceCredential: async () => record });
  const fence = {
    sourceId: SOURCE_ID,
    sourceGeneration: "3",
    fencingToken: "4",
    now: new Date("2026-09-23T09:00:00Z"),
  };
  assert.deepEqual(await guard.authorizeMutation(credential.authorization, fence), {
    ok: true,
    deviceId: credential.deviceId,
    sourceId: SOURCE_ID,
    fencingToken: "4",
    generation: "3",
  });
  assert.deepEqual(await guard.authorizeMutation("hanko=session", fence), {
    ok: false,
    status: 401,
    reason: "unauthenticated",
  });
  const stale = createDeviceAccessGuard({
    findDeviceCredential: async () => ({ ...record, fencingToken: "5" }),
  });
  assert.deepEqual(await stale.authorizeMutation(credential.authorization, fence), {
    ok: false,
    status: 403,
    reason: "forbidden",
  });
  const reset = createDeviceAccessGuard({
    findDeviceCredential: async () => ({ ...record, generation: "4" }),
  });
  assert.deepEqual(await reset.authorizeMutation(credential.authorization, fence), {
    ok: false,
    status: 403,
    reason: "forbidden",
  });
});

test("pairing issues a one-time admin code and a device-only credential response", async () => {
  let storedVerifier: Uint8Array | undefined;
  let idCounter = 0;
  const service = createDevicePairingService({
    now: () => new Date("2026-09-23T09:00:00.000Z"),
    newId: () =>
      ++idCounter === 1
        ? "1495f83e-2e3f-41cd-82ec-88c5f30635d1"
        : "2495f83e-2e3f-41cd-82ec-88c5f30635d1",
    adminRepository: {
      createPairing: async (input) => {
        storedVerifier = input.verifier;
        return input.pairingId;
      },
    },
    deviceRepository: {
      consumePairing: async (input) => {
        assert.deepEqual(input.verifier, storedVerifier);
        assert.equal(input.deviceVerifier.byteLength, 32);
        return { deviceId: input.deviceId, sourceId: SOURCE_ID };
      },
    },
  });
  const created = await service.createPairing(
    { staffUserId: "a495f83e-2e3f-41cd-82ec-88c5f30635d1", role: "admin" },
    SOURCE_ID,
  );
  assert.match(created.pairingSecret, /^cp2_[A-Za-z0-9_-]{43}$/);
  const paired = await service.pairLocalDevice(created.pairingSecret, "Synthetic sync service");
  assert.deepEqual(Object.keys(paired).sort(), ["authorization", "deviceId", "sourceId"]);
  assert.equal(paired.deviceId, "2495f83e-2e3f-41cd-82ec-88c5f30635d1");
  assert.equal(paired.sourceId, SOURCE_ID);
  assert.match(paired.authorization, /^ClarityDevice /);
});

test("a lost pairing response cannot replay a consumed code or recover its credential", async () => {
  let consumed = false;
  let idCounter = 0;
  const issued = issuePairingSecret();
  const service = createDevicePairingService({
    newId: () => (++idCounter === 1 ? DEVICE_ID : "2495f83e-2e3f-41cd-82ec-88c5f30635d1"),
    adminRepository: { createPairing: async () => DEVICE_ID },
    deviceRepository: {
      consumePairing: async (input) => {
        assert.deepEqual(input.verifier, issued.verifier);
        if (consumed) throw Object.assign(new Error("denied"), { code: "42501" });
        consumed = true;
        return { deviceId: input.deviceId, sourceId: SOURCE_ID };
      },
    },
  });
  const first = await service.pairLocalDevice(issued.secret, "Synthetic service");
  assert.match(first.authorization, /^ClarityDevice /);
  await assert.rejects(
    service.pairLocalDevice(issued.secret, "Synthetic service"),
    (error: unknown) =>
      error instanceof PairingRejectedError && !error.message.includes(issued.secret),
  );
});
