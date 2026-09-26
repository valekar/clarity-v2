import { app, BrowserWindow, ipcMain, session } from "electron";
import { fileURLToPath } from "node:url";
import {
  dashboardSignInUrl,
  isHostedSettingsUrl,
  isTrustedUrl,
  sourceSectionUrl,
  trustedOrigin,
} from "./navigation-policy.js";
import { createDeviceAdminBridge } from "./device-admin-bridge.js";
import { readServerConfig, saveServerConfig } from "./server-config.js";
import {
  basicAuthorization,
  assertSameOrthancIdentity,
  getSourceSettings,
  normalizeOrthancUrl,
  readRuntimeConfig,
  testOrthanc,
  writeSourceSettings,
} from "./source-settings.js";
import { join } from "node:path";
import { configureDesktopProfile } from "./profile-dir.js";

const STAFF_PARTITION = "persist:clarity-v2-staff";

let profileConfigurationFailed = false;
try {
  configureDesktopProfile(process.env, app.getPath("userData"), (name, path) => {
    app.setPath(name, path);
  });
} catch {
  profileConfigurationFailed = true;
  process.stderr.write("synthetic Electron profile is missing or not private; desktop stopped\n");
}

function loopbackHttpEnabled(): boolean {
  return ["1", "true"].includes(process.env.CLARITY_ALLOW_LOOPBACK_HTTP?.trim() ?? "");
}

