import { app, BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";

function openScaffoldWindow(): void {
  const window = new BrowserWindow({
    width: 980,
    height: 700,
    minWidth: 620,
    minHeight: 460,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());

  const page = fileURLToPath(new URL("../static/index.html", import.meta.url));
  window.loadFile(page).catch(() => {
    app.exit(1);
  });
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
