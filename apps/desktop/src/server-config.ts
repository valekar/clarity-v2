import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

const CONFIG_NAME = "server.json";
const MAX_CONFIG_BYTES = 4 * 1024;

export type ServerConfig = Readonly<{ dashboardOrigin: string; hankoOrigin: string }>;

function normalizedOrigin(value: string, allowLoopbackHttp: boolean): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(allowLoopbackHttp && loopback && url.protocol === "http:")) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("Server addresses must be trusted HTTPS origins.");
  }
  return url.origin;
}

export function parseServerConfig(value: unknown, allowLoopbackHttp = false): ServerConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Server settings are invalid.");
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 2 ||
    typeof input.dashboardOrigin !== "string" ||
    typeof input.hankoOrigin !== "string"
  ) {
    throw new TypeError("Enter both the Clarity dashboard and Hanko server addresses.");
  }
  return Object.freeze({
    dashboardOrigin: normalizedOrigin(input.dashboardOrigin, allowLoopbackHttp),
    hankoOrigin: normalizedOrigin(input.hankoOrigin, allowLoopbackHttp),
  });
}

export async function readServerConfig(
  directory: string,
  allowLoopbackHttp = false,
): Promise<ServerConfig | null> {
  const path = join(directory, CONFIG_NAME);
  const beforeOpen = await lstat(path).catch(() => null);
  if (!beforeOpen) return null;
  if (!beforeOpen.isFile() || beforeOpen.isSymbolicLink() || beforeOpen.size > MAX_CONFIG_BYTES) {
    throw new Error("Saved server settings are unsafe.");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES || (stat.mode & 0o077) !== 0) {
      throw new Error("Saved server settings are unsafe.");
    }
    const data = await handle.readFile();
    if (data.byteLength > MAX_CONFIG_BYTES) throw new Error("Saved server settings are unsafe.");
    return parseServerConfig(JSON.parse(data.toString("utf8")) as unknown, allowLoopbackHttp);
  } catch {
    throw new Error("Saved server settings are invalid.");
  } finally {
    await handle.close();
  }
}

export async function saveServerConfig(
  directory: string,
  rawConfig: unknown,
  allowLoopbackHttp = false,
): Promise<ServerConfig> {
  const config = parseServerConfig(rawConfig, allowLoopbackHttp);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, CONFIG_NAME);
  const temporary = `${path}.${process.pid}.tmp`;
  const body = Buffer.from(JSON.stringify(config), "utf8");
  if (body.byteLength > MAX_CONFIG_BYTES) throw new Error("Server settings are too large.");
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    await handle.writeFile(body);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
    return config;
  } catch {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw new Error("Server settings could not be saved.");
  }
}
