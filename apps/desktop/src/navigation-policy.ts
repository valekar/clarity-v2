const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function trustedOrigin(value: string, allowLoopbackHttp = false): string {
  const url = new URL(value);
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (
    (url.protocol !== "https:" && !(allowLoopbackHttp && loopback && url.protocol === "http:")) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("Dashboard and Hanko settings must be trusted HTTPS origins.");
  }
  return url.origin;
}

export function isTrustedUrl(value: string, origins: ReadonlySet<string>): boolean {
  try {
    const url = new URL(value);
    return origins.has(url.origin);
  } catch {
    return false;
  }
}

export function dashboardSignInUrl(origin: string): string {
  return new URL("/sign-in", origin).href;
}
