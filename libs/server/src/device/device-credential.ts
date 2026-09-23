import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const AUTH_SCHEME = "ClarityDevice";
const SECRET_BYTES = 32;

export type IssuedDeviceCredential = Readonly<{
  deviceId: string;
  authorization: string;
  verifier: Buffer;
}>;

export type ParsedDeviceAuthorization = Readonly<{
  deviceId: string;
  secret: string;
}>;

export function issueDeviceCredential(deviceId: string = randomUUID()): IssuedDeviceCredential {
  if (!UUID.test(deviceId)) throw new TypeError("Device ID must be a UUID.");
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const authorization = `${AUTH_SCHEME} ${deviceId}.${secret}`;
  return Object.freeze({
    deviceId: deviceId.toLowerCase(),
    authorization,
    verifier: verifierForSecret(secret),
  });
}

export function issuePairingSecret(): Readonly<{ secret: string; verifier: Buffer }> {
  const secret = `cp2_${randomBytes(SECRET_BYTES).toString("base64url")}`;
  return Object.freeze({ secret, verifier: verifierForSecret(secret) });
}

export function parseDeviceAuthorization(
  value: string | null | undefined,
): ParsedDeviceAuthorization | null {
  if (typeof value !== "string" || value.length > 256 || /[\r\n,]/.test(value)) return null;
  const match = /^ClarityDevice ([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match?.[1] || !match[2] || !UUID.test(match[1]) || !SECRET.test(match[2])) return null;
  return Object.freeze({ deviceId: match[1].toLowerCase(), secret: match[2] });
}

export function verifierForSecret(secret: string): Buffer {
  if (secret.length > 128 || !/^(?:cp2_)?[A-Za-z0-9_-]{43}$/.test(secret)) {
    throw new TypeError("Device or pairing secret is malformed.");
  }
  return createHash("sha256").update(secret, "ascii").digest();
}

export function deviceSecretMatches(secret: string, storedVerifier: Uint8Array): boolean {
  if (storedVerifier.byteLength !== 32) return false;
  let candidate: Buffer;
  try {
    candidate = verifierForSecret(secret);
  } catch {
    return false;
  }
  return timingSafeEqual(candidate, Buffer.from(storedVerifier));
}

export function verifyDeviceAuthorization(
  header: string | null | undefined,
  expectedDeviceId: string,
  storedVerifier: Uint8Array,
): boolean {
  const parsed = parseDeviceAuthorization(header);
  return (
    parsed !== null &&
    parsed.deviceId === expectedDeviceId.toLowerCase() &&
    deviceSecretMatches(parsed.secret, storedVerifier)
  );
}
