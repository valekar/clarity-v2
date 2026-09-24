import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";

export const MAX_CONFIG_BYTES = 16 * 1024;

const allowedKeys = new Set([
  "CLARITY_SYNC_SOURCE_KEY",
  "CLARITY_SYNC_STATE_DB",
  "CLARITY_SYNC_SPOOL_DIR",
  "CLARITY_ORTHANC_URL",
  "CLARITY_ORTHANC_AUTHORIZATION",
  "CLARITY_INGESTION_API_URL",
  "CLARITY_DEVICE_AUTHORIZATION",
  "CLARITY_SYNC_ALLOW_INSECURE_LOCALHOST",
]);

export function configPathFromArgs(args: readonly string[]): string | null {
  if (args.length === 0) return null;
  if (args.length !== 2 || args[0] !== "--config" || !isAbsolute(args[1]!)) {
    throw new Error("configuration arguments are invalid");
  }
  return args[1]!;
}

function parseConfigContents(contents: Buffer): NodeJS.ProcessEnv {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(contents)) as unknown;
  } catch {
    throw new Error("configuration file is invalid");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("configuration file is invalid");
  }
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, field] of Object.entries(value)) {
    if (!allowedKeys.has(key) || typeof field !== "string" || field.length > 4096) {
      throw new Error("configuration file contains an unsupported setting");
    }
    if (
      (key === "CLARITY_SYNC_STATE_DB" || key === "CLARITY_SYNC_SPOOL_DIR") &&
      !isAbsolute(field)
    ) {
      throw new Error("configuration file contains a relative private-data path");
    }
    if (key === "CLARITY_SYNC_ALLOW_INSECURE_LOCALHOST" && field !== "0" && field !== "1") {
      throw new Error("configuration file contains an invalid loopback setting");
    }
    environment[key] = field;
  }
  return environment;
}

export async function loadRuntimeEnvironment(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<NodeJS.ProcessEnv> {
  const path = configPathFromArgs(args);
  if (!path) return { ...environment };

  const beforeOpen = await lstat(path).catch(() => null);
  if (!beforeOpen?.isFile() || beforeOpen.isSymbolicLink() || beforeOpen.size > MAX_CONFIG_BYTES) {
    throw new Error("configuration file is missing, unsafe, or too large");
  }
  if (
    platform === "darwin" &&
    ((beforeOpen.mode & 0o400) === 0 || (beforeOpen.mode & 0o077) !== 0)
  ) {
    throw new Error("configuration file permissions are too broad");
  }

  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const noFollow = platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
    handle = await open(path, constants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_CONFIG_BYTES) {
      throw new Error("configuration file is missing, unsafe, or too large");
    }
    if (platform === "darwin" && ((opened.mode & 0o400) === 0 || (opened.mode & 0o077) !== 0)) {
      throw new Error("configuration file permissions are too broad");
    }
    const contents = await handle.readFile();
    if (contents.byteLength > MAX_CONFIG_BYTES) {
      throw new Error("configuration file is missing, unsafe, or too large");
    }
    const fileEnvironment = parseConfigContents(contents);
    return { ...environment, ...fileEnvironment };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("configuration file")) throw error;
    throw new Error("configuration file could not be read safely");
  } finally {
    await handle?.close();
  }
}
