import type { StaffStudyRepository } from "@clarity/database/study-repository";
import type { StaffAccessResult } from "../auth/require-staff-access.js";

const UID = /^(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*))*$/;
const DICOMWEB_PREFIX = "/dicom-web/";
const MAX_METADATA_BYTES = 12 * 1024 * 1024;
const MAX_METADATA_CONCURRENCY = 8;
const REQUEST_TIMEOUT_MS = 60_000;

type ParsedPath = Readonly<{
  studyInstanceUid: string;
  seriesInstanceUid: string | null;
  sopInstanceUid: string | null;
  upstreamPath: string;
  metadata: boolean;
  qidoLevel: "study" | "series" | "instance" | "sop" | null;
  bulkDataTag?: string;
}>;

type Member = Readonly<{ seriesInstanceUid: string; sopInstanceUid: string }>;

export type ScopedDicomwebOptions = Readonly<{
  orthancDicomwebUrl: string;
  username: string;
  password: string;
  staff: Readonly<{
    requireStaffRead(cookie: string | null): Promise<StaffAccessResult>;
  }>;
  studies: Pick<
    StaffStudyRepository,
    "findViewableReportByStudyUid" | "authorizeDicomwebRequest" | "listViewableMembers"
  >;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  maxMetadataBytes?: number;
  maxConcurrentRequests?: number;
}>;

function response(
  status: number,
  body: string,
  extra?: Readonly<Record<string, string>>,
): Response {
  const headers = new Headers(extra);
  headers.set("cache-control", "private, no-store, max-age=0");
  headers.set("pragma", "no-cache");
  headers.set("vary", "Cookie, Accept");
  headers.set("x-content-type-options", "nosniff");
  if (body) headers.set("content-type", "application/json; charset=utf-8");
  return new Response(body || null, { status, headers });
}

function errorResult(access: Exclude<StaffAccessResult, { ok: true }>): Response {
  return response(access.status, JSON.stringify({ error: access.reason }));
}

function exactQueryUid(url: URL): string | null {
  const values = url.searchParams.getAll("StudyInstanceUID");
  return values.length === 1 && UID.test(values[0] ?? "") ? values[0]! : null;
}

function qidoQuery(url: URL, studyUid: string, includeStudyUid: boolean): URLSearchParams | null {
  const allowed = new Set([
    "studyinstanceuid",
    "limit",
    "offset",
    "includefield",
    "includefields",
    "fuzzymatching",
  ]);
  for (const key of url.searchParams.keys()) {
    const normalizedKey = key.toLowerCase();
    if (!allowed.has(normalizedKey) || (!includeStudyUid && normalizedKey === "studyinstanceuid"))
      return null;
  }
  const output = new URLSearchParams();
  if (includeStudyUid) output.set("StudyInstanceUID", studyUid);
  const limits = url.searchParams.getAll("limit");
  if (limits.length > 1 || (limits[0] !== undefined && !/^[1-9][0-9]{0,3}$/.test(limits[0])))
    return null;
  if (limits[0] !== undefined || includeStudyUid) {
    output.set("limit", String(Math.min(Number(limits[0] ?? "200"), 1000)));
  }
  const offsets = url.searchParams.getAll("offset");
  if (offsets.length > 1 || (offsets[0] !== undefined && !/^(0|[1-9][0-9]{0,7})$/.test(offsets[0])))
    return null;
  if (offsets[0]) output.set("offset", offsets[0]);
  const includeFields = [...url.searchParams.entries()].filter(([key]) =>
    ["includefield", "includefields"].includes(key.toLowerCase()),
  );
  if (includeFields.length > 100) return null;
  const includeValues = includeFields.map(([, value]) => value);
  if (
    includeValues.some(
      (value) =>
        (value.length > 800 && value !== "all") ||
        !/^(?:all|[0-9a-fA-F]{8}(?:,[0-9a-fA-F]{8}){0,99})$/.test(value),
    ) ||
    (includeValues.includes("all") && includeValues.length > 1)
  ) {
    return null;
  }
  for (const [key, value] of includeFields) {
    output.append(key.toLowerCase(), value);
  }
  const fuzzy = url.searchParams.getAll("fuzzymatching");
  if (fuzzy.length > 1 || (fuzzy.length === 1 && fuzzy[0] !== "true" && fuzzy[0] !== "false"))
    return null;
  if (fuzzy[0]) output.set("fuzzymatching", fuzzy[0]);
  return output;
}

