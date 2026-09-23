import { createHash, createHmac } from "node:crypto";

export type S3IntakeConfig = Readonly<{
  endpoint: URL;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
}>;

const emptyHash = createHash("sha256").update("").digest("hex");
const hmac = (key: string | Buffer, value: string): Buffer =>
  createHmac("sha256", key).update(value).digest();
const encodePath = (value: string): string => value.split("/").map(encodeURIComponent).join("/");

export class S3IntakeObjects {
  constructor(
    private readonly config: S3IntakeConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly shutdownSignal?: AbortSignal,
  ) {
    if (
      !/^https?:$/.test(config.endpoint.protocol) ||
      config.endpoint.username ||
      config.endpoint.password ||
      config.endpoint.search ||
      config.endpoint.hash ||
      !config.region ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) ||
      !config.accessKey ||
      !config.secretKey
    ) {
      throw new Error("Invalid S3 intake endpoint configuration.");
    }
  }

  private async request(key: string, method: "GET" | "DELETE"): Promise<Response> {
    if (!key || key.startsWith("/") || key.split("/").some((part) => part === "..")) {
      throw new Error("Unsafe intake object key.");
    }
    const url = new URL(this.config.endpoint);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodePath(this.config.bucket)}/${encodePath(key)}`;
    const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const day = date.slice(0, 8);
    const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${emptyHash}\nx-amz-date:${date}\n`;
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const canonicalRequest = [
      method,
      url.pathname,
      "",
      canonicalHeaders,
      signedHeaders,
      emptyHash,
    ].join("\n");
    const scope = `${day}/${this.config.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      date,
      scope,
      createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");
    const dateKey = hmac(`AWS4${this.config.secretKey}`, day);
    const regionKey = hmac(dateKey, this.config.region);
    const serviceKey = hmac(regionKey, "s3");
    const signingKey = hmac(serviceKey, "aws4_request");
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
    const authorization = `AWS4-HMAC-SHA256 Credential=${this.config.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return this.fetcher(url, {
      method,
      signal: AbortSignal.any([
        AbortSignal.timeout(method === "GET" ? 60 * 60 * 1000 : 30_000),
        ...(this.shutdownSignal === undefined ? [] : [this.shutdownSignal]),
      ]),
      headers: {
        authorization,
        "x-amz-content-sha256": emptyHash,
        "x-amz-date": date,
      },
    });
  }

  async open(key: string): Promise<ReadableStream<Uint8Array>> {
    const response = await this.request(key, "GET");
    if (!response.ok || response.body === null) {
      await response.body?.cancel();
      throw new Error(`Intake object read failed (${response.status}).`);
    }
    return response.body;
  }

  async remove(key: string): Promise<void> {
    const response = await this.request(key, "DELETE");
    if (!response.ok && response.status !== 404) {
      await response.body?.cancel();
      throw new Error(`Intake cleanup failed (${response.status}).`);
    }
  }
}
