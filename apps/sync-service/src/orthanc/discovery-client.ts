import type { InstanceObservation, StudyObservation } from "../discovery/model.js";
import type { RevalidationTarget } from "../persistence/discovery-revalidation-store.js";
import { readBoundedJson } from "./bounded-json.js";
import { normalizeInstanceObservation, normalizeStudyObservation } from "../discovery/normalize.js";
import { fetchOrthanc, OrthancUnavailableError } from "./errors.js";

export interface OrthancDiscoveryOptions {
  baseUrl: string;
  pageSize?: number;
  maxConcurrency?: number;
  fetchImpl?: typeof fetch;
  authorization?: string;
}

export class OrthancHttpError extends OrthancUnavailableError {
  constructor(
    readonly status: number,
    pathname: string,
  ) {
    super();
    this.message = `Orthanc GET ${pathname} failed with HTTP ${status}`;
    this.name = "OrthancHttpError";
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function idList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a JSON array`);
  return value.map((entry, index) => {
    const id = typeof entry === "string" ? entry : object(entry, `${label}[${index}]`).ID;
    if (typeof id !== "string" || !id.length || id.length > 200) {
      throw new Error(`${label}[${index}] must contain an Orthanc resource ID`);
    }
    return id;
  });
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await map(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return output;
}

function responseLimit(path: string): number {
  if (/^\/(?:instances|studies)\?/.test(path)) return 256 * 1024;
  if (/^\/changes\?/.test(path)) return 2 * 1024 * 1024;
  return 512 * 1024;
}

/** Bounded read-only Orthanc REST access for studies, instances and metadata. */
export class OrthancDiscoveryClient {
  readonly #baseUrl: URL;
  readonly #pageSize: number;
  readonly #fetch: typeof fetch;
  readonly #authorization: string | undefined;
  readonly #maxConcurrency: number;

  constructor(options: OrthancDiscoveryOptions) {
    const baseUrl = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
      throw new Error("Orthanc base URL must be HTTP(S) and must not contain credentials");
    }
    const pageSize = options.pageSize ?? 100;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) {
      throw new Error("pageSize must be an integer between 1 and 500");
    }
    const maxConcurrency = options.maxConcurrency ?? 4;
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 8) {
      throw new Error("maxConcurrency must be an integer between 1 and 8");
    }
    this.#baseUrl = baseUrl;
    this.#pageSize = pageSize;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#authorization = options.authorization;
    this.#maxConcurrency = maxConcurrency;
  }

  get pageSize(): number {
    return this.#pageSize;
  }

  get inventoryPageSize(): number {
    return Math.max(2, this.#pageSize);
  }

  async listStudyIds(offset: number): Promise<{ ids: string[]; done: boolean }> {
    this.#assertOffset(offset);
    const query = new URLSearchParams({ since: String(offset), limit: String(this.#pageSize) });
    const ids = idList(await this.#get(`/studies?${query}`), "Orthanc study page");
    if (ids.length > this.#pageSize)
      throw new Error("Orthanc returned more studies than the requested bound");
    return { ids, done: ids.length < this.#pageSize };
  }

  async getStudy(orthancStudyId: string): Promise<StudyObservation> {
    const value = await this.#get(`/studies/${encodeURIComponent(orthancStudyId)}`);
    return normalizeStudyObservation(orthancStudyId, value);
  }

  async listInstanceIds(
    offset: number,
    limit = this.#pageSize,
  ): Promise<{ ids: string[]; done: boolean }> {
    this.#assertOffset(offset);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("instance page limit must be an integer between 1 and 500");
    }
    const query = new URLSearchParams({ since: String(offset), limit: String(limit) });
    const ids = idList(await this.#get(`/instances?${query}`), "Orthanc global instance page");
    if (ids.length > limit)
      throw new Error("Orthanc returned more instances than the requested bound");
    return { ids, done: ids.length < this.#pageSize };
  }

  async getGlobalInstanceUpperBound(): Promise<string | null> {
    await this.verifyGlobalInstanceOrdering();
    const stats = object(await this.#get("/statistics"), "Orthanc statistics");
    const count = stats.CountInstances;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new Error("Orthanc CountInstances must be a non-negative safe integer");
    }
    let offset = Math.max(0, count - this.#pageSize);
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const page = await this.listInstanceIds(offset);
      if (page.ids.length > 0) {
        assertStrictlyIncreasing(page.ids);
        return page.ids.at(-1)!;
      }
      if (offset === 0) return null;
      offset = Math.max(0, offset - this.#pageSize);
    }
    throw new Error("could not capture a stable Orthanc instance upper bound");
  }

  async verifyGlobalInstanceOrdering(): Promise<void> {
    const limit = this.inventoryPageSize;
    const first = await this.listInstanceIds(0, limit);
    assertStrictlyIncreasing(first.ids);
    if (first.ids.length < 2) return;
    const overlap = await this.listInstanceIds(first.ids.length - 1, limit);
    assertStrictlyIncreasing(overlap.ids);
    if (overlap.ids[0] !== first.ids.at(-1)) {
      throw new Error("Orthanc global instance pagination failed its overlap-order check");
    }
  }

  async getInstance(
    orthancInstanceId: string,
  ): Promise<{ study: StudyObservation; instance: InstanceObservation }> {
    const instanceValue = object(
      await this.#get(`/instances/${encodeURIComponent(orthancInstanceId)}`),
      "Orthanc instance",
    );
    if (typeof instanceValue.ParentSeries !== "string" || !instanceValue.ParentSeries) {
      throw new Error("Orthanc instance is missing ParentSeries");
    }
    const seriesValue = object(
      await this.#get(`/series/${encodeURIComponent(instanceValue.ParentSeries)}`),
      "Orthanc series",
    );
    if (typeof seriesValue.ParentStudy !== "string" || !seriesValue.ParentStudy) {
      throw new Error("Orthanc series is missing ParentStudy");
    }
    const study = await this.getStudy(seriesValue.ParentStudy);
    const seriesTags = object(seriesValue.MainDicomTags, "Orthanc series MainDicomTags");
    const instance = normalizeInstanceObservation(
      { orthancInstanceId, orthancStudyId: study.orthancStudyId },
      study,
      seriesTags.SeriesInstanceUID,
      instanceValue,
    );
    return { study, instance };
  }

  async openInstanceFile(orthancInstanceId: string, signal?: AbortSignal): Promise<Response> {
    const base = this.#baseUrl.href.endsWith("/")
      ? this.#baseUrl
      : new URL(`${this.#baseUrl.href}/`);
    const url = new URL(`instances/${encodeURIComponent(orthancInstanceId)}/file`, base);
    const response = await fetchOrthanc(this.#fetch, url, {
      method: "GET",
      headers: {
        Accept: "application/dicom",
        ...(this.#authorization ? { Authorization: this.#authorization } : {}),
      },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60 * 60 * 1000)])
        : AbortSignal.timeout(60 * 60 * 1000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new OrthancHttpError(response.status, url.pathname);
    }
    if (!response.body) throw new Error("Orthanc instance file response has no body");
    return response;
  }

