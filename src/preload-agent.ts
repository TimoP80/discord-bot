import { contextBridge, ipcRenderer } from 'electron';

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('agentAPI', {
    // Agent CRUD operations
    getAllAgents: () => ipcRenderer.invoke('agent:get-all'),
    createAgent: (agentData: any) => ipcRenderer.invoke('agent:create', agentData),
    deleteAgent: (agentId: string) => ipcRenderer.invoke('agent:delete', agentId),
    clearHistory: (agentId: string) => ipcRenderer.invoke('agent:clear-history', agentId),

    // Conversation operations
    getConversationHistory: (agentId: string) => ipcRenderer.invoke('agent:get-history', agentId),
    testConversation: (agentId: string, message: string, language: string) =>
        ipcRenderer.invoke('agent:test-conversation', { agentId, message, language }),

    // Configuration
    checkConfig: () => ipcRenderer.invoke('agent:check-config'),

    // Window operations
    minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
    maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
    closeWindow: () => ipcRenderer.invoke('window:close'),
});