function parsePath(path: readonly string[], url: URL): ParsedPath | null {
  if (path.length === 1 && path[0] === "studies") {
    const uid = exactQueryUid(url);
    const query = uid ? qidoQuery(url, uid, true) : null;
    if (!uid || !query) return null;
    return {
      studyInstanceUid: uid,
      seriesInstanceUid: null,
      sopInstanceUid: null,
      upstreamPath: `studies?${query.toString()}`,
      metadata: true,
      qidoLevel: "study",
    };
  }
  if (path[0] !== "studies" || path.length < 2) return null;
  const studyUid = path[1];
  if (!studyUid || !UID.test(studyUid)) return null;
  if (path.length === 3 && path[2] === "series") {
    const query = qidoQuery(url, studyUid, false);
    if (!query) return null;
    const suffix = url.search ? `?${query.toString()}` : "";
    return {
      studyInstanceUid: studyUid,
      seriesInstanceUid: null,
      sopInstanceUid: null,
      upstreamPath: `studies/${studyUid}/series${suffix}`,
      metadata: true,
      qidoLevel: "series",
    };
  }
  if (path.length === 5 && path[2] === "series" && path[4] === "instances") {
    if (!UID.test(path[3] ?? "")) return null;
    const query = qidoQuery(url, studyUid, false);
    if (!query) return null;
    const suffix = url.search ? `?${query.toString()}` : "";
    return {
      studyInstanceUid: studyUid,
      seriesInstanceUid: path[3]!,
      sopInstanceUid: null,
      upstreamPath: `studies/${studyUid}/series/${path[3]}/instances${suffix}`,
      metadata: true,
      qidoLevel: "instance",
    };
  }
  if (url.search.length > 0) return null;
  if (path.length === 3 && path[2] === "metadata") {
    return {
      studyInstanceUid: studyUid,
      seriesInstanceUid: null,
      sopInstanceUid: null,
      upstreamPath: `studies/${studyUid}/metadata`,
      metadata: true,
      qidoLevel: "instance",
    };
  }
  if (path.length < 4 || path[2] !== "series" || !UID.test(path[3] ?? "")) return null;
  const seriesUid = path[3]!;
  if (path.length === 4) {
    return {
      studyInstanceUid: studyUid,
      seriesInstanceUid: seriesUid,
      sopInstanceUid: null,
      upstreamPath: `studies/${studyUid}/series/${seriesUid}`,
      metadata: true,
      qidoLevel: "instance",
    };
  }
  if (path.length === 5 && path[4] === "metadata") {
    return {
      studyInstanceUid: studyUid,
      seriesInstanceUid: seriesUid,
      sopInstanceUid: null,
      upstreamPath: `studies/${studyUid}/series/${seriesUid}/metadata`,
      metadata: true,
      qidoLevel: "instance",
    };
  }
  if (path.length === 5 && path[4] === "instances") {
    return {
      studyInstanceUid: studyUid,
      seriesInstanceUid: seriesUid,
      sopInstanceUid: null,
      upstreamPath: `studies/${studyUid}/series/${seriesUid}/instances`,
      metadata: true,
      qidoLevel: "instance",
    };
  }
  if (path.length < 6 || path[4] !== "instances" || !UID.test(path[5] ?? "")) return null;
  const sopUid = path[5]!;
  if (path.length === 8 && path[6] === "bulkdata" && /^[0-9a-fA-F]{8}$/.test(path[7] ?? "")) {
    const tag = path[7]!.toUpperCase();
    return {
      studyInstanceUid: studyUid,
      seriesInstanceUid: seriesUid,
      sopInstanceUid: sopUid,
      upstreamPath: `studies/${studyUid}/series/${seriesUid}/instances/${sopUid}/bulkdata/${tag}`,
      metadata: false,
      qidoLevel: null,
      bulkDataTag: tag,
    };
  }
  if (path.length === 6) {
    return {
      studyInstanceUid: studyUid,
      seriesInstanceUid: seriesUid,
      sopInstanceUid: sopUid,
      upstreamPath: `studies/${studyUid}/series/${seriesUid}/instances/${sopUid}`,
      metadata: false,
      qidoLevel: null,
    };
  }
  if (path.length === 7 && path[6] === "metadata") {
    return {
      studyInstanceUid: studyUid,
      seriesInstanceUid: seriesUid,
      sopInstanceUid: sopUid,
      upstreamPath: `studies/${studyUid}/series/${seriesUid}/instances/${sopUid}/metadata`,
      metadata: true,
      qidoLevel: "sop",
    };
  }
  if (
    path.length === 8 &&
    path[6] === "frames" &&
    /^(?:[1-9][0-9]{0,5})(?:,(?:[1-9][0-9]{0,5})){0,99}$/.test(path[7] ?? "")
  ) {
    return {
      studyInstanceUid: studyUid,
      seriesInstanceUid: seriesUid,
      sopInstanceUid: sopUid,
      upstreamPath: `studies/${studyUid}/series/${seriesUid}/instances/${sopUid}/frames/${path[7]}`,
      metadata: false,
      qidoLevel: null,
    };
  }
  return null;
}

