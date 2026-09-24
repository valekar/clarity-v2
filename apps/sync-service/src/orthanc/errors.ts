export class OrthancUnavailableError extends Error {
  constructor() {
    super("Orthanc is unavailable");
    this.name = "OrthancUnavailableError";
  }
}

export async function fetchOrthanc(
  fetchImpl: typeof fetch,
  input: URL | string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetchImpl(input, init);
  } catch {
    throw new OrthancUnavailableError();
  }
}
