import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { createStaffPool, createStaffRepository } from "@clarity/database/staff-repository";
import { createHankoSessionAdapter } from "../src/auth/hanko-session.ts";
import { createStaffAccessGuard } from "../src/auth/require-staff-access.ts";

const issuer = "https://hanko.example.invalid";
const audience = "clarity-v2-proof";
const adminSubject = process.env.STAFF_PROOF_ADMIN_SUBJECT;
const staffSubject = process.env.STAFF_PROOF_STAFF_SUBJECT;
const connectionString = process.env.STAFF_PROOF_DATABASE_URL;
const uuid = (value: string | undefined, name: string): string => {
  assert.ok(value && /^[0-9a-f-]{36}$/i.test(value), `${name} fixture must be a UUID`);
  return value;
};

function sessionBody(subject: string, overrides: Record<string, unknown> = {}) {
  return {
    is_valid: true,
    claims: {
      subject,
      session_id: "c9717f5d-4f9f-4c57-a237-435d6ecc4581",
      issuer,
      audience: [audience],
      expiration: "2099-01-01T00:00:00.000Z",
      email: { address: "synthetic@example.invalid", is_verified: true },
      ...overrides,
    },
  };
}

function json(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

test("staff access guard with disposable PostgreSQL and synthetic Hanko HTTP", async (t) => {
  assert.ok(connectionString, "STAFF_PROOF_DATABASE_URL is required");
  const adminId = uuid(process.env.STAFF_PROOF_ADMIN_ID, "admin user");
  const staffId = uuid(process.env.STAFF_PROOF_STAFF_ID, "staff user");
  const adminHankoSubject = uuid(adminSubject, "admin Hanko subject");
  const staffHankoSubject = uuid(staffSubject, "staff Hanko subject");
  const pool = createStaffPool({ connectionString, maxConnections: 2 });
  const repository = createStaffRepository(pool);
  let mode = "valid";
  const http = createServer((_request: IncomingMessage, response) => {
    if (mode === "down") return json(response, { error: "unavailable" }, 503);
    if (mode === "malformed") return json(response, { is_valid: true, claims: {} });
    const subject =
      mode === "staff"
        ? staffHankoSubject
        : mode === "unknown"
          ? "e8e6af65-ec80-4ddb-af08-87dfb90dc0e8"
          : adminHankoSubject;
    if (mode === "revoked") return json(response, { is_valid: false });
    if (mode === "wrong-issuer")
      return json(response, sessionBody(subject, { issuer: "https://wrong.example.invalid" }));
    if (mode === "wrong-audience")
      return json(response, sessionBody(subject, { audience: ["wrong-audience"] }));
    return json(response, sessionBody(subject));
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", resolve);
  });
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  const adapter = createHankoSessionAdapter({
    apiOrigin: `http://127.0.0.1:${address.port}`,
    issuer,
    audience,
    timeoutMs: 500,
  });
  const guard = createStaffAccessGuard({ sessionAdapter: adapter, repository });

  try {
    await t.test(
      "current admin and staff decisions read active membership each request",
      async () => {
        mode = "valid";
        assert.deepEqual(await guard.requireStaffRead("hanko=admin"), {
          ok: true,
          principal: { staffUserId: adminId, role: "admin" },
        });
        assert.equal((await guard.requireStaffAdmin("hanko=admin")).ok, true);
        mode = "staff";
        assert.deepEqual(await guard.requireStaffRead("hanko=staff"), {
          ok: true,
          principal: { staffUserId: staffId, role: "staff" },
        });
        assert.deepEqual(await guard.requireStaffAdmin("hanko=staff"), {
          ok: false,
          status: 403,
          reason: "forbidden",
        });
      },
    );

    await t.test("staff directory paging is bounded and advances by stable ID", async () => {
      const first = await repository.listStaffUsers({ limit: 1 });
      assert.equal(first.entries.length, 1);
      assert.ok(first.nextCursor);
      const second = await repository.listStaffUsers({ limit: 1, afterId: first.nextCursor });
      assert.equal(second.entries.length, 1);
      assert.notEqual(second.entries[0]?.staffUserId, first.entries[0]?.staffUserId);
      await assert.rejects(() => repository.listStaffUsers({ limit: 101 }), /directory limit/);
    });

    await t.test("unprovisioned identity is denied without creating a staff row", async () => {
      mode = "unknown";
      assert.deepEqual(await guard.requireStaffRead("hanko=unknown"), {
        ok: false,
        status: 403,
        reason: "forbidden",
      });
      const pending = await repository.findCurrentByHankoIdentity({
        issuer,
        subject: "e8e6af65-ec80-4ddb-af08-87dfb90dc0e8",
      });
      assert.equal(pending, null);
    });

    await t.test("disabling membership is effective on the next request", async () => {
      const current = await repository.findCurrentByHankoIdentity({
        issuer,
        subject: staffHankoSubject,
      });
      assert.ok(current?.membership);
      assert.equal(
        await repository.changeMembership({
          actorUserId: adminId,
          targetUserId: staffId,
          expectedVersion: current.membership.version,
          role: "staff",
          status: "disabled",
        }),
        true,
      );
      mode = "staff";
      assert.deepEqual(await guard.requireStaffRead("hanko=staff"), {
        ok: false,
        status: 403,
        reason: "forbidden",
      });
    });

    await t.test("revoked, wrong issuer and wrong audience are unauthenticated", async () => {
      for (const failureMode of ["revoked", "wrong-issuer", "wrong-audience"]) {
        mode = failureMode;
        assert.deepEqual(await guard.requireStaffRead("hanko=invalid"), {
          ok: false,
          status: 401,
          reason: "unauthenticated",
        });
      }
    });

    await t.test("Hanko and PostgreSQL failures fail closed as unavailable", async () => {
      mode = "down";
      assert.deepEqual(await guard.requireStaffRead("hanko=down"), {
        ok: false,
        status: 503,
        reason: "unavailable",
      });
      mode = "malformed";
      assert.deepEqual(await guard.requireStaffRead("hanko=malformed"), {
        ok: false,
        status: 503,
        reason: "unavailable",
      });
      mode = "valid";
      const brokenRepository = createStaffRepository(
        createStaffPool({
          connectionString: connectionString.replace(/:\d+\//, ":1/"),
          connectionTimeoutMs: 250,
          queryTimeoutMs: 250,
        }),
      );
      try {
        const brokenGuard = createStaffAccessGuard({
          sessionAdapter: adapter,
          repository: brokenRepository,
        });
        assert.deepEqual(await brokenGuard.requireStaffRead("hanko=admin"), {
          ok: false,
          status: 503,
          reason: "unavailable",
        });
      } finally {
        await brokenRepository.close();
      }
    });
  } finally {
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await repository.close();
  }
});