function dicomTag(item: unknown, tag: string): string | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const entry = (item as Record<string, unknown>)[tag];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const values = (entry as Record<string, unknown>).Value;
  return Array.isArray(values) && typeof values[0] === "string" ? values[0] : null;
}

function filterQido(
  value: unknown,
  scope: ParsedPath,
  reportUid: string,
  members: readonly Member[],
): unknown {
  if (!Array.isArray(value)) throw new Error("invalid-dicom-json");
  const memberSeries = new Set(members.map((item) => item.seriesInstanceUid));
  const memberSops = new Set(members.map((item) => item.sopInstanceUid));
  return value.filter((item) => {
    if (scope.qidoLevel !== "study" && dicomTag(item, "0020000D") !== reportUid) return false;
    if (scope.qidoLevel === "study") return dicomTag(item, "0020000D") === reportUid;
    if (scope.qidoLevel === "series") return memberSeries.has(dicomTag(item, "0020000E") ?? "");
    if (scope.qidoLevel === "instance") {
      return (
        memberSops.has(dicomTag(item, "00080018") ?? "") &&
        (scope.seriesInstanceUid === null || dicomTag(item, "0020000E") === scope.seriesInstanceUid)
      );
    }
    if (scope.qidoLevel === "sop") {
      return (
        dicomTag(item, "00080018") === scope.sopInstanceUid &&
        dicomTag(item, "0020000E") === scope.seriesInstanceUid
      );
    }
    return false;
  });
}

function rewriteBulkDataUris(
  value: unknown,
  studyUid: string,
  members: readonly Member[],
  origin: string,
): unknown {
  const memberKeys = new Set(
    members.map((member) => `${member.seriesInstanceUid}\u0000${member.sopInstanceUid}`),
  );
  const visit = (
    current: unknown,
    context: Readonly<{
      study: string | null;
      series: string | null;
      sop: string | null;
      tag: string | null;
    }> = {
      study: null,
      series: null,
      sop: null,
      tag: null,
    },
  ): unknown => {
    if (Array.isArray(current)) return current.map((item) => visit(item, context));
    if (!current || typeof current !== "object") return current;
    const object = current as Record<string, unknown>;
    const next = {
      study: dicomTag(object, "0020000D") ?? context.study,
      series: dicomTag(object, "0020000E") ?? context.series,
      sop: dicomTag(object, "00080018") ?? context.sop,
      tag: context.tag,
    };
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(object)) {
      if (key !== "BulkDataURI") {
        output[key] = visit(
          child,
          /^[0-9a-fA-F]{8}$/.test(key) ? { ...next, tag: key.toUpperCase() } : next,
        );
        continue;
      }
      if (
        typeof child !== "string" ||
        next.study !== studyUid ||
        next.series === null ||
        next.sop === null ||
        next.tag === null ||
        !memberKeys.has(`${next.series}\u0000${next.sop}`)
      ) {
        throw new Error("unscoped-bulkdata-uri");
      }
      const target = new URL(
        `/dicom-web/studies/${next.study}/series/${next.series}/instances/${next.sop}/bulkdata/${next.tag}`,
        origin,
      );
      output[key] = target.toString();
    }
    return output;
  };
  return visit(value);
}

async function readBounded(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    await response.body?.cancel();
    throw new RangeError("DICOM metadata response is too large.");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new RangeError("DICOM metadata response is too large.");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function streamAndRelease(
  body: ReadableStream<Uint8Array>,
  release: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    release();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await reader.read();
        if (part.done) {
          releaseOnce();
          controller.close();
        } else controller.enqueue(part.value);
      } catch (error) {
        releaseOnce();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        releaseOnce();
      }
    },
  });
}

