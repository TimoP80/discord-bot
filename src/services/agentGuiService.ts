import { BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import { elevenLabsAgentService } from './elevenLabsAgentService';
import { botDebug } from '../utils/debugLogger';

export class AgentGuiService {
    private agentWindow: BrowserWindow | null = null;

    /**
     * Creates and shows the agent management GUI window
     */
    public showAgentWindow(): void {
        if (this.agentWindow && !this.agentWindow.isDestroyed()) {
            this.agentWindow.focus();
            return;
        }

        this.agentWindow = new BrowserWindow({
            width: 1200,
            height: 800,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, '../../dist/preload-agent.js')
      },
            title: 'ElevenLabs Agent Manager',
            icon: path.join(__dirname, '../../assets/icon.png'), // Add icon if available
            show: false,
            autoHideMenuBar: true
        });

        // Load the HTML content
        const htmlPath = path.join(__dirname, '../../dist/agent-gui.html');
        this.agentWindow.loadFile(htmlPath);

        // Show window when ready
        this.agentWindow.once('ready-to-show', () => {
            this.agentWindow?.show();
            botDebug.log('🤖 Agent GUI window shown');
        });

        // Handle window closed
        this.agentWindow.on('closed', () => {
            this.agentWindow = null;
            botDebug.log('🤖 Agent GUI window closed');
        });

        // Setup IPC handlers
        this.setupIpcHandlers();
    }

    /**
     * Setup IPC handlers for agent operations
     */
    private setupIpcHandlers(): void {
        // Get all agents
        ipcMain.handle('agent:get-all', async () => {
            try {
                const agents = elevenLabsAgentService.getAllAgents();
                return { success: true, agents };
            } catch (error) {
                botDebug.error('Error getting agents:', error);
                return { success: false, error: (error as Error).message };
            }
        });

        // Create new agent
        ipcMain.handle('agent:create', async (event, agentData) => {
            try {
                const { name, systemPrompt, language, personality } = agentData;
                const agent = await elevenLabsAgentService.createAgent({
                    name,
                    systemPrompt,
                    language,
                    personality
                });

                if (agent) {
                    botDebug.log(`✅ Agent created via GUI: ${agent.name}`);
                    return { success: true, agent };
                } else {
                    return { success: false, error: 'Failed to create agent' };
                }
            } catch (error) {
                botDebug.error('Error creating agent:', error);
                return { success: false, error: (error as Error).message };
            }
        });

        // Delete agent
        ipcMain.handle('agent:delete', async (event, agentId) => {
            try {
                elevenLabsAgentService.deleteAgent(agentId);
                botDebug.log(`🗑️ Agent deleted via GUI: ${agentId}`);
                return { success: true };
            } catch (error) {
                botDebug.error('Error deleting agent:', error);
                return { success: false, error: (error as Error).message };
            }
        });

        // Clear conversation history
        ipcMain.handle('agent:clear-history', async (event, agentId) => {
            try {
                elevenLabsAgentService.clearConversation(agentId);
                botDebug.log(`🧹 Conversation cleared via GUI: ${agentId}`);
                return { success: true };
            } catch (error) {
                botDebug.error('Error clearing conversation:', error);
                return { success: false, error: (error as Error).message };
            }
        });

        // Get conversation history
        ipcMain.handle('agent:get-history', async (event, agentId) => {
            try {
                const history = elevenLabsAgentService.getConversationHistory(agentId);
                return { success: true, history };
            } catch (error) {
                botDebug.error('Error getting conversation history:', error);
                return { success: false, error: (error as Error).message };
            }
        });

        // Test conversation with agent
        ipcMain.handle('agent:test-conversation', async (event, { agentId, message, language }) => {
            try {
                const response = await elevenLabsAgentService.converseWithAgent(
                    agentId,
                    message,
                    'gui-test-user',
                    language
                );

                if (response) {
                    return { success: true, response };
                } else {
                    return { success: false, error: 'No response from agent' };
                }
            } catch (error) {
                botDebug.error('Error testing conversation:', error);
                return { success: false, error: (error as Error).message };
            }
        });

        // Check if service is configured
        ipcMain.handle('agent:check-config', async () => {
            const isConfigured = elevenLabsAgentService.isConfigured();
            const hasApiKey = !!process.env.ELEVENLABS_API_KEY;
            return { isConfigured, hasApiKey };
        });
    }

    /**
     * Close the agent GUI window
     */
    public closeAgentWindow(): void {
        if (this.agentWindow && !this.agentWindow.isDestroyed()) {
            this.agentWindow.close();
        }
    }

    /**
     * Check if the agent window is open
     */
    public isAgentWindowOpen(): boolean {
        return this.agentWindow !== null && !this.agentWindow.isDestroyed();
    }
}

// Export singleton instance
export const agentGuiService = new AgentGuiService();
