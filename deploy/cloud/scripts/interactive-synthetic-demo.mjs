import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function localEnvironment(extra = {}) {
  const names = [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "SYSTEMROOT",
    "APPDATA",
    "LOCALAPPDATA",
  ];
  const base = Object.fromEntries(
    names
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
  return { ...base, ...extra };
}

async function writePrivateJson(path, value) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  const existing = await lstat(path).catch(() => null);
  if (existing?.isSymbolicLink())
    throw new Error("Demo credential file cannot be a symbolic link.");
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

async function hasSource(configPath) {
  try {
    const value = JSON.parse(await readFile(configPath, "utf8"));
    return (
      typeof value.CLARITY_ORTHANC_URL === "string" &&
      value.CLARITY_ORTHANC_URL.length > 0 &&
      typeof value.CLARITY_ORTHANC_AUTHORIZATION === "string" &&
      value.CLARITY_ORTHANC_AUTHORIZATION.startsWith("Basic ")
    );
  } catch {
    return false;
  }
}

/** Run the local synthetic source, Hanko demo account, Electron UI and config watcher. */
export async function runInteractiveSyntheticDemo(options) {
  const {
    startSourceOrthanc,
    getSourceUrl,
    sourceOrthancPassword,
    prepareSource,
    sourceId,
    databasePath,
    spoolDirectory,
    webUrl,
    dashboardUrl,
    hankoUrl,
    mailpitUrl,
    configPath,
    configWriterPath,
    manifestPath,
    adminPath,
    staffPath,
    nodePath,
    electronEnabled,
    repoRoot,
    pnpm,
    launchService,
    stopService,
  } = options;
  if (!adminPath || !staffPath) throw new Error("Synthetic Hanko account records are missing.");
  await startSourceOrthanc();
  const deviceAuthorization = prepareSource();
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(configPath), 0o700);
  const previous = await lstat(configPath).catch(() => null);
  if (previous?.isSymbolicLink()) throw new Error("Demo sync config cannot be a symbolic link.");
  const runDirectory = dirname(databasePath);
  const initialConfig = {
    CLARITY_SYNC_SOURCE_KEY: sourceId,
    CLARITY_SYNC_STATE_DB: databasePath,
    CLARITY_SYNC_SPOOL_DIR: spoolDirectory,
    CLARITY_INGESTION_API_URL: webUrl,
    CLARITY_DEVICE_AUTHORIZATION: deviceAuthorization,
    CLARITY_SYNC_ALLOW_INSECURE_LOCALHOST: "1",
    CLARITY_SYNC_POLL_INTERVAL_MINUTES: "5",
  };
  await writePrivateJson(configPath, initialConfig);
  await chmod(runDirectory, 0o700);
  const admin = JSON.parse(await readFile(adminPath, "utf8"));
  const staff = JSON.parse(await readFile(staffPath, "utf8"));
  const sourceUrl = getSourceUrl();
  const desktopProfilePath = join(dirname(configPath), "electron-profile");
  const manifest = {
    syntheticDataOnly: true,
    dashboardOrigin: dashboardUrl,
    hankoOrigin: hankoUrl,
    mailpitUrl,
    adminSignInEmail: admin.email,
    staffSignInEmail: staff.email,
    syncConfigPath: configPath,
    desktopProfilePath,
    syncConfigWriter: configWriterPath,
    sourceOrthanc: {
      url: sourceUrl,
      username: "proof",
      password: sourceOrthancPassword,
      note: "Synthetic source; localhost only. Use the Electron Settings form or upload helper.",
    },
  };
  await writePrivateJson(manifestPath, manifest);

  process.stdout.write("\nInteractive synthetic Clarity V2 demo is ready.\n");
  process.stdout.write(`Dashboard: ${dashboardUrl}\nHanko: ${hankoUrl}\nMailpit: ${mailpitUrl}\n`);
  process.stdout.write(`Synthetic source Orthanc: ${sourceUrl}\n`);
  process.stdout.write(`Hanko administrator sign-in email: ${admin.email}\n`);
  process.stdout.write(`Private settings and credentials: ${manifestPath} (mode 0600)\n`);
  process.stdout.write(
    `Sync config: ${configPath} (mode 0600; Orthanc URL and authorization are intentionally blank until Settings Save)\n`,
  );
  process.stdout.write(
    `To reopen Electron while this demo runs: CLARITY_DASHBOARD_ORIGIN=${shellQuote(dashboardUrl)} CLARITY_HANKO_ORIGIN=${shellQuote(hankoUrl)} CLARITY_ALLOW_LOOPBACK_HTTP=1 CLARITY_SYNC_CONFIG_PATH=${shellQuote(configPath)} CLARITY_SYNC_CONFIG_WRITER=${shellQuote(configWriterPath)} CLARITY_NODE_EXECUTABLE=${shellQuote(nodePath)} CLARITY_SYNTHETIC_DEMO=true CLARITY_DESKTOP_PROFILE_DIR=${shellQuote(desktopProfilePath)} pnpm --filter @clarity/desktop start\n`,
  );
  process.stdout.write(
    "Sign in with the administrator email; open Mailpit to read its one-time passcode. Enter the synthetic source URL and proof/provided password in Settings, then Save.\n",
  );
  process.stdout.write(
    `Upload a generated study with: python3 deploy/cloud/scripts/upload-synthetic-dicom.py ${shellQuote(manifestPath)} [ct|mr|sr|pdf] [SYNTHETIC_LABEL]\nThe sync service uses the saved interval in Settings. Press Ctrl-C here to stop this demo and remove only its disposable Docker project.\n\n`,
  );

  let restartTimer;
  let restartQueue = Promise.resolve();
  let electron;
  let stoppingDemo = false;
  let appliedConfig = await readFile(configPath, "utf8");
  const stopRequested = new Promise((resolveStop) => {
    process.once("SIGINT", () => resolveStop());
    process.once("SIGTERM", () => resolveStop());
  });
  const restartOwnedService = async () => {
    if (stoppingDemo) return;
    const currentConfig = await readFile(configPath, "utf8").catch(() => "");
    if (currentConfig === appliedConfig) return;
    appliedConfig = currentConfig;
    await stopService();
    if (!(await hasSource(configPath))) {
      process.stdout.write(
        "Sync service waiting for a saved Orthanc URL and credential in Electron Settings.\n",
      );
      return;
    }
    process.stdout.write("Saved Orthanc settings detected; starting the local sync service.\n");
    launchService();
  };
  const configWatcher = watch(dirname(configPath), (_event, filename) => {
    if (filename && filename.toString() !== configPath.split(/[\\/]/u).at(-1)) return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartQueue = restartQueue.then(restartOwnedService).catch((error) => {
        process.stderr.write(`Could not apply saved sync settings: ${error.message}\n`);
      });
    }, 250);
  });
  try {
    process.stdout.write("Sync service waiting for Settings Save.\n");
    if (electronEnabled) {
      const build = spawn(pnpm, ["--filter", "@clarity/desktop", "build"], {
        cwd: repoRoot,
        env: localEnvironment(),
        stdio: "inherit",
      });
      const buildStatus = await new Promise((resolveStatus, rejectStatus) => {
        build.once("error", rejectStatus);
        build.once("exit", (code) => resolveStatus(code));
      });
      if (buildStatus !== 0) throw new Error("Electron build failed before demo launch.");
      electron = spawn(pnpm, ["--filter", "@clarity/desktop", "start"], {
        cwd: repoRoot,
        env: localEnvironment({
          CLARITY_DASHBOARD_ORIGIN: dashboardUrl,
          CLARITY_HANKO_ORIGIN: hankoUrl,
          CLARITY_ALLOW_LOOPBACK_HTTP: "1",
          CLARITY_SYNC_CONFIG_PATH: configPath,
          CLARITY_SYNC_CONFIG_WRITER: configWriterPath,
          CLARITY_NODE_EXECUTABLE: nodePath,
          CLARITY_SYNTHETIC_DEMO: "true",
          CLARITY_DESKTOP_PROFILE_DIR: desktopProfilePath,
        }),
        stdio: "inherit",
      });
      electron.once("spawn", () =>
        process.stdout.write(
          "Electron process launched with the authenticated dashboard origin.\n",
        ),
      );
      electron.once("error", (error) =>
        process.stderr.write(`Electron could not start: ${error.message}\n`),
      );
      electron.once("exit", (code, signal) => {
        if (!stoppingDemo)
          process.stdout.write(
            `Electron closed (${signal ?? code}). Demo services remain available.\n`,
          );
      });
    }
    await stopRequested;
  } finally {
    stoppingDemo = true;
    clearTimeout(restartTimer);
    configWatcher.close();
    await restartQueue;
    await stopService();
    if (electron && electron.exitCode === null && electron.signalCode === null) {
      electron.kill("SIGTERM");
      await Promise.race([
        new Promise((resolveExit) => electron.once("exit", resolveExit)),
        delay(10_000),
      ]);
    }
  }
  process.stdout.write("Demo launcher stopped its local service and Electron process.\n");
}
