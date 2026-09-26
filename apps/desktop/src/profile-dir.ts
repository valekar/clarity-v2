import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const DEMO_FLAG = "CLARITY_SYNTHETIC_DEMO";
const PROFILE_VARIABLE = "CLARITY_DESKTOP_PROFILE_DIR";

export type ProfilePathName = "userData" | "sessionData";

function syntheticDemoEnabled(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

function createPrivateDirectory(
  path: string,
  platform: NodeJS.Platform,
  uid: number | undefined,
): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("desktop profile directory is not a real directory");
  }
  if (platform !== "win32") {
    if ((info.mode & 0o077) !== 0) {
      throw new Error("desktop profile directory permissions must be private");
    }
    if (uid !== undefined && info.uid !== uid) {
      throw new Error("desktop profile directory must belong to the current user");
    }
    chmodSync(path, 0o700);
  }
}

/** Configure isolated Electron profile storage before Electron becomes ready. */
export function configureDesktopProfile(
  environment: Readonly<Record<string, string | undefined>>,
  defaultUserDataPath: string,
  setPath: (name: ProfilePathName, path: string) => void,
  platform: NodeJS.Platform = process.platform,
  uid: number | undefined = typeof process.getuid === "function" ? process.getuid() : undefined,
): string | null {
  const requestedPath = environment[PROFILE_VARIABLE]?.trim();
  const enabled = syntheticDemoEnabled(environment[DEMO_FLAG]);
  if (!requestedPath && !enabled) return null;
  if (!enabled || !requestedPath || !/^(?:\/|[A-Za-z]:\\)/u.test(requestedPath)) {
    throw new Error(`${PROFILE_VARIABLE} requires ${DEMO_FLAG}=true (or 1) and an absolute path`);
  }

  const profilePath = resolve(requestedPath);
  if (
    profilePath === resolve(defaultUserDataPath) ||
    basename(profilePath) !== "electron-profile"
  ) {
    throw new Error("synthetic desktop profile must use its dedicated electron-profile directory");
  }
  const sessionDataPath = join(profilePath, "session-data");
  createPrivateDirectory(profilePath, platform, uid);
  createPrivateDirectory(sessionDataPath, platform, uid);
  setPath("userData", profilePath);
  setPath("sessionData", sessionDataPath);
  return profilePath;
}
