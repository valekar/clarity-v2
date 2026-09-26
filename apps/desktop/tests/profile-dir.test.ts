import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configureDesktopProfile, type ProfilePathName } from "../src/profile-dir.ts";

const uid = typeof process.getuid === "function" ? process.getuid() : undefined;

test("synthetic Electron profile isolates private userData and sessionData before startup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clarity-profile-"));
  try {
    const profile = join(directory, "electron-profile");
    const configured: Array<[ProfilePathName, string]> = [];
    assert.equal(
      configureDesktopProfile(
        { CLARITY_SYNTHETIC_DEMO: "true", CLARITY_DESKTOP_PROFILE_DIR: profile },
        join(directory, "default-user-data"),
        (name, path) => configured.push([name, path]),
        process.platform,
        uid,
      ),
      profile,
    );
    assert.deepEqual(configured, [
      ["userData", profile],
      ["sessionData", join(profile, "session-data")],
    ]);
    assert.equal((await lstat(profile)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(profile, "session-data"))).mode & 0o777, 0o700);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("profile override requires synthetic mode, an absolute path and the dedicated directory name", () => {
  const setPath = () => undefined;
  assert.equal(configureDesktopProfile({}, "/tmp/default", setPath), null);
  assert.throws(
    () =>
      configureDesktopProfile(
        { CLARITY_DESKTOP_PROFILE_DIR: "/tmp/electron-profile" },
        "/tmp/default",
        setPath,
      ),
    /requires CLARITY_SYNTHETIC_DEMO/,
  );
  assert.throws(
    () =>
      configureDesktopProfile(
        {
          CLARITY_SYNTHETIC_DEMO: "true",
          CLARITY_DESKTOP_PROFILE_DIR: "relative/electron-profile",
        },
        "/tmp/default",
        setPath,
      ),
    /absolute path/,
  );
  assert.throws(
    () =>
      configureDesktopProfile(
        { CLARITY_SYNTHETIC_DEMO: "1", CLARITY_DESKTOP_PROFILE_DIR: "/tmp/profile" },
        "/tmp/default",
        setPath,
      ),
    /dedicated electron-profile/,
  );
});

test("rejects insecure or symlinked profile directories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clarity-profile-check-"));
  try {
    const insecure = join(directory, "insecure", "electron-profile");
    await mkdir(insecure, { recursive: true, mode: 0o700 });
    await chmod(insecure, 0o755);
    assert.throws(
      () =>
        configureDesktopProfile(
          { CLARITY_SYNTHETIC_DEMO: "true", CLARITY_DESKTOP_PROFILE_DIR: insecure },
          join(directory, "default"),
          () => undefined,
        ),
      /permissions must be private/,
    );

    const real = join(directory, "real", "electron-profile");
    await mkdir(real, { recursive: true, mode: 0o700 });
    const linked = join(directory, "linked", "electron-profile");
    await mkdir(join(directory, "linked"), { mode: 0o700 });
    await symlink(real, linked, "dir");
    assert.throws(
      () =>
        configureDesktopProfile(
          { CLARITY_SYNTHETIC_DEMO: "true", CLARITY_DESKTOP_PROFILE_DIR: linked },
          join(directory, "default"),
          () => undefined,
        ),
      /real directory/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
