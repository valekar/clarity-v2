import type { CloudIndex, DicomIdentity } from "./contracts.js";

export class InvalidOrthancResponseError extends Error {}

export class OrthancClient implements CloudIndex {
  constructor(
    private readonly baseUrl: URL,
    private readonly username: string,
    private readonly password: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly requestTimeoutMs = 30_000,
    private readonly shutdownSignal?: AbortSignal,
  ) {}

  private async request(
    path: string,
    init?: RequestInit,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set(
      "authorization",
      `Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}`,
    );
    const timeoutController = new AbortController();
    const timeout = setTimeout(
      () =>
        timeoutController.abort(
          new DOMException("Orthanc request deadline exceeded.", "TimeoutError"),
        ),
      timeoutMs,
    );
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.baseUrl), {
        ...init,
        headers,
        signal: AbortSignal.any([
          timeoutController.signal,
          ...(init?.signal == null ? [] : [init.signal]),
          ...(this.shutdownSignal === undefined ? [] : [this.shutdownSignal]),
        ]),
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Cloud Orthanc request failed (${response.status}).`);
    }
    return response;
  }

  private async readJson(response: Response, maximumBytes = 64_000): Promise<unknown> {
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > maximumBytes) {
      await response.body?.cancel();
      throw new Error("Cloud Orthanc metadata response exceeded its limit.");
    }
    if (response.body === null) throw new Error("Cloud Orthanc metadata response has no body.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error("Cloud Orthanc metadata response exceeded its limit.");
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  async findBySopInstanceUid(uid: string): Promise<string | undefined> {
    const response = await this.request("tools/find", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ Level: "Instance", Query: { SOPInstanceUID: uid } }),
    });
    const ids = await this.readJson(response);
    if (!Array.isArray(ids) || ids.some((value) => typeof value !== "string")) {
      throw new InvalidOrthancResponseError(
        "Cloud Orthanc returned an invalid instance search response.",
      );
    }
    if (ids.length > 1)
      throw new InvalidOrthancResponseError(
        "A reserved SOP UID has multiple cloud Orthanc instances.",
      );
    return ids[0];
  }

  async importInstance(bytes: ReadableStream<Uint8Array>, byteCount: number): Promise<string> {
    const response = await this.request(
      "instances",
      {
        method: "POST",
        headers: { "content-type": "application/dicom", "content-length": String(byteCount) },
        body: bytes,
        duplex: "half",
      } as RequestInit,
      60 * 60 * 1000,
    );
    const result = await this.readJson(response);
    if (
      typeof result !== "object" ||
      result === null ||
      !("ID" in result) ||
      typeof result.ID !== "string"
    ) {
      throw new InvalidOrthancResponseError(
        "Cloud Orthanc import response did not contain an instance ID.",
      );
    }
    return result.ID;
  }

  async readIdentity(instanceId: string): Promise<DicomIdentity> {
    const response = await this.request(
      `instances/${encodeURIComponent(instanceId)}/simplified-tags`,
    );
    const tags = await this.readJson(response, 1_000_000);
    if (typeof tags !== "object" || tags === null)
      throw new InvalidOrthancResponseError("Cloud Orthanc instance tags are invalid.");
    const tagSet = tags as Readonly<Record<string, string>>;
    const studyInstanceUid = tagSet.StudyInstanceUID;
    const seriesInstanceUid = tagSet.SeriesInstanceUID;
    const sopInstanceUid = tagSet.SOPInstanceUID;
    if (!studyInstanceUid || !seriesInstanceUid || !sopInstanceUid) {
      throw new InvalidOrthancResponseError("Cloud Orthanc did not index required DICOM UIDs.");
    }
    return { studyInstanceUid, seriesInstanceUid, sopInstanceUid };
  }

  async readBytes(instanceId: string): Promise<ReadableStream<Uint8Array>> {
    const response = await this.request(
      `instances/${encodeURIComponent(instanceId)}/file`,
      undefined,
      60 * 60 * 1000,
    );
    if (response.body === null)
      throw new InvalidOrthancResponseError("Cloud Orthanc file response has no body.");
    return response.body;
  }
}
