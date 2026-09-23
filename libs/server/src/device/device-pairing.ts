import { randomUUID } from "node:crypto";
import type {
  DeviceAdminRepository,
  DeviceAuthRepository,
} from "@clarity/database/device-repository";
import type { StaffAccessPrincipal } from "../auth/require-staff-access.js";
import {
  issueDeviceCredential,
  issuePairingSecret,
  verifierForSecret,
} from "./device-credential.js";

const PAIRING_SECRET = /^cp2_[A-Za-z0-9_-]{43}$/;
const PAIRING_LIFETIME_MS = 10 * 60_000;

export type PairingDelivery = Readonly<{
  pairingId: string;
  pairingSecret: string;
  expiresAt: Date;
}>;

export type PairingResult = Readonly<{
  deviceId: string;
  sourceId: string;
  authorization: string;
}>;

export type DevicePairingServiceOptions = Readonly<{
  adminRepository: Pick<DeviceAdminRepository, "createPairing">;
  deviceRepository: Pick<DeviceAuthRepository, "consumePairing">;
  now?: () => Date;
  newId?: () => string;
}>;

export class PairingRejectedError extends Error {
  constructor() {
    super("Pairing code expired or already used. Ask an administrator for a fresh code.");
    this.name = "PairingRejectedError";
  }
}

function isPairingRejected(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "42501";
}

export function createDevicePairingService(options: DevicePairingServiceOptions) {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;

  return Object.freeze({
    async createPairing(
      principal: StaffAccessPrincipal,
      sourceId: string,
    ): Promise<PairingDelivery> {
      if (principal.role !== "admin") throw new Error("Administrator access is required.");
      const issued = issuePairingSecret();
      const pairingId = newId();
      const expiresAt = new Date(now().getTime() + PAIRING_LIFETIME_MS);
      await options.adminRepository.createPairing({
        actorUserId: principal.staffUserId,
        sourceId,
        pairingId,
        verifier: issued.verifier,
        expiresAt,
      });
      // A one-time code may be shown to the administrator and entered over local IPC.
      // This is a pull flow; cloud does not call into the centre LAN.
      return Object.freeze({ pairingId, pairingSecret: issued.secret, expiresAt });
    },

    async pairLocalDevice(pairingSecret: string, displayName: string): Promise<PairingResult> {
      if (!PAIRING_SECRET.test(pairingSecret)) throw new TypeError("Pairing code is invalid.");
      const credential = issueDeviceCredential(newId());
      let paired: Readonly<{ deviceId: string; sourceId: string }>;
      try {
        paired = await options.deviceRepository.consumePairing({
          verifier: verifierForSecret(pairingSecret),
          deviceId: credential.deviceId,
          displayName,
          deviceVerifier: credential.verifier,
        });
      } catch (error) {
        if (isPairingRejected(error)) throw new PairingRejectedError();
        throw error;
      }
      // This is the one-time HTTPS response consumed by the device-initiated service.
      // Its caller stores the credential in the OS vault; it is not a renderer API DTO.
      return Object.freeze({ ...paired, authorization: credential.authorization });
    },
  });
}
