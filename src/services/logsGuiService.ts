import { BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import { botDebug } from '../utils/debugLogger';

interface LogEntry {
    id: string;
    timestamp: number;
    level: 'info' | 'warn' | 'error' | 'debug';
    message: string;
    botName?: string;
    channel?: string;
}

interface Metrics {
    totalMessages: number;
    activeBots: number;
    errorCount: number;
    avgResponseTime: number;
    messagesChange: number;
    botsChange: number;
    errorsChange: number;
    responseTimeChange: number;
}

interface AnalyticsData {
    topBots: Array<{ name: string; messageCount: number }>;
    popularChannels: Array<{ name: string; messageCount: number }>;
}

export class LogsGuiService {
    private logsWindow: BrowserWindow | null = null;
    private logs: LogEntry[] = [];
    private metrics: Metrics = {
        totalMessages: 0,
        activeBots: 2,
        errorCount: 0,
        avgResponseTime: 250,
        messagesChange: 12,
        botsChange: 0,
        errorsChange: -5,
        responseTimeChange: -8
    };

    constructor() {
        this.generateMockLogs();
        this.generateMockAnalytics();
    }

    /**
     * Creates and shows the logs & analytics GUI window
     */
    public showLogsWindow(): void {
        if (this.logsWindow && !this.logsWindow.isDestroyed()) {
            this.logsWindow.focus();
            return;
        }

        this.logsWindow = new BrowserWindow({
            width: 1400,
            height: 900,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, '../../dist/preload-logs.js')
            },
            title: 'Logs & Analytics Dashboard',
            icon: path.join(__dirname, '../../assets/icon.png'),
            show: false
        });

        // Load the HTML content
        const htmlPath = path.join(__dirname, '../../dist/logs-gui.html');
        this.logsWindow.loadFile(htmlPath);

        // Show window when ready
        this.logsWindow.once('ready-to-show', () => {
            this.logsWindow?.show();
            botDebug.log('📊 Logs & Analytics GUI window shown');
        });

        // Handle window closed
        this.logsWindow.on('closed', () => {
            this.logsWindow = null;
            botDebug.log('📊 Logs & Analytics GUI window closed');
        });

        // Setup IPC handlers
        this.setupIpcHandlers();

        // Start adding new logs periodically
        this.startLogGeneration();
    }

    /**
     * Setup IPC handlers for logs and analytics operations
     */
    private setupIpcHandlers(): void {
        // Get metrics
        ipcMain.handle('get-metrics', async (event, timeRange) => {
            try {
                // Adjust metrics based on time range
                const adjustedMetrics = { ...this.metrics };
                switch (timeRange) {
                    case '1h':
                        adjustedMetrics.totalMessages = Math.floor(adjustedMetrics.totalMessages * 0.1);
                        break;
                    case '24h':
                        // Default
                        break;
                    case '7d':
                        adjustedMetrics.totalMessages *= 7;
                        break;
                    case '30d':
                        adjustedMetrics.totalMessages *= 30;
                        break;
                }

                return { success: true, metrics: adjustedMetrics };
            } catch (error) {
                botDebug.error('Error getting metrics:', error);
                return { success: false, error: (error as Error).message };
            }
        });

        // Get logs with filters
        ipcMain.handle('get-logs', async (event, filters) => {
            try {
                let filteredLogs = [...this.logs];

                // Apply time range filter
                const now = Date.now();
                let timeLimit = now;
                switch (filters.timeRange) {
                    case '1h':
                        timeLimit = now - (60 * 60 * 1000);
                        break;
                    case '24h':
                        timeLimit = now - (24 * 60 * 60 * 1000);
                        break;
                    case '7d':
                        timeLimit = now - (7 * 24 * 60 * 60 * 1000);
                        break;
                    case '30d':
                        timeLimit = now - (30 * 24 * 60 * 60 * 1000);
                        break;
                }
                filteredLogs = filteredLogs.filter(log => log.timestamp >= timeLimit);

                // Apply log level filter
                if (filters.logLevel !== 'all') {
                    filteredLogs = filteredLogs.filter(log => log.level === filters.logLevel);
                }

                // Apply bot filter
                if (filters.botFilter !== 'all') {
                    filteredLogs = filteredLogs.filter(log => log.botName === filters.botFilter);
                }

                // Sort by timestamp (newest first)
                filteredLogs.sort((a, b) => b.timestamp - a.timestamp);

                return { success: true, logs: filteredLogs.slice(0, 1000) }; // Limit to 1000 entries
            } catch (error) {
                botDebug.error('Error getting logs:', error);
                return { success: false, error: (error as Error).message };
            }
        });

        // Get top bots analytics
        ipcMain.handle('get-top-bots', async (event, timeRange) => {
            try {
                // Mock top bots data
                const topBots = [
                    { name: 'TiiaV', messageCount: Math.floor(Math.random() * 500) + 100 },
                    { name: 'SekoBoltsi', messageCount: Math.floor(Math.random() * 400) + 80 },
                    { name: 'System', messageCount: Math.floor(Math.random() * 100) + 20 }
                ].sort((a, b) => b.messageCount - a.messageCount);

                return { success: true, bots: topBots };
            } catch (error) {
                botDebug.error('Error getting top bots:', error);
                return { success: false, error: (error as Error).message };
            }
        });

        // Get popular channels analytics
        ipcMain.handle('get-popular-channels', async (event, timeRange) => {
            try {
                // Mock popular channels data
                const popularChannels = [
                    { name: 'general', messageCount: Math.floor(Math.random() * 300) + 150 },
                    { name: 'music', messageCount: Math.floor(Math.random() * 200) + 100 },
                    { name: 'gaming', messageCount: Math.floor(Math.random() * 150) + 50 },
                    { name: 'random', messageCount: Math.floor(Math.random() * 100) + 25 }
                ].sort((a, b) => b.messageCount - a.messageCount);

                return { success: true, channels: popularChannels };
            } catch (error) {
                botDebug.error('Error getting popular channels:', error);
                return { success: false, error: (error as Error).message };
            }
        });

        // Get available bots for filter
        ipcMain.handle('get-available-bots', async () => {
            try {
                const bots = [
                    { id: 'tiiaV', name: 'TiiaV' },
                    { id: 'sekoboltsi', name: 'SekoBoltsi' },
                    { id: 'system', name: 'System' }
                ];

                return { success: true, bots };
            } catch (error) {
                botDebug.error('Error getting available bots:', error);
                return { success: false, error: (error as Error).message };
            }
        });

        // Export logs
        ipcMain.handle('export-logs', async (event, filters) => {
            try {
                // Get filtered logs directly
                let filteredLogs = [...this.logs];

                // Apply time range filter
                const now = Date.now();
                let timeLimit = now;
                switch (filters.timeRange) {
                    case '1h':
                        timeLimit = now - (60 * 60 * 1000);
                        break;
                    case '24h':
                        timeLimit = now - (24 * 60 * 60 * 1000);
                        break;
                    case '7d':
                        timeLimit = now - (7 * 24 * 60 * 60 * 1000);
                        break;
                    case '30d':
                        timeLimit = now - (30 * 24 * 60 * 60 * 1000);
                        break;
                }
                filteredLogs = filteredLogs.filter(log => log.timestamp >= timeLimit);

                // Apply log level filter
                if (filters.logLevel !== 'all') {
                    filteredLogs = filteredLogs.filter(log => log.level === filters.logLevel);
                }

                // Apply bot filter
                if (filters.botFilter !== 'all') {
                    filteredLogs = filteredLogs.filter(log => log.botName === filters.botFilter);
                }

                // Sort by timestamp (newest first)
                filteredLogs.sort((a, b) => b.timestamp - a.timestamp);

                const exportData = {
                    exportedAt: new Date().toISOString(),
                    filters,
                    logs: filteredLogs.slice(0, 1000)
                };

                // Mock file path
                const filePath = `bot-logs-export-${Date.now()}.json`;

                botDebug.log(`📤 Exported logs to: ${filePath}`);
                return { success: true, filePath, data: exportData };
            } catch (error) {
                botDebug.error('Error exporting logs:', error);
                return { success: false, error: (error as Error).message };
            }
        });

        // Clear logs
        ipcMain.handle('clear-logs', async () => {
            try {
                this.logs = [];
                botDebug.log('🗑️ Logs cleared');
                return { success: true };
            } catch (error) {
                botDebug.error('Error clearing logs:', error);
                return { success: false, error: (error as Error).message };
            }
        });
    }

    /**
     * Generate mock logs for demonstration
     */
    private generateMockLogs(): void {
        const botNames = ['TiiaV', 'SekoBoltsi', 'System'];
        const levels: Array<'info' | 'warn' | 'error' | 'debug'> = ['info', 'warn', 'error', 'debug'];
        const messages = {
            info: [
                'Bot connected to Discord',
                'Message processed successfully',
                'Agent response generated',
                'Channel activity detected',
                'User interaction completed',
                'Configuration loaded',
                'Simulation step executed'
            ],
            warn: [
                'High response time detected',
                'Rate limit approaching',
                'Configuration validation warning',
                'API response delayed',
                'Memory usage elevated'
            ],
            error: [
                'Failed to connect to Discord API',
                'Agent response generation failed',
                'Configuration save error',
                'Database connection lost',
                'API rate limit exceeded'
            ],
            debug: [
                'Processing user message',
                'Agent personality loaded',
                'Channel permissions checked',
                'Memory cleanup executed',
                'Cache invalidation completed'
            ]
        };

        // Generate logs for the last 24 hours
        const now = Date.now();
        const oneDayAgo = now - (24 * 60 * 60 * 1000);

        for (let i = 0; i < 500; i++) {
            const timestamp = oneDayAgo + Math.random() * (now - oneDayAgo);
            const level = levels[Math.floor(Math.random() * levels.length)];
            const message = messages[level][Math.floor(Math.random() * messages[level].length)];
            const botName = level === 'error' ? 'System' : botNames[Math.floor(Math.random() * botNames.length)];

            this.logs.push({
                id: `log_${timestamp}_${i}`,
                timestamp,
                level,
                message,
                botName,
                channel: level !== 'error' ? ['#general', '#music', '#gaming', '#random'][Math.floor(Math.random() * 4)] : undefined
            });
        }

        // Sort by timestamp
        this.logs.sort((a, b) => b.timestamp - a.timestamp);
    }

    /**
     * Generate mock analytics data
     */
    private generateMockAnalytics(): void {
        // This data is generated dynamically in the IPC handlers
    }

    /**
     * Start periodically adding new logs
     */
    private startLogGeneration(): void {
        setInterval(() => {
            if (Math.random() < 0.3) { // 30% chance every 10 seconds
                this.addRandomLog();
            }
        }, 10000);
    }

    /**
     * Add a random log entry
     */
    private addRandomLog(): void {
        const botNames = ['TiiaV', 'SekoBoltsi'];
        const levels: Array<'info' | 'warn' | 'error' | 'debug'> = ['info', 'info', 'info', 'warn', 'debug']; // Mostly info/debug
        const messages = {
            info: ['Message sent to channel', 'User interaction processed', 'Bot status updated'],
            warn: ['Response time elevated', 'Memory usage high'],
            error: ['API connection failed momentarily'],
            debug: ['Cache refreshed', 'Configuration reloaded']
        };

        const level = levels[Math.floor(Math.random() * levels.length)];
        const message = messages[level][Math.floor(Math.random() * messages[level].length)];

        const log: LogEntry = {
            id: `log_${Date.now()}_${Math.random()}`,
            timestamp: Date.now(),
            level,
            message,
            botName: botNames[Math.floor(Math.random() * botNames.length)],
            channel: ['#general', '#music', '#gaming'][Math.floor(Math.random() * 3)]
        };

        this.logs.unshift(log); // Add to beginning

        // Keep only last 1000 logs
        if (this.logs.length > 1000) {
            this.logs = this.logs.slice(0, 1000);
        }

        // Update metrics
        if (level === 'error') {
            this.metrics.errorCount++;
        }
        this.metrics.totalMessages++;
    }

    /**
     * Close the logs GUI window
     */
    public closeLogsWindow(): void {
        if (this.logsWindow && !this.logsWindow.isDestroyed()) {
            this.logsWindow.close();
        }
    }

    /**
     * Check if the logs window is open
     */
    public isLogsWindowOpen(): boolean {
        return this.logsWindow !== null && !this.logsWindow.isDestroyed();
    }
}

// Export singleton instance
export const logsGuiService = new LogsGuiService();
