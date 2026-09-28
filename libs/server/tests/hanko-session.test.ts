import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import {
  createHankoSessionAdapter,
  type HankoSessionAdapterOptions,
} from "../src/auth/hanko-session.ts";
import { createStaffAccessGuard } from "../src/auth/require-staff-access.ts";

const issuer = "https://auth.synthetic.invalid";
const audience = "clarity-synthetic-web";
const subject = "e8e6af65-ec80-4ddb-af08-87dfb90dc0e8";
const sessionId = "c9717f5d-4f9f-4c57-a237-435d6ecc4581";
const futureExpiration = "2099-01-01T00:00:00.000Z";

function sessionResponse(overrides: Record<string, unknown> = {}) {
  const claims = {
    subject,
    session_id: sessionId,
    issuer,
    audience: [audience],
    expiration: futureExpiration,
    email: { address: "Staff@Example.Invalid", is_verified: true },
    ...overrides,
  };
  return { is_valid: true, claims };
}

function adapterOptions(apiOrigin: string, extras: Partial<HankoSessionAdapterOptions> = {}) {
  return { apiOrigin, issuer, audience, ...extras } satisfies HankoSessionAdapterOptions;
}

async function withServer<T>(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (origin: string) => Promise<T>,
): Promise<T> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function sendJson(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

test("forwards only the named cookie to the fixed passive validation endpoint", async () => {
  let receivedCookie: string | undefined;
  let receivedUrl: string | undefined;
  let receivedMethod: string | undefined;
  await withServer(
    (request, response) => {
      receivedCookie = request.headers.cookie;
      receivedUrl = request.url;
      receivedMethod = request.method;
      sendJson(response, sessionResponse());
    },
    async (apiOrigin) => {
      const adapter = createHankoSessionAdapter(adapterOptions(apiOrigin));
      const result = await adapter.validateCookie("theme=dark; hanko=opaque.token; other=ignored");
      assert.equal(result.ok, true);
      assert.equal(receivedMethod, "GET");
      assert.equal(receivedUrl, "/sessions/validate");
      assert.equal(receivedCookie, "hanko=opaque.token");
      if (result.ok) {
        assert.deepEqual(result.identity, {
          issuer,
          subject,
          sessionId,
          displayName: "staff@example.invalid",
          verifiedEmail: "staff@example.invalid",
          expiresAt: new Date(futureExpiration),
        });
      }
    },
  );
});

test("does not contact Hanko for absent, malformed or duplicate session cookies", async () => {
  let requests = 0;
  await withServer(
    (_request, response) => {
      requests += 1;
      sendJson(response, sessionResponse());
    },
    async (apiOrigin) => {
      const adapter = createHankoSessionAdapter(adapterOptions(apiOrigin));
      for (const cookie of [
        null,
        "theme=dark",
        "hanko=one; hanko=two",
        "hanko=bad\r\nInjected: yes",
      ]) {
        assert.deepEqual(await adapter.validateCookie(cookie), {
          ok: false,
          status: 401,
          reason: "unauthenticated",
        });
      }
      assert.equal(requests, 0);
    },
  );
});

test("uses the explicit origin with no-store and manual redirects", async () => {
  let calledUrl: string | URL | Request | undefined;
  let calledInit: (RequestInit & { cache?: "no-store" }) | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    calledUrl = input;
    calledInit = init as RequestInit & { cache?: "no-store" };
    return new Response(JSON.stringify(sessionResponse()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const adapter = createHankoSessionAdapter(
    adapterOptions("https://auth.synthetic.invalid", { fetcher }),
  );
  assert.equal((await adapter.validateCookie("hanko=opaque")).ok, true);
  assert.equal(String(calledUrl), "https://auth.synthetic.invalid/sessions/validate");
  assert.equal(calledInit?.method, "GET");
  assert.equal(calledInit?.cache, "no-store");
  assert.equal(calledInit?.redirect, "manual");
  assert.deepEqual(calledInit?.headers, {
    accept: "application/json",
    cookie: "hanko=opaque",
  });
  assert.ok(calledInit?.signal instanceof AbortSignal);
});

test("maps valid-shaped invalid or incorrectly scoped sessions to 401", async () => {
  const invalidBodies = [
    { is_valid: false, claims: {} },
    sessionResponse({ issuer: "https://wrong.synthetic.invalid" }),
    sessionResponse({ audience: ["other-client"] }),
    sessionResponse({ subject: "not-a-uuid" }),
    sessionResponse({ session_id: "00000000-0000-0000-0000-000000000000" }),
    sessionResponse({ expiration: "2000-01-01T00:00:00Z" }),
    sessionResponse({ email: { address: "staff@example.invalid", is_verified: false } }),
  ];
  for (const body of invalidBodies) {
    const adapter = createHankoSessionAdapter(
      adapterOptions("https://auth.synthetic.invalid", {
        fetcher: async () => new Response(JSON.stringify(body), { status: 200 }),
      }),
    );
    assert.deepEqual(await adapter.validateCookie("hanko=opaque"), {
      ok: false,
      status: 401,
      reason: "unauthenticated",
    });
  }
});

test("maps malformed successful provider DTOs to 503", async () => {
  const malformedBodies: unknown[] = [
    {},
    { is_valid: true },
    { is_valid: true, claims: null },
    sessionResponse({ audience: "clarity-synthetic-web" }),
    sessionResponse({ expiration: "not-rfc3339" }),
    sessionResponse({ expiration: "2099-02-30T00:00:00Z" }),
    sessionResponse({ email: { address: "no-email", is_verified: true } }),
    sessionResponse({ email: null }),
    { ...sessionResponse(), idle_expires_at: 42 },
    { ...sessionResponse(), idle_expires_at: "not-rfc3339" },
  ];
  for (const body of malformedBodies) {
    const adapter = createHankoSessionAdapter(
      adapterOptions("https://auth.synthetic.invalid", {
        fetcher: async () => new Response(JSON.stringify(body), { status: 200 }),
      }),
    );
    assert.deepEqual(await adapter.validateCookie("hanko=opaque"), {
      ok: false,
      status: 503,
      reason: "auth-unavailable",
    });
  }
});

test("accepts validated sessions with no email and uses a neutral stable display name", async () => {
  const claimsWithoutEmail = { ...sessionResponse().claims, email: undefined };
  const noEmailSession = {
    is_valid: true,
    claims: { ...claimsWithoutEmail, username: "unverified-user-display" },
  };
  const adapter = createHankoSessionAdapter(
    adapterOptions("https://auth.synthetic.invalid", {
      fetcher: async () => new Response(JSON.stringify(noEmailSession), { status: 200 }),
    }),
  );
  const result = await adapter.validateCookie("hanko=opaque");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.identity, {
      issuer,
      subject,
      sessionId,
      displayName: "Clarity staff member",
      expiresAt: new Date(futureExpiration),
    });
    assert.equal("verifiedEmail" in result.identity, false);
  }
});

test("denies unprovisioned no-email identity and accepts an explicitly linked subject", async () => {
  const claimsWithoutEmail = { ...sessionResponse().claims, email: undefined };
  const adapter = createHankoSessionAdapter(
    adapterOptions("https://auth.synthetic.invalid", {
      fetcher: async () =>
        new Response(
          JSON.stringify({
            is_valid: true,
            claims: { ...claimsWithoutEmail, username: "spoofed-display-name" },
          }),
          { status: 200 },
        ),
    }),
  );
  let approved = false;
  const repository = {
    async findCurrentByHankoIdentity(identity: { issuer: string; subject: string }) {
      assert.deepEqual(identity, { issuer, subject });
      return approved
        ? {
            staffUserId: "682a5f80-1afc-4da9-a3e2-35f00cf3de73",
            active: true,
            membership: { role: "staff" as const, status: "active" as const, version: "1" },
          }
        : null;
    },
  };
  const guard = createStaffAccessGuard({ sessionAdapter: adapter, repository });
  assert.deepEqual(await guard.requireStaffRead("hanko=opaque"), {
    ok: false,
    status: 403,
    reason: "forbidden",
  });
  approved = true;
  assert.deepEqual(await guard.requireStaffRead("hanko=opaque"), {
    ok: true,
    principal: { staffUserId: "682a5f80-1afc-4da9-a3e2-35f00cf3de73", role: "staff" },
  });
});

test("validates optional idle expiry as identity validity evidence", async () => {
  const expiredIdle = createHankoSessionAdapter(
    adapterOptions("https://auth.synthetic.invalid", {
      fetcher: async () =>
        new Response(
          JSON.stringify({
            ...sessionResponse(),
            idle_expires_at: "2000-01-01T00:00:00Z",
          }),
          { status: 200 },
        ),
    }),
  );
  assert.deepEqual(await expiredIdle.validateCookie("hanko=opaque"), {
    ok: false,
    status: 401,
    reason: "unauthenticated",
  });

  const futureIdle = createHankoSessionAdapter(
    adapterOptions("https://auth.synthetic.invalid", {
      fetcher: async () =>
        new Response(
          JSON.stringify({
            ...sessionResponse(),
            idle_expires_at: "2099-01-02T00:00:00Z",
          }),
          { status: 200 },
        ),
    }),
  );
  assert.equal((await futureIdle.validateCookie("hanko=opaque")).ok, true);
});

test("does not follow redirects and maps provider failures to 503", async () => {
  let redirectTargetRequests = 0;
  const redirectTarget = createServer((_request, response) => {
    redirectTargetRequests += 1;
    sendJson(response, sessionResponse());
  });
  await new Promise<void>((resolve, reject) => {
    redirectTarget.once("error", reject);
    redirectTarget.listen(0, "127.0.0.1", resolve);
  });
  const targetAddress = redirectTarget.address();
  assert.ok(targetAddress && typeof targetAddress !== "string");
  try {
    await withServer(
      (_request, response) => {
        response.writeHead(302, { location: `http://127.0.0.1:${targetAddress.port}/stolen` });
        response.end();
      },
      async (apiOrigin) => {
        const adapter = createHankoSessionAdapter(adapterOptions(apiOrigin));
        const result = await adapter.validateCookie("hanko=opaque");
        assert.equal(result.ok ? undefined : result.status, 503);
        assert.equal(redirectTargetRequests, 0);
      },
    );
  } finally {
    redirectTarget.closeAllConnections();
    await new Promise<void>((resolve) => redirectTarget.close(() => resolve()));
  }

  const outage = createHankoSessionAdapter(
    adapterOptions("https://auth.synthetic.invalid", {
      fetcher: async () => new Response("unavailable", { status: 503 }),
    }),
  );
  assert.deepEqual(await outage.validateCookie("hanko=opaque"), {
    ok: false,
    status: 503,
    reason: "auth-unavailable",
  });

  for (const status of [400, 401, 403]) {
    let canceled = false;
    const providerError = createHankoSessionAdapter(
      adapterOptions("https://auth.synthetic.invalid", {
        fetcher: async () =>
          new Response(
            new ReadableStream({
              cancel() {
                canceled = true;
              },
            }),
            { status },
          ),
      }),
    );
    assert.deepEqual(await providerError.validateCookie("hanko=opaque"), {
      ok: false,
      status: 503,
      reason: "auth-unavailable",
    });
    assert.equal(canceled, true);
  }
});

test("bounds response bytes and total HTTP request time", async () => {
  let oversizedStreamCanceled = false;
  const oversized = createHankoSessionAdapter(
    adapterOptions("https://auth.synthetic.invalid", {
      maxResponseBytes: 64,
      fetcher: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("x".repeat(100)));
            },
            cancel() {
              oversizedStreamCanceled = true;
            },
          }),
          { status: 200 },
        ),
    }),
  );
  const result = await oversized.validateCookie("hanko=opaque");
  assert.equal(result.ok ? undefined : result.status, 503);
  assert.equal(oversizedStreamCanceled, true);

  let declaredOversizedCanceled = false;
  const declaredOversized = createHankoSessionAdapter(
    adapterOptions("https://auth.synthetic.invalid", {
      maxResponseBytes: 64,
      fetcher: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              declaredOversizedCanceled = true;
            },
          }),
          {
            status: 200,
            headers: { "content-length": "128" },
          },
        ),
    }),
  );
  assert.equal((await declaredOversized.validateCookie("hanko=opaque")).ok, false);
  assert.equal(declaredOversizedCanceled, true);

  await withServer(
    () => {
      // Deliberately leave the response open to exercise the request deadline.
    },
    async (apiOrigin) => {
      const adapter = createHankoSessionAdapter(adapterOptions(apiOrigin, { timeoutMs: 25 }));
      assert.deepEqual(await adapter.validateCookie("hanko=opaque"), {
        ok: false,
        status: 503,
        reason: "auth-unavailable",
      });
    },
  );

  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      const interval = setInterval(() => response.write(" "), 8);
      response.on("close", () => clearInterval(interval));
    },
    async (apiOrigin) => {
      const adapter = createHankoSessionAdapter(adapterOptions(apiOrigin, { timeoutMs: 25 }));
      assert.deepEqual(await adapter.validateCookie("hanko=opaque"), {
        ok: false,
        status: 503,
        reason: "auth-unavailable",
      });
    },
  );
});

test("rejects non-HTTPS non-loopback origins and malformed adapter configuration", () => {
  assert.throws(
    () => createHankoSessionAdapter(adapterOptions("http://auth.example.invalid")),
    /HTTPS origin/,
  );
  assert.doesNotThrow(() =>
    createHankoSessionAdapter({
      apiOrigin: "http://hanko:8000",
      issuer,
      audience,
      internalHttpHostname: "hanko",
    }),
  );
  assert.throws(
    () =>
      createHankoSessionAdapter({
        apiOrigin: "http://another-service:8000",
        issuer,
        audience,
        internalHttpHostname: "hanko",
      }),
    /HTTPS origin/,
  );
  assert.throws(
    () =>
      createHankoSessionAdapter({
        apiOrigin: "https://auth.example.invalid/path",
        issuer,
        audience,
      }),
    /HTTPS origin/,
  );
  assert.throws(
    () =>
      createHankoSessionAdapter({
        apiOrigin: "https://auth.example.invalid",
        issuer: " ",
        audience,
      }),
    /issuer and audience/,
  );
});