  async getGlobalInstancePage(offset: number): Promise<{
    pairs: Array<{ study: StudyObservation; instance: InstanceObservation }>;
    done: boolean;
  }> {
    const page = await this.listInstanceIds(offset);
    const pairs = await this.resolveInstances(page.ids);
    return { pairs, done: page.done };
  }

  resolveInstances(ids: readonly string[]): Promise<
    Array<{
      study: StudyObservation;
      instance: InstanceObservation;
    }>
  > {
    return mapConcurrent(ids, this.#maxConcurrency, (id) => this.getInstance(id));
  }

  async revalidateKnownInstances(
    targets: readonly RevalidationTarget[],
  ): Promise<Array<{ target: RevalidationTarget; present: boolean }>> {
    return mapConcurrent(targets, this.#maxConcurrency, async (target) => {
      try {
        const result = await this.getInstance(target.orthancInstanceId);
        if (
          result.instance.sopInstanceUid !== target.sopInstanceUid ||
          result.instance.studyInstanceUid !== target.studyInstanceUid
        ) {
          throw new Error("Orthanc revalidation changed a stored DICOM UID identity");
        }
        return { target, present: true };
      } catch (error) {
        if (error instanceof OrthancHttpError && error.status === 404) {
          return { target, present: false };
        }
        throw error;
      }
    });
  }

  async #get(path: string): Promise<unknown> {
    const base = this.#baseUrl.href.endsWith("/")
      ? this.#baseUrl
      : new URL(`${this.#baseUrl.href}/`);
    const route = path.replace(/^\//, "");
    const url = new URL(route, base);
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
      throw new OrthancHttpError(response.status, url.pathname);
    }
    return readBoundedJson(response, responseLimit(path));
  }

  #assertOffset(offset: number): void {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("inventory offset must be a non-negative safe integer");
  }
}

function assertStrictlyIncreasing(ids: readonly string[]): void {
  for (let index = 1; index < ids.length; index += 1) {
    if (ids[index - 1]! >= ids[index]!) {
      throw new Error("Orthanc global instance IDs must be strictly increasing");
    }
  }
}
