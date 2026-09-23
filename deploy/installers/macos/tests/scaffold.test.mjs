import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("..", import.meta.url));
const plist = join(here, "templates/org.clarity-v2.sync-service.plist.in");
const build = join(here, "build-pkg.sh");
const activate = join(here, "activate-release.sh");
const uninstall = join(here, "uninstall-preserve-data.sh");

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

test("LaunchDaemon plist parses and declares the dedicated system identity and private paths", () => {
  const result = run("/usr/bin/plutil", ["-lint", plist]);
  assert.equal(result.status, 0, result.stderr);
  const text = readFile(plist, "utf8");
  return text.then((value) => {
    assert.match(value, /<key>UserName<\/key><string>_clarity-sync<\/string>/);
    assert.match(value, /<key>GroupName<\/key><string>_clarity-sync<\/string>/);
    assert.match(value, /<key>Umask<\/key><integer>63<\/integer>/);
    assert.match(value, /<key>ThrottleInterval<\/key><integer>60<\/integer>/);
    assert.match(value, /\/var\/db\/clarity-v2\/sync-service/);
    assert.match(value, /\/var\/log\/clarity-v2\/sync-service/);
  });
});

test("pkgbuild creates a disposable package from a standalone release fixture", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarity-macos-pkg-test-"));
  try {
    const release = join(root, "release");
    const nodePath = join(release, "runtime/bin/node");
    await mkdir(join(release, "runtime/bin"), { recursive: true });
    await mkdir(join(release, "app"), { recursive: true });
    await writeFile(nodePath, '#!/bin/sh\nprintf "%s\\n" v22.20.0\n');
    await chmod(nodePath, 0o755);
    await writeFile(join(release, "app/main.js"), "process.exitCode = 78;\n");
    await writeFile(join(release, "app/package.json"), '{"type":"module"}\n');
    const output = join(root, "ClaritySync-0.1.0.pkg");
    assert.equal(run(build, ["../0.1.0", release, output]).status, 64);
    const result = run(build, ["0.1.0", release, output]);
    assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
    const files = run("/usr/sbin/pkgutil", ["--payload-files", output]);
    assert.equal(files.status, 0, files.stderr);
    assert.match(
      files.stdout,
      /SyncService\/installer\/org\.clarity-v2\.sync-service\.plist\.template/,
    );
    assert.doesNotMatch(
      files.stdout,
      /Library\/LaunchDaemons\/org\.clarity-v2\.sync-service\.plist$/,
    );
    assert.match(files.stdout, /SyncService\/releases\/0\.1\.0\/app\/main\.js/);
    assert.match(files.stdout, /SyncService\/installer\/uninstall-preserve-data\.sh/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release switch, rollback, and uninstall preserve the queue and spool data", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarity-macos-upgrade-test-"));
  try {
    const base = join(root, "Library/Application Support/ClarityV2/SyncService");
    await mkdir(join(base, "releases/1.0.0"), { recursive: true });
    await mkdir(join(base, "releases/1.1.0"), { recursive: true });
    await writeFile(join(base, "releases/1.0.0/main.js"), "old\n");
    await writeFile(join(base, "releases/1.1.0/main.js"), "new\n");
    const database = join(root, "var/db/clarity-v2/sync-service/checkpoint.sqlite");
    const spool = join(root, "var/db/clarity-v2/sync-service/spool/item.spool");
    await mkdir(join(root, "var/log/clarity-v2/sync-service"), { recursive: true });
    await mkdir(join(root, "Library/LaunchDaemons"), { recursive: true });
    await mkdir(join(root, "var/db/clarity-v2/sync-service/spool"), { recursive: true });
    await writeFile(database, "synthetic-queue-state\n");
    await writeFile(spool, "synthetic-spooled-bytes\n");
    await writeFile(
      join(root, "var/db/clarity-v2/sync-service/config.json"),
      '{"synthetic":"configuration"}\n',
    );
    await writeFile(
      join(root, "Library/LaunchDaemons/org.clarity-v2.sync-service.plist"),
      "synthetic launchd config\n",
    );

    assert.equal(run(activate, [root, "1.0.0"]).status, 0);
    assert.equal(await readFile(join(base, "current/main.js"), "utf8"), "old\n");
    assert.equal(run(activate, [root, "9.9.9"]).status, 66);
    assert.equal(run(activate, [root, ".."]).status, 64);
    assert.equal(run(activate, [root, ".hidden"]).status, 64);
    assert.equal(await readFile(join(base, "current/main.js"), "utf8"), "old\n");
    assert.equal(run(activate, [root, "1.1.0"]).status, 0);
    assert.equal(await readFile(join(base, "current/main.js"), "utf8"), "new\n");
    assert.equal(run(activate, [root, "1.0.0"]).status, 0);
    assert.equal(await readFile(join(base, "current/main.js"), "utf8"), "old\n");

    assert.equal(run(uninstall, [root]).status, 0);
    await assert.rejects(lstat(join(base, "current")));
    await assert.rejects(lstat(join(base, "releases")));
    await assert.rejects(
      lstat(join(root, "Library/LaunchDaemons/org.clarity-v2.sync-service.plist")),
    );
    assert.equal(await readFile(database, "utf8"), "synthetic-queue-state\n");
    assert.equal(await readFile(spool, "utf8"), "synthetic-spooled-bytes\n");
    assert.equal(
      await readFile(join(root, "var/db/clarity-v2/sync-service/config.json"), "utf8"),
      '{"synthetic":"configuration"}\n',
    );
    assert.equal((await stat(join(root, "var/log/clarity-v2/sync-service"))).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("system mutation requires an explicit operator opt-in", () => {
  const activation = run(activate, ["/", "0.1.0"], {
    env: { ...process.env, CLARITY_ALLOW_SYSTEM_MUTATION: "" },
  });
  assert.equal(activation.status, 77);
  assert.match(activation.stderr, /system root requires/);
  const removal = run(uninstall, ["/"], {
    env: { ...process.env, CLARITY_ALLOW_SYSTEM_MUTATION: "" },
  });
  assert.equal(removal.status, 77);
  assert.match(removal.stderr, /system root requires/);
});
