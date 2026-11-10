// Gives the page (which has no Node access) exactly two calls into the main process:
// whether PrusaSlicer is available, and slicing parts with it. See electron/main.js and
// src/visualizer/toolpath/prusaSlicer.ts for the other ends.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('prusaSlicer', {
    status: () => ipcRenderer.invoke('prusa:status'),
    slice: request => ipcRenderer.invoke('prusa:slice', request),
});
