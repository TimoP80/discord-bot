import { contextBridge, ipcRenderer } from 'electron';

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
    // Logs and analytics operations
    getMetrics: (timeRange: string) => ipcRenderer.invoke('get-metrics', timeRange),
    getLogs: (filters: any) => ipcRenderer.invoke('get-logs', filters),
    getTopBots: (timeRange: string) => ipcRenderer.invoke('get-top-bots', timeRange),
    getPopularChannels: (timeRange: string) => ipcRenderer.invoke('get-popular-channels', timeRange),
    getAvailableBots: () => ipcRenderer.invoke('get-available-bots'),
    exportLogs: (filters: any) => ipcRenderer.invoke('export-logs', filters),
    clearLogs: () => ipcRenderer.invoke('clear-logs'),

    // Window controls
    minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
    maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
    closeWindow: () => ipcRenderer.invoke('window:close'),
});
