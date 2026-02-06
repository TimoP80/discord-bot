import { contextBridge, ipcRenderer } from 'electron';

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
    // Simulation operations
    getSimulationStatus: () => ipcRenderer.invoke('get-simulation-status'),
    startSimulation: (config: any) => ipcRenderer.invoke('start-simulation', config),
    pauseSimulation: () => ipcRenderer.invoke('pause-simulation'),
    stopSimulation: () => ipcRenderer.invoke('stop-simulation'),
    resetSimulationStats: () => ipcRenderer.invoke('reset-simulation-stats'),
    updateSimulationConfig: (config: any) => ipcRenderer.invoke('update-simulation-config', config),
    getSimulationActivity: () => ipcRenderer.invoke('get-simulation-activity'),

    // Window controls
    minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
    maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
    closeWindow: () => ipcRenderer.invoke('window:close'),
});
