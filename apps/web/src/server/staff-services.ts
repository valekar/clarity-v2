import "server-only";
import { createStaffPool, createStaffRepository } from "@clarity/database/staff-repository";
import { createStaffStudyRepository } from "@clarity/database/study-repository";
import { createSourceHealthRepository } from "@clarity/database/source-health-repository";
import { createHankoSessionAdapter } from "@clarity/server/auth/hanko-session";
import { createStaffAccessGuard } from "@clarity/server/auth/require-staff-access";

let services:
  | Readonly<{
      guard: ReturnType<typeof createStaffAccessGuard>;
      repository: ReturnType<typeof createStaffRepository>;
      studyRepository: ReturnType<typeof createStaffStudyRepository>;
      sourceHealthRepository: ReturnType<typeof createSourceHealthRepository>;
    }>
  | undefined;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing server configuration: ${name}`);
  return value;
}

export function getStaffServices() {
  if (services) return services;
  const adapter = createHankoSessionAdapter({
    apiOrigin: process.env.HANKO_API_ORIGIN ?? requiredEnvironment("NEXT_PUBLIC_HANKO_API_URL"),
    issuer: requiredEnvironment("HANKO_ISSUER"),
    audience: requiredEnvironment("HANKO_AUDIENCE"),
    cookieName: process.env.HANKO_COOKIE_NAME ?? "hanko",
    // Only the Docker-private Hanko service name may use HTTP internally.
    internalHttpHostname: "hanko",
  });
  const pool = createStaffPool({ connectionString: requiredEnvironment("DATABASE_URL") });
  const repository = createStaffRepository(pool);
  const studyRepository = createStaffStudyRepository(pool);
  const sourceHealthRepository = createSourceHealthRepository(pool);
  services = Object.freeze({
    guard: createStaffAccessGuard({ sessionAdapter: adapter, repository }),
    repository,
    studyRepository,
    sourceHealthRepository,
  });
  return services;
}

export function publicOrigin(): string {
  const configured = requiredEnvironment("CLARITY_PUBLIC_ORIGIN");
  const url = new URL(configured);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.origin !== configured ||
    url.username ||
    url.password
  ) {
    throw new Error("CLARITY_PUBLIC_ORIGIN must be an HTTPS origin.");
  }
  return url.origin;
}