export function createScopedDicomwebGateway(options: ScopedDicomwebOptions) {
  const base = new URL(options.orthancDicomwebUrl);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && base.hostname === "orthanc")) {
    throw new TypeError("Cloud DICOMweb must use HTTPS or the private Orthanc service host.");
  }
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxMetadataBytes = options.maxMetadataBytes ?? MAX_METADATA_BYTES;
  const maxConcurrent = options.maxConcurrentRequests ?? MAX_METADATA_CONCURRENCY;
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 32) {
    throw new TypeError("DICOMweb concurrency limit is invalid.");
  }
  let active = 0;

  return Object.freeze({
    async handle(request: Request, path: readonly string[]): Promise<Response> {
      if (request.method !== "GET")
        return response(405, JSON.stringify({ error: "method_not_allowed" }), { allow: "GET" });
      if (active >= maxConcurrent)
        return response(429, JSON.stringify({ error: "viewer_busy" }), { "retry-after": "2" });
      active += 1;
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          active -= 1;
        }
      };
      let streamOwnsRelease = false;
      try {
        const access = await options.staff.requireStaffRead(request.headers.get("cookie"));
        if (!access.ok) return errorResult(access);
        const url = new URL(request.url);
        const parsed = parsePath(path, url);
        if (!parsed) return response(400, JSON.stringify({ error: "invalid_dicomweb_request" }));
        const report = await options.studies.findViewableReportByStudyUid(
          access.principal.staffUserId,
          parsed.studyInstanceUid,
        );
        if (!report) return response(404, JSON.stringify({ error: "study_unavailable" }));
        if (parsed.seriesInstanceUid !== null || parsed.sopInstanceUid !== null) {
          const member = await options.studies.authorizeDicomwebRequest({
            staffUserId: access.principal.staffUserId,
            reportId: report.reportId,
            seriesInstanceUid: parsed.seriesInstanceUid,
            sopInstanceUid: parsed.sopInstanceUid,
          });
          if (!member) return response(404, JSON.stringify({ error: "image_unavailable" }));
        }
        const authorization = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`;
        // Metadata is always requested as DICOM JSON so an upstream cannot return an unfiltered
        // multipart or binary representation through a metadata route.
        const accept = parsed.metadata
          ? "application/dicom+json"
          : (request.headers.get("accept") ?? 'multipart/related; type="application/dicom"');
        if (accept.length > 1024 || /[\r\n]/.test(accept))
          return response(400, JSON.stringify({ error: "invalid_accept" }));
        const upstreamUrl = new URL(parsed.upstreamPath, base);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        let upstream: Response;
        try {
          upstream = await fetcher(upstreamUrl, {
            method: "GET",
            redirect: "manual",
            signal: AbortSignal.any([controller.signal, request.signal]),
            headers: { authorization, accept },
          });
        } catch {
          clearTimeout(timeout);
          release();
          return response(503, JSON.stringify({ error: "viewer_unavailable" }));
        }
        if (upstream.status < 200 || upstream.status >= 300) {
          clearTimeout(timeout);
          await upstream.body?.cancel();
          release();
          const status =
            upstream.status === 404 || upstream.status === 406 || upstream.status === 415
              ? upstream.status
              : 503;
          return response(
            status,
            JSON.stringify({
              error: status === 503 ? "viewer_unavailable" : "content_unavailable",
            }),
          );
        }
        const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
        if (parsed.metadata && !contentType.toLowerCase().includes("json")) {
          clearTimeout(timeout);
          await upstream.body?.cancel();
          release();
          return response(502, JSON.stringify({ error: "metadata_unavailable" }));
        }
        const headers = new Headers({ "content-type": contentType });
        for (const name of ["content-length", "content-range", "accept-ranges"]) {
          const value = upstream.headers.get(name);
          if (value) headers.set(name, value);
        }
        headers.set("cache-control", "private, no-store, max-age=0");
        headers.set("pragma", "no-cache");
        headers.set("vary", "Cookie, Accept");
        headers.set("x-content-type-options", "nosniff");
        if (!parsed.metadata || !contentType.toLowerCase().includes("json")) {
          const body = upstream.body
            ? streamAndRelease(upstream.body, () => {
                clearTimeout(timeout);
                release();
              })
            : null;
          if (!body) {
            clearTimeout(timeout);
            release();
          } else streamOwnsRelease = true;
          return new Response(body, { status: upstream.status, headers });
        }
        let bytes: Uint8Array;
        try {
          bytes = await readBounded(upstream, maxMetadataBytes);
          clearTimeout(timeout);
        } catch {
          await upstream.body?.cancel();
          clearTimeout(timeout);
          release();
          return response(502, JSON.stringify({ error: "metadata_unavailable" }));
        }
        release();
        try {
          const parsedJson: unknown = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          );
          const members = await options.studies.listViewableMembers(
            access.principal.staffUserId,
            report.reportId,
          );
          if (members === null || members.length > 100_000) {
            return response(503, JSON.stringify({ error: "manifest_too_large" }));
          }
          const filtered = filterQido(parsedJson, parsed, report.studyInstanceUid, members);
          const rewritten = rewriteBulkDataUris(
            filtered,
            report.studyInstanceUid,
            members,
            url.origin,
          );
          headers.delete("content-length");
          return new Response(JSON.stringify(rewritten), { status: upstream.status, headers });
        } catch {
          return response(502, JSON.stringify({ error: "metadata_unavailable" }));
        }
      } finally {
        if (!streamOwnsRelease) release();
      }
    },
  });
}

export type ScopedOhifProxyOptions = Readonly<{
  orthancOrigin: string;
  username: string;
  password: string;
  staff: Readonly<{
    requireStaffRead(cookie: string | null): Promise<StaffAccessResult>;
  }>;
  studies: Pick<StaffStudyRepository, "findViewableReportByStudyUid">;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}>;

export function createScopedOhifProxy(options: ScopedOhifProxyOptions) {
  const origin = new URL(options.orthancOrigin);
  if (
    origin.protocol !== "https:" &&
    !(origin.protocol === "http:" && origin.hostname === "orthanc")
  ) {
    throw new TypeError("Cloud Orthanc must use HTTPS or the private Orthanc service host.");
  }
  if (origin.pathname !== "/" || origin.search || origin.hash) {
    throw new TypeError("Cloud Orthanc origin must not contain a path or query.");
  }
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  return Object.freeze({
    async handle(request: Request, path: readonly string[]): Promise<Response> {
      if (request.method !== "GET")
        return response(405, JSON.stringify({ error: "method_not_allowed" }), { allow: "GET" });
      const access = await options.staff.requireStaffRead(request.headers.get("cookie"));
      if (!access.ok) return errorResult(access);
      if (
        path.some(
          (segment) =>
            !/^[A-Za-z0-9._~-]{1,160}$/.test(segment) || segment === "." || segment === "..",
        )
      ) {
        return response(404, JSON.stringify({ error: "not_found" }));
      }
      const url = new URL(request.url);
      let query = "";
      if (path.length === 1 && path[0] === "viewer" && url.search.length > 0) {
        const values = url.searchParams.getAll("StudyInstanceUIDs");
        if (
          values.length !== 1 ||
          !UID.test(values[0] ?? "") ||
          [...url.searchParams.keys()].some((key) => key !== "StudyInstanceUIDs")
        ) {
          return response(400, JSON.stringify({ error: "invalid_view_request" }));
        }
        const report = await options.studies.findViewableReportByStudyUid(
          access.principal.staffUserId,
          values[0]!,
        );
        if (!report) return response(404, JSON.stringify({ error: "study_unavailable" }));
        query = `?StudyInstanceUIDs=${encodeURIComponent(report.studyInstanceUid)}`;
      } else if (url.search) {
        return response(400, JSON.stringify({ error: "invalid_view_request" }));
      }
      const suffix = path.join("/");
      const upstreamUrl = new URL(`ohif/${suffix}`, origin);
      upstreamUrl.search = query;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let upstream: Response;
      try {
        upstream = await fetcher(upstreamUrl, {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.any([controller.signal, request.signal]),
          headers: {
            authorization: `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`,
            accept: request.headers.get("accept") ?? "*/*",
          },
        });
      } catch {
        clearTimeout(timeout);
        return response(503, JSON.stringify({ error: "viewer_unavailable" }));
      }
      if (upstream.status < 200 || upstream.status >= 300 || !upstream.body) {
        clearTimeout(timeout);
        await upstream.body?.cancel();
        return response(404, JSON.stringify({ error: "viewer_unavailable" }));
      }
      const headers = new Headers();
      const contentType = upstream.headers.get("content-type");
      if (contentType) headers.set("content-type", contentType);
      headers.set("cache-control", "private, no-store, max-age=0");
      headers.set("pragma", "no-cache");
      headers.set("vary", "Cookie");
      headers.set("x-content-type-options", "nosniff");
      const body = streamAndRelease(upstream.body, () => clearTimeout(timeout));
      return new Response(body, { status: upstream.status, headers });
    },
  });
}

export function dicomwebPathFromRequest(request: Request): readonly string[] | null {
  const path = new URL(request.url).pathname;
  if (!path.startsWith(DICOMWEB_PREFIX)) return null;
  const raw = path.slice(DICOMWEB_PREFIX.length).replace(/\/$/, "");
  if (!raw || raw.split("/").some((segment) => !segment || segment === "." || segment === ".."))
    return null;
  try {
    return Object.freeze(raw.split("/").map((segment) => decodeURIComponent(segment)));
  } catch {
    return null;
  }
}
