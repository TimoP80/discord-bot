import { contextBridge, ipcRenderer } from 'electron';

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
    // Bot configuration operations
    getBotConfigs: () => ipcRenderer.invoke('get-bot-configs'),
    getBotConfig: (botId: string) => ipcRenderer.invoke('get-bot-config', botId),
    updateBotConfig: (botId: string, config: any) => ipcRenderer.invoke('update-bot-config', botId, config),
    saveBotConfigs: () => ipcRenderer.invoke('save-bot-configs'),
    exportBotConfigs: () => ipcRenderer.invoke('export-bot-configs'),
    createBot: (name: string, token: string) => ipcRenderer.invoke('create-bot', name, token),

    // Window controls
    minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
    maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
    closeWindow: () => ipcRenderer.invoke('window:close'),
});
