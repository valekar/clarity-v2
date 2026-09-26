import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { parsePollIntervalMinutes } from "./poll-interval.js";

export const MAX_CONFIG_BYTES = 16 * 1024;
export const MAX_CONFIG_UPDATE_BYTES = 4 * 1024;

const allowedKeys = new Set([
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

export type PrivateRuntimeConfig = Record<string, string>;

export function configPathFromArgs(args: readonly string[]): string | null {
  if (args.length === 0) return null;
  if (args.length !== 2 || args[0] !== "--config" || !isAbsolute(args[1]!)) {
    throw new Error("configuration arguments are invalid");
  }
  return args[1]!;
}

export function validatePrivateRuntimeConfig(value: unknown): PrivateRuntimeConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("configuration file is invalid");
  }
  const environment: PrivateRuntimeConfig = {};
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
    if (key === "CLARITY_SYNC_POLL_INTERVAL_MINUTES") {
      try {
        parsePollIntervalMinutes(field);
      } catch {
        throw new Error("configuration file contains an invalid poll interval");
      }
    }
    if (key === "CLARITY_SYNC_SYNTHETIC_POLL_INTERVAL_SECONDS" && field !== "5") {
      throw new Error("configuration file contains an invalid synthetic poll interval");
    }
    environment[key] = field;
  }
  return environment;
}

function parseConfigContents(contents: Buffer): NodeJS.ProcessEnv {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(contents)) as unknown;
  } catch {
    throw new Error("configuration file is invalid");
  }
  return validatePrivateRuntimeConfig(value);
}

async function readPrivateConfig(
  path: string,
  platform: NodeJS.Platform,
): Promise<PrivateRuntimeConfig> {
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
    return validatePrivateRuntimeConfig(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(contents)),
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("configuration file")) throw error;
    throw new Error("configuration file could not be read safely");
  } finally {
    await handle?.close();
  }
}

/**
 * Merge allowlisted settings into a private per-user config file atomically.
 * Keep the parent directory dedicated to the sync service (for example
 * `<userData>/sync-service`) and private to the current OS user.
 */
export async function writePrivateRuntimeConfig(
  path: string,
  updates: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (!isAbsolute(path)) throw new Error("configuration path must be absolute");
  if (Object.keys(updates).length === 0) throw new Error("configuration update is empty");

  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("configuration directory is unsafe");
  }
  if (platform !== "win32" && (directoryStat.mode & 0o077) !== 0) {
    throw new Error("configuration directory permissions are too broad");
  }
  if (typeof process.getuid === "function" && directoryStat.uid !== process.getuid()) {
    throw new Error("configuration directory is not owned by the current user");
  }

  const existing = await lstat(path).catch(() => null);
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error("configuration file is unsafe");
  }
  if (existing && platform !== "win32" && (existing.mode & 0o077) !== 0) {
    throw new Error("configuration file permissions are too broad");
  }

  const previous = existing ? await readPrivateConfig(path, platform) : {};
  const merged = { ...previous, ...updates };
  if (Object.hasOwn(updates, "CLARITY_SYNC_POLL_INTERVAL_MINUTES")) {
    delete merged.CLARITY_SYNC_SYNTHETIC_POLL_INTERVAL_SECONDS;
  }
  const next = validatePrivateRuntimeConfig(merged);
  const bytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`, "utf8");
  if (bytes.byteLength > MAX_CONFIG_BYTES) throw new Error("configuration file is too large");

  const temporary = join(directory, `.config-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;

    const current = await lstat(path).catch(() => null);
    if (existing && (!current || current.dev !== existing.dev || current.ino !== existing.ino)) {
      throw new Error("configuration file changed while it was being updated");
    }
    if (!existing && current)
      throw new Error("configuration file appeared while it was being created");
    await rename(temporary, path);
    // Directory fsync is supported on macOS/Linux; ignore unsupported platforms.
    const directoryHandle = await open(directory, constants.O_RDONLY).catch(() => null);
    if (directoryHandle) {
      await directoryHandle.sync().catch(() => undefined);
      await directoryHandle.close().catch(() => undefined);
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

export async function readPrivateConfigUpdate(
  stream: AsyncIterable<Uint8Array>,
): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > MAX_CONFIG_UPDATE_BYTES) throw new Error("configuration update is too large");
    chunks.push(bytes);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new Error("configuration update is invalid");
  }
  const validated = validatePrivateRuntimeConfig(value);
  const editableKeys = new Set([
    "CLARITY_ORTHANC_URL",
    "CLARITY_ORTHANC_AUTHORIZATION",
    "CLARITY_SYNC_POLL_INTERVAL_MINUTES",
  ]);
  if (
    Object.keys(validated).length === 0 ||
    Object.keys(validated).some((key) => !editableKeys.has(key))
  ) {
    throw new Error("configuration update contains a non-editable setting");
  }
  return validated;
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
