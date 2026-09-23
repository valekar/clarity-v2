export type HankoIdentity = Readonly<{
  issuer: string;
  subject: string;
  sessionId: string;
  verifiedEmail: string;
  expiresAt: Date;
}>;

export type HankoSessionResult =
  | Readonly<{ ok: true; identity: HankoIdentity }>
  | Readonly<{ ok: false; status: 401; reason: "unauthenticated" }>
  | Readonly<{ ok: false; status: 503; reason: "auth-unavailable" }>;

export type HankoSessionAdapterOptions = Readonly<{
  apiOrigin: string;
  issuer: string;
  audience: string;
  cookieName?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetcher?: typeof fetch;
  internalHttpHostname?: string;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COOKIE_OCTETS = /^[!#$%&'()*+\-.0-9:<=>?@A-Z\[\]^_`a-z{|}~]+$/i;
const DEFAULT_COOKIE_NAME = "hanko";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024;
const MAX_COOKIE_HEADER_BYTES = 8 * 1024;

function isValidTimestamp(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) return false;
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    ,
    ,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (daysInMonth ?? 0) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

const unauthenticated = (): HankoSessionResult => ({
  ok: false,
  status: 401,
  reason: "unauthenticated",
});

const unavailable = (): HankoSessionResult => ({
  ok: false,
  status: 503,
  reason: "auth-unavailable",
});

function validateOptions(options: HankoSessionAdapterOptions): URL {
  if (!options.issuer.trim() || !options.audience.trim())
    throw new TypeError("Hanko issuer and audience must be configured.");
  const url = new URL(options.apiOrigin);
  const isLoopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  const isExplicitInternalHost =
    options.internalHttpHostname !== undefined &&
    /^[a-z][a-z0-9-]{0,62}$/.test(options.internalHttpHostname) &&
    url.hostname === options.internalHttpHostname;
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && (isLoopback || isExplicitInternalHost))) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(
      "Hanko API origin must be an HTTPS origin (HTTP requires loopback or the explicit internal host).",
    );
  }
  const cookieName = options.cookieName ?? DEFAULT_COOKIE_NAME;
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookieName))
    throw new TypeError("Hanko cookie name is invalid.");
  if (
    !Number.isSafeInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) ||
    (options.timeoutMs ?? DEFAULT_TIMEOUT_MS) < 1
  )
    throw new TypeError("Hanko request timeout must be a positive safe integer.");
  if (
    !Number.isSafeInteger(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES) ||
    (options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES) < 1
  )
    throw new TypeError("Hanko response byte limit must be a positive safe integer.");
  return url;
}

