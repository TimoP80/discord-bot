import { BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import { botDebug } from '../utils/debugLogger';

export class BotConfigGuiService {
    private botConfigWindow: BrowserWindow | null = null;

    /**
     * Creates and shows the bot configuration GUI window
     */
    public showBotConfigWindow(): void {
        if (this.botConfigWindow && !this.botConfigWindow.isDestroyed()) {
            this.botConfigWindow.focus();
            return;
        }

        this.botConfigWindow = new BrowserWindow({
            width: 1400,
            height: 900,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, '../../dist/preload-bot-config.js')
            },
            title: 'Bot Configuration Manager',
            icon: path.join(__dirname, '../../assets/icon.png'),
            show: false
        });

        // Load the HTML content
        const htmlPath = path.join(__dirname, '../../dist/bot-config-gui.html');
        this.botConfigWindow.loadFile(htmlPath);

        // Show window when ready
        this.botConfigWindow.once('ready-to-show', () => {
            this.botConfigWindow?.show();
            botDebug.log('⚙️ Bot Configuration GUI window shown');
        });

        // Handle window closed
        this.botConfigWindow.on('closed', () => {
            this.botConfigWindow = null;
            botDebug.log('⚙️ Bot Configuration GUI window closed');
        });

        // Setup IPC handlers
        this.setupIpcHandlers();
    }

    /**
     * Setup IPC handlers for bot configuration operations
     */
    private setupIpcHandlers(): void {
        // Get all bot configurations
        ipcMain.handle('get-bot-configs', async () => {
            try {
                // This would integrate with your existing bot configuration system
                // For now, return mock data
                const mockBots = [
                    {
                        id: 'bot1',
                        name: 'TiiaV',
                        status: 'online',
                        responseProbability: 0.08,
                        language: 'fi',
                        personality: 'A 26-year-old musician from Helsinki...'
                    },
                    {
                        id: 'bot2',
                        name: 'SekoBoltsi',
                        status: 'online',
                        responseProbability: 0.1,
                        language: 'fi',
                        personality: 'A Helsinki nerd passionate about coding...'
                    }
                ];

                return { success: true, bots: mockBots };
            } catch (error) {
                botDebug.error('Error getting bot configs:', error);
                return { success: false, error: (error as Error).message };
            }
        });

        // Get specific bot configuration
        ipcMain.handle('get-bot-config', async (event, botId) => {
            try {
                // Mock bot configuration
                const mockConfig = {
                    id: botId,
                    name: botId === 'bot1' ? 'TiiaV' : 'SekoBoltsi',
                    responseProbability: 0.08,
                    dmResponseProbability: 1.0,
                    personality: botId === 'bot1'
                        ? 'A 26-year-old musician from Helsinki who loves electronic music...'
                        : 'A Helsinki nerd passionate about coding and demoscene...',
                    language: 'fi',
                    idleChatterEnabled: true,
                    delayedReactionEnabled: false,
                    followUpEnabled: false,
                    useElevenLabsAgent: botId === 'bot1',
                    elevenLabsAgentId: botId === 'bot1' ? 'agent_tiiaV' : '',
                    elevenLabsAgentLanguage: 'fi'
                };

                return { success: true, config: mockConfig };
            } catch (error) {
                botDebug.error('Error getting bot config:', error);
                return { success: false, error: (error as Error).message };
            }
        });

        // Update bot configuration
        ipcMain.handle('update-bot-config', async (event, botId, config) => {
            try {
                // Here you would save the configuration to your bot config system
                botDebug.log(`📝 Updating bot config for ${botId}:`, config);

                // Mock successful update
                return { success: true };
            } catch (error) {
                botDebug.error('Error updating bot config:', error);
                return { success: false, error: (error as Error).message };
            }
        });

        // Save all configurations
        ipcMain.handle('save-bot-configs', async () => {
            try {
                // Here you would save all configurations to disk
                botDebug.log('💾 Saving all bot configurations');

                // Mock successful save
                return { success: true };
            } catch (error) {
                botDebug.error('Error saving bot configs:', error);
                return { success: false, error: (error as Error).message };
            }
        });

        // Export configurations
        ipcMain.handle('export-bot-configs', async () => {
            try {
                // Here you would export configurations to a file
                const exportData = {
                    exportedAt: new Date().toISOString(),
                    bots: [
                        { id: 'bot1', name: 'TiiaV' },
                        { id: 'bot2', name: 'SekoBoltsi' }
                    ]
                };

                // Mock file path
                const filePath = `bot-configs-export-${Date.now()}.json`;

                botDebug.log(`📤 Exported bot configurations to: ${filePath}`);
                return { success: true, filePath, data: exportData };
            } catch (error) {
                botDebug.error('Error exporting bot configs:', error);
                return { success: false, error: (error as Error).message };
            }
        });

        // Create new bot
        ipcMain.handle('create-bot', async (event, name, token) => {
            try {
                // Here you would create a new bot in your system
                botDebug.log(`➕ Creating new bot: ${name}`);

                const newBot = {
                    id: `bot_${Date.now()}`,
                    name: name,
                    status: 'offline',
                    token: token // In real implementation, store securely
                };

                // Mock successful creation
                return { success: true, bot: newBot };
            } catch (error) {
                botDebug.error('Error creating bot:', error);
                return { success: false, error: (error as Error).message };
            }
        });
    }

    /**
     * Close the bot configuration GUI window
     */
    public closeBotConfigWindow(): void {
        if (this.botConfigWindow && !this.botConfigWindow.isDestroyed()) {
            this.botConfigWindow.close();
        }
    }

    /**
     * Check if the bot config window is open
     */
    public isBotConfigWindowOpen(): boolean {
        return this.botConfigWindow !== null && !this.botConfigWindow.isDestroyed();
    }
}

// Export singleton instance
export const botConfigGuiService = new BotConfigGuiService();
