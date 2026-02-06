import { contextBridge, ipcRenderer } from 'electron';

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
    // Window controls
    minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
    maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
    closeWindow: () => ipcRenderer.invoke('window:close'),

    // Application controls
    openAgentManager: () => ipcRenderer.invoke('open-agent-manager'),
    openBotConfig: () => ipcRenderer.invoke('open-bot-config'),
    openSimulation: () => ipcRenderer.invoke('open-simulation'),
    openLogs: () => ipcRenderer.invoke('open-logs'),

    // Config sync (from electronConfigSync)
    getConfig: () => ipcRenderer.invoke('get-config'),
    updateConfig: (config: any) => ipcRenderer.invoke('update-config', config),

    // Listen for config updates
    onConfigUpdate: (callback: Function) => {
        ipcRenderer.on('config-updated', (_event, newConfig) => callback(newConfig));
    }
});