function namedCookieValue(header: string | null | undefined, name: string): string | undefined {
  if (
    !header ||
    new TextEncoder().encode(header).byteLength > MAX_COOKIE_HEADER_BYTES ||
    /[\r\n]/.test(header)
  )
    return undefined;
  let found: string | undefined;
  for (const rawPart of header.split(";")) {
    const part = rawPart.trim();
    const equals = part.indexOf("=");
    if (equals < 1) continue;
    if (part.slice(0, equals).trim() !== name) continue;
    if (found !== undefined) return undefined;
    const value = part.slice(equals + 1).trim();
    if (!value || !COOKIE_OCTETS.test(value)) return undefined;
    found = value;
  }
  return found;
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > maximumBytes
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new RangeError("Hanko validation response is too large.");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        throw new RangeError("Hanko validation response is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

type SessionParseResult =
  | Readonly<{ kind: "valid"; identity: HankoIdentity }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "malformed" }>;

function parseSession(
  body: unknown,
  issuer: string,
  audience: string,
  now: Date,
): SessionParseResult {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return { kind: "malformed" };
  const validation = body as Record<string, unknown>;
  if (validation.is_valid === false) return { kind: "invalid" };
  if (validation.is_valid !== true) return { kind: "malformed" };
  const claims = validation.claims;
  if (typeof claims !== "object" || claims === null || Array.isArray(claims))
    return { kind: "malformed" };
  const values = claims as Record<string, unknown>;
  const subject = values.subject;
  const sessionId = values.session_id;
  const tokenIssuer = values.issuer;
  const tokenAudience = values.audience;
  const expiration = values.expiration;
  const email = values.email;
  if (
    typeof subject !== "string" ||
    typeof sessionId !== "string" ||
    typeof tokenIssuer !== "string" ||
    !Array.isArray(tokenAudience) ||
    !tokenAudience.every((item) => typeof item === "string") ||
    typeof expiration !== "string" ||
    typeof email !== "object" ||
    email === null ||
    Array.isArray(email)
  )
    return { kind: "malformed" };
  if (
    tokenIssuer !== issuer ||
    !tokenAudience.includes(audience) ||
    !UUID.test(subject) ||
    /^0{8}-0{4}-0{4}-0{4}-0{12}$/i.test(subject) ||
    !UUID.test(sessionId) ||
    /^0{8}-0{4}-0{4}-0{4}-0{12}$/i.test(sessionId)
  )
    return { kind: "invalid" };
  if (!isValidTimestamp(expiration)) return { kind: "malformed" };
  const emailClaims = email as Record<string, unknown>;
  if (typeof emailClaims.is_verified !== "boolean" || typeof emailClaims.address !== "string")
    return { kind: "malformed" };
  if (emailClaims.is_verified !== true) return { kind: "invalid" };
  const verifiedEmail = emailClaims.address.trim().toLowerCase();
  if (!verifiedEmail.includes("@") || verifiedEmail.length > 320) return { kind: "malformed" };
  const expiresAt = new Date(expiration);
  if (!Number.isFinite(expiresAt.getTime())) return { kind: "malformed" };
  if (expiresAt <= now) return { kind: "invalid" };
  if (validation.idle_expires_at !== undefined) {
    if (
      typeof validation.idle_expires_at !== "string" ||
      !isValidTimestamp(validation.idle_expires_at)
    )
      return { kind: "malformed" };
    const idleExpiresAt = new Date(validation.idle_expires_at);
    if (!Number.isFinite(idleExpiresAt.getTime())) return { kind: "malformed" };
    if (idleExpiresAt <= now) return { kind: "invalid" };
  }
  return {
    kind: "valid",
    identity: Object.freeze({
      issuer,
      subject: subject.toLowerCase(),
      sessionId: sessionId.toLowerCase(),
      verifiedEmail,
      expiresAt,
    }),
  };
}

export function createHankoSessionAdapter(options: HankoSessionAdapterOptions) {
  const origin = validateOptions(options);
  const validationUrl = new URL("/sessions/validate", origin);
  const cookieName = options.cookieName ?? DEFAULT_COOKIE_NAME;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const fetcher = options.fetcher ?? globalThis.fetch;

  return Object.freeze({
    async validateCookie(cookieHeader: string | null | undefined): Promise<HankoSessionResult> {
      const cookieValue = namedCookieValue(cookieHeader, cookieName);
      if (!cookieValue) return unauthenticated();
      try {
        const requestInit: RequestInit & { cache: "no-store" } = {
          method: "GET",
          headers: {
            accept: "application/json",
            cookie: `${cookieName}=${cookieValue}`,
          },
          cache: "no-store",
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        };
        const response = await fetcher(validationUrl, requestInit);
        if (response.status !== 200) {
          await response.body?.cancel().catch(() => undefined);
          return unavailable();
        }
        const rawBody = await readBoundedText(response, maxResponseBytes);
        const parsed: unknown = JSON.parse(rawBody);
        const session = parseSession(parsed, options.issuer, options.audience, new Date());
        if (session.kind === "malformed") return unavailable();
        return session.kind === "valid"
          ? { ok: true, identity: session.identity }
          : unauthenticated();
      } catch {
        return unavailable();
      }
    },
  });
}
