import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { spawn } from "node:child_process";

const MAX_CONFIG_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024;
const CONFIG_KEYS = new Set([
  "CLARITY_SYNC_SOURCE_KEY",
  "CLARITY_SYNC_STATE_DB",
  "CLARITY_SYNC_SPOOL_DIR",
  "CLARITY_ORTHANC_URL",
  "CLARITY_ORTHANC_AUTHORIZATION",
  "CLARITY_INGESTION_API_URL",
  "CLARITY_DEVICE_AUTHORIZATION",
  "CLARITY_SYNC_ALLOW_INSECURE_LOCALHOST",
  "CLARITY_SYNC_POLL_INTERVAL_MINUTES",
  "CLARITY_SYNC_SYNTHETIC_POLL_INTERVAL_SECONDS",
]);

export type RuntimeConfig = Readonly<Record<string, string>>;
export type SourceSettings = Readonly<{
  configured: boolean;
  orthancUrl: string;
  pollIntervalMinutes: number;
  syntheticFastPolling: boolean;
}>;

function isLoopback(hostname: string): boolean {
  return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname);
}

export function normalizeOrthancUrl(value: string, allowLoopbackHttp: boolean): string {
  if (value.length > 2048 || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new TypeError("Enter a valid Orthanc server address.");
  }
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    (url.protocol === "http:" && !(allowLoopbackHttp && isLoopback(url.hostname))) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("Orthanc must use HTTPS, or explicitly enabled loopback HTTP.");
  }
  return url.href.replace(/\/$/u, "");
}

export function basicAuthorization(
  username: string,
  password: string,
  previousAuthorization: string | undefined,
  unchangedEndpoint: boolean,
): string {
  if (password === "" && unchangedEndpoint && previousAuthorization) {
    return previousAuthorization;
  }
  if (
    username.length === 0 ||
    username.length > 1024 ||
    username.includes(":") ||
    /[\r\n\u0000]/u.test(username) ||
    password.length > 2048 ||
    /[\r\n\u0000]/u.test(password)
  ) {
    throw new TypeError("Enter the Orthanc username and password.");
  }
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

export function assertSameOrthancIdentity(
  savedUrl: string | undefined,
  candidateUrl: string,
): void {
  if (savedUrl && savedUrl !== candidateUrl) {
    throw new Error(
      "Changing the Orthanc server requires a new source pairing and reconciliation.",
    );
  }
}

export async function readRuntimeConfig(path: string): Promise<RuntimeConfig> {
  const beforeOpen = await lstat(path).catch(() => null);
  if (!beforeOpen?.isFile() || beforeOpen.isSymbolicLink() || beforeOpen.size > MAX_CONFIG_BYTES) {
    throw new Error("Local sync settings are unavailable.");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES || (stat.mode & 0o077) !== 0) {
      throw new Error("Local sync settings are unavailable.");
    }
    const bytes = await handle.readFile();
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Local sync settings are unavailable.");
    }
    const output: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!CONFIG_KEYS.has(key) || typeof value !== "string" || value.length > 4096) {
        throw new Error("Local sync settings are unavailable.");
      }
      output[key] = value;
    }
    return output;
  } catch {
    throw new Error("Local sync settings are unavailable.");
  } finally {
    await handle.close();
  }
}

export async function getSourceSettings(path: string): Promise<SourceSettings> {
  const config = await readRuntimeConfig(path);
  const parsedMinutes = Number(config.CLARITY_SYNC_POLL_INTERVAL_MINUTES ?? "5");
  const pollIntervalMinutes =
    Number.isInteger(parsedMinutes) && parsedMinutes >= 5 && parsedMinutes <= 60
      ? parsedMinutes
      : 5;
  return {
    configured: Boolean(config.CLARITY_ORTHANC_URL),
    orthancUrl: config.CLARITY_ORTHANC_URL ?? "",
    pollIntervalMinutes,
    syntheticFastPolling: config.CLARITY_SYNC_SYNTHETIC_POLL_INTERVAL_SECONDS === "5",
  };
}

export async function testOrthanc(
  orthancUrl: string,
  authorization: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetcher(new URL("system", `${orthancUrl.replace(/\/$/u, "")}/`), {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { authorization, accept: "application/json", "cache-control": "no-store" },
    });
    const length = Number(response.headers.get("content-length"));
    if (length > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      return false;
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      return false;
    }
    const reader = response.body.getReader();
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          return false;
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof (value as { Name?: unknown }).Name === "string" &&
      typeof (value as { Version?: unknown }).Version === "string" &&
      typeof (value as { DicomAet?: unknown }).DicomAet === "string" &&
      Number.isInteger((value as { ApiVersion?: unknown }).ApiVersion) &&
      Number.isInteger((value as { HttpPort?: unknown }).HttpPort)
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function writeSourceSettings(
  configPath: string,
  writerPath: string,
  nodePath: string,
  patch: Readonly<Record<string, string>>,
): Promise<void> {
  if (!isAbsolute(configPath) || !isAbsolute(writerPath) || !isAbsolute(nodePath)) {
    throw new Error("Local sync settings are unavailable.");
  }
  const parent = dirname(configPath);
  const info = await lstat(parent).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error("Local sync settings folder must be private to this user.");
  }
  const child = spawn(nodePath, [writerPath, "--write-config", configPath], {
    stdio: ["pipe", "ignore", "ignore"],
    env: { PATH: process.env.PATH ?? "" },
    windowsHide: true,
  });
  const result = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Local settings save timed out."));
    }, 5_000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Local sync settings could not be saved."));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error("Local sync settings could not be saved."));
    });
  });
  child.stdin.end(JSON.stringify(patch));
  await result;
}