async function readSmallJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel();
    throw new Error("response-too-large");
  }
  if (!response.body) throw new Error("response-body-missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytesRead += part.value.byteLength;
      if (bytesRead > maximumBytes) {
        await reader.cancel();
        throw new Error("response-too-large");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

async function staffOrigins(): Promise<ReadonlySet<string> | null> {
  const dashboard = process.env.CLARITY_DASHBOARD_ORIGIN?.trim();
  const hanko = process.env.CLARITY_HANKO_ORIGIN?.trim();
  if (!dashboard && !hanko) {
    const saved = await readServerConfig(app.getPath("userData"), loopbackHttpEnabled()).catch(
      () => null,
    );
    return saved ? new Set([saved.dashboardOrigin, saved.hankoOrigin]) : null;
  }
  if (!dashboard || !hanko) throw new Error("Both dashboard and Hanko origins are required.");
  const allowLoopback = loopbackHttpEnabled();
  return new Set([trustedOrigin(dashboard, allowLoopback), trustedOrigin(hanko, allowLoopback)]);
}

async function openScaffoldWindow(): Promise<void> {
  const allowLoopback = loopbackHttpEnabled();
  let origins: ReadonlySet<string> | null;
  let dashboard: string | undefined;
  let hanko: string | undefined;
  try {
    origins = await staffOrigins();
    if (origins) {
      const configuredDashboard = process.env.CLARITY_DASHBOARD_ORIGIN?.trim();
      const configuredHanko = process.env.CLARITY_HANKO_ORIGIN?.trim();
      if (configuredDashboard && configuredHanko) {
        dashboard = trustedOrigin(configuredDashboard, allowLoopback);
        hanko = trustedOrigin(configuredHanko, allowLoopback);
      } else {
        const saved = await readServerConfig(app.getPath("userData"), allowLoopback);
        dashboard = saved?.dashboardOrigin;
        hanko = saved?.hankoOrigin;
      }
    }
  } catch {
    app.exit(1);
    return;
  }
  const staffSession = origins ? session.fromPartition(STAFF_PARTITION) : undefined;
  if (dashboard && hanko && origins && staffSession) {
    const dashboardOrigin = trustedOrigin(dashboard, loopbackHttpEnabled());
    const hankoOrigin = trustedOrigin(hanko, loopbackHttpEnabled());
    const cookieName = process.env.HANKO_COOKIE_NAME?.trim() || "hanko";
    const bridge = createDeviceAdminBridge({
      dashboardOrigin,
      cookieName,
      async getHankoCookie() {
        const cookies = await staffSession.cookies.get({ url: hankoOrigin, name: cookieName });
        return cookies.length === 1 ? (cookies[0]?.value ?? null) : null;
      },
    });
    ipcMain.removeHandler("clarity-device-admin");
    ipcMain.handle("clarity-device-admin", (event, request: unknown) => {
      const frame = event.senderFrame;
      return bridge.invoke(
        frame?.url ?? "",
        frame !== null && frame === event.sender.mainFrame,
        request,
      );
    });
  }
  const window = new BrowserWindow({
    width: 980,
    height: 700,
    minWidth: 620,
    minHeight: 460,
    frame: true,
    titleBarStyle: "default",
    resizable: true,
    minimizable: true,
    maximizable: true,
    closable: true,
    fullscreenable: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      partition: STAFF_PARTITION,
      preload: fileURLToPath(new URL("../static/preload.cjs", import.meta.url)),
    },
  });
  if (process.platform === "darwin") window.setWindowButtonVisibility(true);

  const setupPath = fileURLToPath(new URL("../static/index.html", import.meta.url));
  const isSetupPage = (event: Electron.IpcMainInvokeEvent): boolean => {
    const frame = event.senderFrame;
    if (!frame || frame !== event.sender.mainFrame) return false;
    try {
      return fileURLToPath(frame.url) === setupPath;
    } catch {
      return false;
    }
  };
  ipcMain.removeHandler("clarity-desktop-setup-read");
  ipcMain.handle("clarity-desktop-setup-read", async (event) => {
    if (!isSetupPage(event)) return { ok: false, error: "forbidden" };
    const saved = await readServerConfig(app.getPath("userData"), allowLoopback).catch(() => null);
    return {
      ok: true,
      dashboardOrigin: dashboard ?? saved?.dashboardOrigin ?? "",
      hankoOrigin: hanko ?? saved?.hankoOrigin ?? "",
      managed: Boolean(process.env.CLARITY_DASHBOARD_ORIGIN && process.env.CLARITY_HANKO_ORIGIN),
    };
  });
  ipcMain.removeHandler("clarity-desktop-setup-save");
  ipcMain.handle("clarity-desktop-setup-save", async (event, input: unknown) => {
    if (!isSetupPage(event)) return { ok: false, error: "forbidden" };
    if (process.env.CLARITY_DASHBOARD_ORIGIN || process.env.CLARITY_HANKO_ORIGIN) {
      return { ok: false, error: "managed" };
    }
    try {
      await saveServerConfig(app.getPath("userData"), input, allowLoopback);
      app.relaunch();
      setTimeout(() => app.exit(0), 100);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Server settings could not be saved.",
      };
    }
  });
  ipcMain.removeHandler("clarity-desktop-setup-retry");
  ipcMain.handle("clarity-desktop-setup-retry", async (event) => {
    if (!isSetupPage(event)) return { ok: false, error: "forbidden" };
    if (!dashboard) return { ok: false, error: "unavailable" };
    try {
      await window.loadURL(dashboardSignInUrl(dashboard));
      return { ok: true };
    } catch {
      await window.loadFile(setupPath, { query: { error: "unavailable" } });
      return { ok: false, error: "unavailable" };
    }
  });

  if (staffSession) {
    staffSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  }

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!origins || !isTrustedUrl(url, origins)) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!origins || !isTrustedUrl(url, origins)) event.preventDefault();
  });

  if (origins && staffSession) {
    staffSession.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*"] },
      (details, done) => {
        done({ cancel: !isTrustedUrl(details.url, origins) });
      },
    );
  }

  const authorizeAdmin = async (): Promise<boolean> => {
    if (!dashboard || !hanko || !staffSession) return false;
    const cookieName = process.env.HANKO_COOKIE_NAME?.trim() || "hanko";
    const cookies = await staffSession.cookies.get({ url: hanko, name: cookieName });
    const cookie = cookies.length === 1 ? (cookies[0]?.value ?? null) : null;
    if (!cookie || /[\r\n;]/.test(cookie)) return false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(new URL("/api/device-admin/authorize", dashboard), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "cache-control": "no-store",
          cookie: `${cookieName}=${cookie}`,
          origin: dashboard,
        },
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        return false;
      }
      const value = await readSmallJson(response, 8 * 1024);
      return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.keys(value).length === 1 &&
        (value as { authorized?: unknown }).authorized === true
      );
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  };

  const sourceSettingsPath = fileURLToPath(
    new URL("../static/source-settings.html", import.meta.url),
  );
  const syncConfigPath = (): string => {
    const configuredPath = process.env.CLARITY_SYNC_CONFIG_PATH?.trim();
    return configuredPath || join(app.getPath("userData"), "sync-service", "config.json");
  };
  const isSourceSettingsPage = (event: Electron.IpcMainInvokeEvent): boolean => {
    const frame = event.senderFrame;
    if (event.sender !== window.webContents || !frame || frame !== event.sender.mainFrame)
      return false;
    try {
      return fileURLToPath(frame.url) === sourceSettingsPath;
    } catch {
      return false;
    }
  };
  const isHostedMainFrame = (event: Electron.IpcMainInvokeEvent): boolean => {
    const frame = event.senderFrame;
    if (event.sender !== window.webContents || !frame || frame !== event.sender.mainFrame)
      return false;
    return Boolean(dashboard && isHostedSettingsUrl(frame.url, dashboard));
  };
  ipcMain.removeHandler("clarity-source-settings-open");
  ipcMain.handle("clarity-source-settings-open", async (event) => {
    if (!isHostedMainFrame(event)) return { ok: false, error: "forbidden" };
    if (!(await authorizeAdmin())) return { ok: false, error: "admin_required" };
    if (!isHostedMainFrame(event)) return { ok: false, error: "forbidden" };
    try {
      await window.loadFile(sourceSettingsPath);
      return { ok: true };
    } catch {
      return { ok: false, error: "unavailable" };
    }
  });

  ipcMain.removeHandler("clarity-source-settings-navigate");
  ipcMain.handle("clarity-source-settings-navigate", async (event, section: unknown) => {
    if (!isSourceSettingsPage(event)) return { ok: false, error: "forbidden" };
    if (!dashboard) return { ok: false, error: "unavailable" };
    const destination = sourceSectionUrl(dashboard, section);
    if (!destination) return { ok: false, error: "forbidden" };
    try {
      await window.loadURL(destination);
      return { ok: true };
    } catch {
      return { ok: false, error: "unavailable" };
    }
  });

  ipcMain.removeHandler("clarity-source-settings-read");
  ipcMain.handle("clarity-source-settings-read", async (event) => {
    if (!isSourceSettingsPage(event)) return { ok: false, error: "forbidden" };
    if (!(await authorizeAdmin())) return { ok: false, error: "admin_required" };
    try {
      const settings = await getSourceSettings(syncConfigPath());
      return { ok: true, settings };
    } catch {
      return { ok: false, error: "unavailable" };
    }
  });

  ipcMain.removeHandler("clarity-source-settings-test");
  ipcMain.handle("clarity-source-settings-test", async (event, input: unknown) => {
    if (!isSourceSettingsPage(event)) return { ok: false, error: "forbidden" };
    if (!(await authorizeAdmin())) return { ok: false, error: "admin_required" };
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !["orthancUrl", "username", "password"].includes(key))
    ) {
      return { ok: false, error: "invalid_settings" };
    }
    const form = input as Record<string, unknown>;
    if (
      typeof form.orthancUrl !== "string" ||
      typeof form.username !== "string" ||
      typeof form.password !== "string"
    ) {
      return { ok: false, error: "invalid_settings" };
    }
    try {
      const path = syncConfigPath();
      const current = await readRuntimeConfig(path);
      const allowLoopback = loopbackHttpEnabled();
      const endpoint = normalizeOrthancUrl(form.orthancUrl.trim(), allowLoopback);
      const unchanged = endpoint === current.CLARITY_ORTHANC_URL;
      try {
        assertSameOrthancIdentity(current.CLARITY_ORTHANC_URL, endpoint);
      } catch {
        return { ok: false, error: "source_identity_change" };
      }
      const authorization = basicAuthorization(
        form.username,
        form.password,
        current.CLARITY_ORTHANC_AUTHORIZATION,
        unchanged,
      );
      return (await testOrthanc(endpoint, authorization))
        ? { ok: true, connected: true }
        : { ok: false, error: "connection_failed" };
    } catch {
      return { ok: false, error: "invalid_settings" };
    }
  });

  ipcMain.removeHandler("clarity-source-settings-save");
  ipcMain.handle("clarity-source-settings-save", async (event, input: unknown) => {
    if (!isSourceSettingsPage(event)) return { ok: false, error: "forbidden" };
    if (!(await authorizeAdmin())) return { ok: false, error: "admin_required" };
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (key) => !["orthancUrl", "username", "password", "pollIntervalMinutes"].includes(key),
      )
    ) {
      return { ok: false, error: "invalid_settings" };
    }
    const form = input as Record<string, unknown>;
    if (
      typeof form.orthancUrl !== "string" ||
      typeof form.username !== "string" ||
      typeof form.password !== "string" ||
      typeof form.pollIntervalMinutes !== "number" ||
      !Number.isInteger(form.pollIntervalMinutes) ||
      form.pollIntervalMinutes < 5 ||
      form.pollIntervalMinutes > 60
    ) {
      return { ok: false, error: "invalid_settings" };
    }
    try {
      const path = syncConfigPath();
      const current = await readRuntimeConfig(path);
      const endpoint = normalizeOrthancUrl(form.orthancUrl.trim(), loopbackHttpEnabled());
      const unchanged = endpoint === current.CLARITY_ORTHANC_URL;
      try {
        assertSameOrthancIdentity(current.CLARITY_ORTHANC_URL, endpoint);
      } catch {
        return { ok: false, error: "source_identity_change" };
      }
      const authorization = basicAuthorization(
        form.username,
        form.password,
        current.CLARITY_ORTHANC_AUTHORIZATION,
        unchanged,
      );
      if (!(await testOrthanc(endpoint, authorization))) {
        return { ok: false, error: "connection_failed" };
      }
      const writerPath = process.env.CLARITY_SYNC_CONFIG_WRITER?.trim() ?? "";
      const nodePath = process.env.CLARITY_NODE_EXECUTABLE?.trim() ?? "";
      if (!writerPath || !nodePath) return { ok: false, error: "unavailable" };
      await writeSourceSettings(path, writerPath, nodePath, {
        CLARITY_ORTHANC_URL: endpoint,
        CLARITY_ORTHANC_AUTHORIZATION: authorization,
        CLARITY_SYNC_POLL_INTERVAL_MINUTES: String(form.pollIntervalMinutes),
      });
      return {
        ok: true,
        settings: {
          configured: true,
          orthancUrl: endpoint,
          pollIntervalMinutes: form.pollIntervalMinutes,
        },
      };
    } catch {
      return { ok: false, error: "save_failed" };
    }
  });

  const load =
    dashboard && origins
      ? window.loadURL(dashboardSignInUrl(dashboard))
      : window.loadFile(fileURLToPath(new URL("../static/index.html", import.meta.url)));
  load.catch(() => {
    window.loadFile(setupPath, { query: { error: "unavailable" } }).catch(() => app.exit(1));
  });
}

app
  .whenReady()
  .then(() => {
    if (profileConfigurationFailed) {
      app.exit(78);
      return;
    }
    return openScaffoldWindow();
  })
  .catch(() => {
    app.exit(1);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) openScaffoldWindow();
});
