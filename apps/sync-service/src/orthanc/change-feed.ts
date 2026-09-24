import type {
  ChangePage,
  Checkpoint,
  CheckpointStore,
  SourceIdentity,
} from "../persistence/checkpoint-store.js";
import { readBoundedJson } from "./bounded-json.js";
import { fetchOrthanc, OrthancUnavailableError } from "./errors.js";

export interface OrthancChangeFeedOptions {
  baseUrl: string;
  sourceKey: string;
  pageSize?: number;
  fetchImpl?: typeof fetch;
  authorization?: string;
}

export interface PollResult {
  checkpoint: Checkpoint;
  done: boolean;
  fetchedFrom: number;
  changesCaptured: number;
  resetDetected: boolean;
}

interface OrthancSystemResponse {
  DatabaseServerIdentifier?: unknown;
  DatabaseVersion?: unknown;
}

interface OrthancChangesResponse {
  Last?: unknown;
  Done?: unknown;
  Changes?: unknown;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function safeSequence(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    throw new Error(`${label} must be a non-empty string no longer than 2048 characters`);
  }
  return value;
}

function parseIdentity(value: unknown): SourceIdentity {
  const system = record(value as OrthancSystemResponse, "Orthanc /system response");
  const identifier = system.DatabaseServerIdentifier;
  const version = system.DatabaseVersion;
  if (identifier !== undefined && typeof identifier !== "string") {
    throw new Error("Orthanc DatabaseServerIdentifier must be a string when provided");
  }
  if (version !== undefined && (!Number.isInteger(version) || (version as number) < 0)) {
    throw new Error("Orthanc DatabaseVersion must be a non-negative integer when provided");
  }
  return {
    databaseServerIdentifier: typeof identifier === "string" ? identifier : null,
    databaseVersion: typeof version === "number" ? version : null,
  };
}

function parsePage(value: unknown, requestedLimit: number): ChangePage {
  const response = record(value as OrthancChangesResponse, "Orthanc /changes response");
  const last = safeSequence(response.Last, "Orthanc Last");
  if (typeof response.Done !== "boolean") throw new Error("Orthanc Done must be boolean");
  if (!Array.isArray(response.Changes)) throw new Error("Orthanc Changes must be an array");
  if (response.Changes.length > requestedLimit) {
    throw new Error("Orthanc returned more changes than the requested page limit");
  }
  const changes = response.Changes.map((entry, index) => {
    const item = record(entry, `Orthanc change ${index}`);
    const sequence = safeSequence(item.Seq, `Orthanc change ${index} Seq`);
    const changeType = stringField(item.ChangeType, `Orthanc change ${index} ChangeType`);
    const resourceType = stringField(item.ResourceType, `Orthanc change ${index} ResourceType`);
    const orthancId = stringField(item.ID, `Orthanc change ${index} ID`);
    if (item.Date !== undefined && typeof item.Date !== "string") {
      throw new Error(`Orthanc change ${index} Date must be a string when provided`);
    }
    return {
      sequence,
      changeType,
      resourceType,
      orthancId,
      ...(typeof item.Date === "string" ? { date: item.Date } : {}),
    };
  });
  for (let index = 1; index < changes.length; index += 1) {
    if (changes[index]!.sequence <= changes[index - 1]!.sequence) {
      throw new Error("Orthanc changes must be in strictly increasing sequence order");
    }
  }
  return { last, done: response.Done, changes };
}

/** Private-source change-feed client. It is testable with an injected fetch function. */
export class OrthancChangeFeedAdapter {
  readonly #baseUrl: URL;
  readonly #sourceKey: string;
  readonly #pageSize: number;
  readonly #fetch: typeof fetch;
  readonly #authorization: string | undefined;
  readonly #store: CheckpointStore;

  constructor(store: CheckpointStore, options: OrthancChangeFeedOptions) {
    const baseUrl = new URL(options.baseUrl);
    if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
      throw new Error("Orthanc base URL must use HTTP or HTTPS");
    }
    if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
      throw new Error("Orthanc base URL must not contain credentials, query, or fragment");
    }
    if (!options.sourceKey.trim() || options.sourceKey.length > 200) {
      throw new Error("sourceKey must be a non-empty identifier no longer than 200 characters");
    }
    const pageSize = options.pageSize ?? 100;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) {
      throw new Error("pageSize must be an integer between 1 and 500");
    }
    this.#baseUrl = baseUrl;
    this.#sourceKey = options.sourceKey;
    this.#pageSize = pageSize;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#authorization = options.authorization;
    this.#store = store;
  }

  async pollOnce(): Promise<PollResult> {
    const identity = parseIdentity(await this.#get("/system"));
    const previous = this.#store.getCheckpoint(this.#sourceKey);
    const identityChanged = Boolean(
      previous &&
      ((identity.databaseServerIdentifier !== null &&
        previous.databaseServerIdentifier !== null &&
        identity.databaseServerIdentifier !== previous.databaseServerIdentifier) ||
        (identity.databaseVersion !== null &&
          previous.databaseVersion !== null &&
          identity.databaseVersion !== previous.databaseVersion)),
    );
    const requestedSince = previous && !identityChanged ? previous.cursor : 0;
    let page = await this.#getChanges(requestedSince);
    let result = this.#store.capturePage(this.#sourceKey, identity, requestedSince, page);
    let fetchedFrom = requestedSince;
    let resetDetected = result.resetDetected || identityChanged;

    if (result.resetDetected && previous && !identityChanged) {
      fetchedFrom = 0;
      page = await this.#getChanges(0);
      result = this.#store.capturePage(this.#sourceKey, identity, 0, page);
      resetDetected = true;
    }
    return {
      checkpoint: result.checkpoint,
      done: page.done,
      fetchedFrom,
      changesCaptured: page.changes.length,
      resetDetected,
    };
  }

  async #getChanges(since: number): Promise<ChangePage> {
    const url = new URL(
      "changes",
      this.#baseUrl.href.endsWith("/") ? this.#baseUrl : `${this.#baseUrl}/`,
    );
    url.searchParams.set("since", String(since));
    url.searchParams.set("limit", String(this.#pageSize));
    return parsePage(await this.#get(url.href, true), this.#pageSize);
  }

  async #get(path: string, absolute = false): Promise<unknown> {
    const url = absolute
      ? path
      : new URL(
          path.replace(/^\//, ""),
          this.#baseUrl.href.endsWith("/") ? this.#baseUrl : `${this.#baseUrl}/`,
        ).href;
    const response = await fetchOrthanc(this.#fetch, url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(this.#authorization ? { Authorization: this.#authorization } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new OrthancUnavailableError();
    }
    const pathname = new URL(url).pathname;
    return readBoundedJson(response, pathname === "/changes" ? 2 * 1024 * 1024 : 128 * 1024);
  }
}
