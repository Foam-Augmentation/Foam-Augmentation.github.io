// Gives the page (which has no Node access) exactly three calls into the main process:
// whether PrusaSlicer is available, slicing parts with it, and reading the profile bundle
// that comes with it. See electron/main.js and
// src/visualizer/toolpath/prusaSlicer.ts for the other ends.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('prusaSlicer', {
    status: () => ipcRenderer.invoke('prusa:status'),
    slice: request => ipcRenderer.invoke('prusa:slice', request),
    vendorProfiles: () => ipcRenderer.invoke('prusa:vendorProfiles'),
});
