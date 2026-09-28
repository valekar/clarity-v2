import type { StaffRepository } from "@clarity/database/staff-repository";
import type { HankoIdentity, HankoSessionResult } from "./hanko-session.js";

export type StaffAccessPrincipal = Readonly<{
  staffUserId: string;
  role: "admin" | "staff";
}>;

export type StaffAccessResult =
  | Readonly<{ ok: true; principal: StaffAccessPrincipal }>
  | Readonly<{
      ok: false;
      status: 401 | 403 | 503;
      reason: "unauthenticated" | "forbidden" | "unavailable";
    }>;

export type StaffAccessGuardOptions = Readonly<{
  sessionAdapter: Readonly<{
    validateCookie(cookieHeader: string | null | undefined): Promise<HankoSessionResult>;
  }>;
  repository: Pick<StaffRepository, "findCurrentByHankoIdentity">;
}>;

const unauthenticated: StaffAccessResult = Object.freeze({
  ok: false,
  status: 401,
  reason: "unauthenticated",
});
const forbidden: StaffAccessResult = Object.freeze({ ok: false, status: 403, reason: "forbidden" });
const unavailable: StaffAccessResult = Object.freeze({
  ok: false,
  status: 503,
  reason: "unavailable",
});

function identityForLookup(identity: HankoIdentity) {
  return Object.freeze({ issuer: identity.issuer, subject: identity.subject });
}

export function createStaffAccessGuard(options: StaffAccessGuardOptions) {
  async function identify(
    cookieHeader: string | null | undefined,
  ): Promise<
    | Readonly<{ ok: true; principal: StaffAccessPrincipal }>
    | Exclude<StaffAccessResult, { ok: true }>
  > {
    let session: HankoSessionResult;
    try {
      session = await options.sessionAdapter.validateCookie(cookieHeader);
    } catch {
      return unavailable;
    }
    if (!session.ok) return session.status === 401 ? unauthenticated : unavailable;

    try {
      const identity = identityForLookup(session.identity);
      const current = await options.repository.findCurrentByHankoIdentity(identity);
      if (!current) return forbidden;
      if (!current.active || current.membership?.status !== "active") return forbidden;
      if (!current.membership) return forbidden;
      return {
        ok: true,
        principal: Object.freeze({
          staffUserId: current.staffUserId,
          role: current.membership.role,
        }),
      };
    } catch {
      return unavailable;
    }
  }

  return Object.freeze({
    async requireStaffRead(cookieHeader: string | null | undefined): Promise<StaffAccessResult> {
      const result = await identify(cookieHeader);
      return result.ok ? result : result;
    },
    async requireStaffAdmin(cookieHeader: string | null | undefined): Promise<StaffAccessResult> {
      const result = await identify(cookieHeader);
      if (!result.ok) return result;
      return result.principal.role === "admin" ? result : forbidden;
    },
  });
}
