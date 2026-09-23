import { createHash, createHmac } from "node:crypto";

export type S3UploadAdmissionConfig = Readonly<{
  internalEndpoint: URL;
  publicEndpoint: URL;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
}>;

export type UploadPart = Readonly<{
  partNumber: number;
  offset: number;
  byteCount: number;
  url: string;
  headers: Record<string, string>;
}>;

export type UploadInstruction =
  | Readonly<{ mode: "put"; url: string; headers: Record<string, string> }>
  | Readonly<{ mode: "multipart"; uploadId: string; parts: UploadPart[] }>;

const maxBytes = 5 * 1024 * 1024 * 1024;
const partBytes = 32 * 1024 * 1024;
const multipartThreshold = 64 * 1024 * 1024;
const emptyHash = createHash("sha256").update("").digest("hex");
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const hmac = (key: string | Buffer, value: string): Buffer =>
  createHmac("sha256", key).update(value).digest();
const uriEncode = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const queryString = (query: ReadonlyArray<readonly [string, string]>): string =>
  query
    .map(([key, value]) => [uriEncode(key), uriEncode(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey < rightKey
        ? -1
        : leftKey > rightKey
          ? 1
          : leftValue < rightValue
            ? -1
            : leftValue > rightValue
              ? 1
              : 0,
    )
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

function validateEndpoint(endpoint: URL): void {
  if (
    !/^https?:$/.test(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !endpoint.host
  ) {
    throw new Error("Invalid S3 endpoint.");
  }
}

function validateKey(key: string): void {
  if (!/^intake\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.dcm$/.test(key)) {
    throw new Error("Unsafe intake object key.");
  }
}

function xmlEscape(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[char] ?? char,
  );
}

async function boundedText(response: Response): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > 64 * 1024) {
    await response.body?.cancel();
    throw new Error("S3 response exceeded the metadata limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > 64 * 1024) throw new Error("S3 response exceeded the metadata limit.");
      chunks.push(result.value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export class S3UploadAdmission {
  constructor(
    private readonly config: S3UploadAdmissionConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
    private readonly shutdownSignal?: AbortSignal,
  ) {
    validateEndpoint(config.internalEndpoint);
    validateEndpoint(config.publicEndpoint);
    if (
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) ||
      !config.region ||
      !config.accessKey ||
      !config.secretKey
    ) {
      throw new Error("Invalid S3 upload admission configuration.");
    }
  }

  private url(
    endpoint: URL,
    key: string,
    query: ReadonlyArray<readonly [string, string]> = [],
  ): URL {
    validateKey(key);
    const url = new URL(endpoint);
    const prefix = url.pathname.replace(/\/$/, "");
    url.pathname = `${prefix}/${uriEncode(this.config.bucket)}/${key.split("/").map(uriEncode).join("/")}`;
    url.search = queryString(query);
    return url;
  }

  private signature(
    method: string,
    url: URL,
    payloadHash: string,
    date: string,
    presigned: boolean,
  ): string {
    const day = date.slice(0, 8);
    const scope = `${day}/${this.config.region}/s3/aws4_request`;
    const headers = presigned
      ? `host:${url.host}\n`
      : `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${date}\n`;
    const names = presigned ? "host" : "host;x-amz-content-sha256;x-amz-date";
    const request = [method, url.pathname, url.search.slice(1), headers, names, payloadHash].join(
      "\n",
    );
    const signed = ["AWS4-HMAC-SHA256", date, scope, digest(request)].join("\n");
    const key = hmac(
      hmac(hmac(hmac(`AWS4${this.config.secretKey}`, day), this.config.region), "s3"),
      "aws4_request",
    );
    return createHmac("sha256", key).update(signed).digest("hex");
  }

  private presign(
    key: string,
    method: "PUT",
    expiresAt: Date,
    extra: ReadonlyArray<readonly [string, string]> = [],
  ): string {
    const now = this.now();
    const seconds = Math.floor((expiresAt.getTime() - now.getTime()) / 1000);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 900) {
      throw new Error("Upload URL expiry must be within 15 minutes.");
    }
    const date = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const scope = `${date.slice(0, 8)}/${this.config.region}/s3/aws4_request`;
    const query: Array<readonly [string, string]> = [
      ...extra,
      ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
      ["X-Amz-Credential", `${this.config.accessKey}/${scope}`],
      ["X-Amz-Date", date],
      ["X-Amz-Expires", String(seconds)],
      ["X-Amz-SignedHeaders", "host"],
    ];
    const url = this.url(this.config.publicEndpoint, key, query);
    url.searchParams.set(
      "X-Amz-Signature",
      this.signature(method, url, "UNSIGNED-PAYLOAD", date, true),
    );
    return url.toString();
  }

  private async request(
    key: string,
    method: "POST" | "DELETE" | "HEAD" | "GET",
    query: ReadonlyArray<readonly [string, string]> = [],
    body?: string,
  ): Promise<Response> {
    const url = this.url(this.config.internalEndpoint, key, query);
    const date = this.now()
      .toISOString()
      .replace(/[:-]|\.\d{3}/g, "");
    const payloadHash = body === undefined ? emptyHash : digest(body);
    const scope = `${date.slice(0, 8)}/${this.config.region}/s3/aws4_request`;
    const signature = this.signature(method, url, payloadHash, date, false);
    const headers: Record<string, string> = {
      authorization: `AWS4-HMAC-SHA256 Credential=${this.config.accessKey}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": date,
    };
    if (body !== undefined) headers["content-type"] = "application/xml";
    return this.fetcher(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.any([
        AbortSignal.timeout(method === "GET" ? 60 * 60 * 1000 : 30_000),
        ...(this.shutdownSignal === undefined ? [] : [this.shutdownSignal]),
      ]),
    });
  }

  async createUpload(key: string, byteCount: number, expiresAt: Date): Promise<UploadInstruction> {
    validateKey(key);
    if (!Number.isSafeInteger(byteCount) || byteCount < 1 || byteCount > maxBytes) {
      throw new Error("Upload byte count is outside the allowed range.");
    }
    if (byteCount < multipartThreshold) {
      return { mode: "put", url: this.presign(key, "PUT", expiresAt), headers: {} };
    }
    // Check the expiry before creating external multipart state.
    this.presign(key, "PUT", expiresAt);
    const response = await this.request(key, "POST", [["uploads", ""]]);
    const xml = await boundedText(response);
    if (!response.ok) throw new Error(`Multipart initiation failed (${response.status}).`);
    const uploadId = /<UploadId>([^<]{1,2048})<\/UploadId>/.exec(xml)?.[1];
    if (!uploadId) throw new Error("Multipart initiation returned no upload ID.");
    return this.resumeUpload(key, byteCount, uploadId, expiresAt);
  }

  resumeUpload(
    key: string,
    byteCount: number,
    uploadId: string,
    expiresAt: Date,
  ): Extract<UploadInstruction, { mode: "multipart" }> {
    validateKey(key);
    if (
      !Number.isSafeInteger(byteCount) ||
      byteCount < multipartThreshold ||
      byteCount > maxBytes ||
      !uploadId ||
      uploadId.length > 2048
    ) {
      throw new Error("Invalid multipart upload state.");
    }
    const parts: UploadPart[] = [];
    for (let offset = 0, partNumber = 1; offset < byteCount; offset += partBytes, partNumber += 1) {
      const count = Math.min(partBytes, byteCount - offset);
      parts.push({
        partNumber,
        offset,
        byteCount: count,
        url: this.presign(key, "PUT", expiresAt, [
          ["partNumber", String(partNumber)],
          ["uploadId", uploadId],
        ]),
        headers: {},
      });
    }
    return { mode: "multipart", uploadId, parts };
  }

  async completeMultipart(
    key: string,
    uploadId: string,
    parts: ReadonlyArray<Readonly<{ partNumber: number; etag: string }>>,
  ): Promise<void> {
    if (
      !uploadId ||
      uploadId.length > 2048 ||
      !parts.length ||
      parts.length > 10_000 ||
      parts.some(
        (part, index) =>
          part.partNumber !== index + 1 ||
          part.etag.length > 256 ||
          !/^[\x21-\x3b\x3d-\x7e]+$/.test(part.etag),
      )
    ) {
      throw new Error("Invalid multipart completion parts.");
    }
    const body = `<CompleteMultipartUpload>${parts
      .map(
        (part) =>
          `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${xmlEscape(part.etag)}</ETag></Part>`,
      )
      .join("")}</CompleteMultipartUpload>`;
    const response = await this.request(key, "POST", [["uploadId", uploadId]], body);
    const xml = await boundedText(response);
    // S3 can return HTTP 200 with an error element after initially accepting completion.
    if (
      !response.ok ||
      /<(?:\w+:)?Error(?:\s|>)/.test(xml) ||
      !/<(?:\w+:)?CompleteMultipartUploadResult(?:\s|>)/.test(xml)
    ) {
      throw new Error(`Multipart completion failed (${response.status}).`);
    }
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    if (!uploadId || uploadId.length > 2048) throw new Error("Invalid multipart upload ID.");
    const response = await this.request(key, "DELETE", [["uploadId", uploadId]]);
    await response.body?.cancel();
    if (!response.ok && response.status !== 404)
      throw new Error(`Multipart abort failed (${response.status}).`);
  }

  async head(key: string): Promise<number | null> {
    const response = await this.request(key, "HEAD");
    await response.body?.cancel();
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Intake object check failed (${response.status}).`);
    const rawLength = response.headers.get("content-length");
    const value = rawLength === null ? NaN : Number(rawLength);
    if (!Number.isSafeInteger(value) || value < 0 || value > maxBytes)
      throw new Error("Invalid intake object size.");
    return value;
  }

  async open(key: string): Promise<ReadableStream<Uint8Array>> {
    const response = await this.request(key, "GET");
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`Intake object read failed (${response.status}).`);
    }
    return response.body;
  }
}
