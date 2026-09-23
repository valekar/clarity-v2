import { app, BrowserWindow, ipcMain, session } from "electron";
import { fileURLToPath } from "node:url";
import { dashboardSignInUrl, isTrustedUrl, trustedOrigin } from "./navigation-policy.js";
import { createDeviceAdminBridge } from "./device-admin-bridge.js";

const STAFF_PARTITION = "persist:clarity-v2-staff";

function staffOrigins(): ReadonlySet<string> | null {
  const dashboard = process.env.CLARITY_DASHBOARD_ORIGIN?.trim();
  const hanko = process.env.CLARITY_HANKO_ORIGIN?.trim();
  if (!dashboard && !hanko) return null;
  if (!dashboard || !hanko) throw new Error("Both dashboard and Hanko origins are required.");
  const allowLoopback = process.env.CLARITY_ALLOW_LOOPBACK_HTTP === "true";
  return new Set([trustedOrigin(dashboard, allowLoopback), trustedOrigin(hanko, allowLoopback)]);
}

function openScaffoldWindow(): void {
  let origins: ReadonlySet<string> | null;
  try {
    origins = staffOrigins();
  } catch {
    app.exit(1);
    return;
  }
  const staffSession = origins ? session.fromPartition(STAFF_PARTITION) : undefined;
  const dashboard = process.env.CLARITY_DASHBOARD_ORIGIN?.trim();
  const hanko = process.env.CLARITY_HANKO_ORIGIN?.trim();
  if (dashboard && hanko && origins && staffSession) {
    const dashboardOrigin = trustedOrigin(
      dashboard,
      process.env.CLARITY_ALLOW_LOOPBACK_HTTP === "true",
    );
    const hankoOrigin = trustedOrigin(hanko, process.env.CLARITY_ALLOW_LOOPBACK_HTTP === "true");
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
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      partition: STAFF_PARTITION,
      ...(dashboard && origins
        ? { preload: fileURLToPath(new URL("./preload.js", import.meta.url)) }
        : {}),
    },
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

  const load =
    dashboard && origins
      ? window.loadURL(dashboardSignInUrl(dashboard))
      : window.loadFile(fileURLToPath(new URL("../static/index.html", import.meta.url)));
  load.catch(() => app.exit(1));
}

app
  .whenReady()
  .then(openScaffoldWindow)
  .catch(() => {
    app.exit(1);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) openScaffoldWindow();
});
