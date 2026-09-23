import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("clarityDeviceAdmin", {
  invoke: (request: unknown): Promise<unknown> =>
    ipcRenderer.invoke("clarity-device-admin", request),
});
