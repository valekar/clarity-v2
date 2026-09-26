// Electron's sandboxed preload is loaded as CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("clarityDeviceAdmin", {
  invoke: (request) => ipcRenderer.invoke("clarity-device-admin", request),
});

contextBridge.exposeInMainWorld("clarityDesktopSetup", {
  read: () => ipcRenderer.invoke("clarity-desktop-setup-read"),
  save: (configuration) => ipcRenderer.invoke("clarity-desktop-setup-save", configuration),
  retry: () => ipcRenderer.invoke("clarity-desktop-setup-retry"),
});

contextBridge.exposeInMainWorld("claritySourceSettings", {
  open: () => ipcRenderer.invoke("clarity-source-settings-open"),
  navigate: (section) => ipcRenderer.invoke("clarity-source-settings-navigate", section),
  read: () => ipcRenderer.invoke("clarity-source-settings-read"),
  test: (settings) => ipcRenderer.invoke("clarity-source-settings-test", settings),
  save: (settings) => ipcRenderer.invoke("clarity-source-settings-save", settings),
});
