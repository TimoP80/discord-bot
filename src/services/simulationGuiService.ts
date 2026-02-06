import { BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import { botDebug } from '../utils/debugLogger';

interface SimulationConfig {
    speedMultiplier: number;
    maxMessagesPerHour: number;
    responseProbability: number;
    randomEventsEnabled: boolean;
}

interface SimulationStatus {
    status: 'stopped' | 'running' | 'paused';
    startTime?: number;
    config?: SimulationConfig;
    stats?: {
        activeBots: number;
        totalMessages: number;
        uptime: number;
    };
}

interface SimulationActivity {
    id: string;
    type: 'message' | 'reaction' | 'join' | 'leave' | 'error';
    description: string;
    botName: string;
    timestamp: number;
}

export class SimulationGuiService {
    private simulationWindow: BrowserWindow | null = null;
    private simulationStatus: SimulationStatus = { status: 'stopped' };
    private activities: SimulationActivity[] = [];
    private simulationInterval: NodeJS.Timeout | null = null;

    /**
     * Creates and shows the simulation control GUI window
     */
    public showSimulationWindow(): void {
        if (this.simulationWindow && !this.simulationWindow.isDestroyed()) {
            this.simulationWindow.focus();
            return;
        }

        this.simulationWindow = new BrowserWindow({
            width: 1400,
            height: 900,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, '../../dist/preload-simulation.js')
            },
            title: 'Simulation Control Center',
            icon: path.join(__dirname, '../../assets/icon.png'),
            show: false
        });

        // Load the HTML content
        const htmlPath = path.join(__dirname, '../../dist/simulation-gui.html');
        this.simulationWindow.loadFile(htmlPath);

        // Show window when ready
        this.simulationWindow.once('ready-to-show', () => {
            this.simulationWindow?.show();
            botDebug.log('🎭 Simulation Control GUI window shown');
        });

        // Handle window closed
        this.simulationWindow.on('closed', () => {
            this.stopSimulation();
            this.simulationWindow = null;
            botDebug.log('🎭 Simulation Control GUI window closed');
        });

        // Setup IPC handlers
        this.setupIpcHandlers();
    }

    /**
     * Setup IPC handlers for simulation operations
     */
    private setupIpcHandlers(): void {
        // Get simulation status
        ipcMain.handle('get-simulation-status', async () => {
            return {
                success: true,
                status: this.simulationStatus.status,
                startTime: this.simulationStatus.startTime,
                stats: this.getSimulationStats()
            };
        });

        // Start simulation
        ipcMain.handle('start-simulation', async (event, config) => {
            try {
                this.startSimulation(config);
                botDebug.log('▶️ Simulation started with config:', config);
                return { success: true };
            } catch (error) {
                botDebug.error('Error starting simulation:', error);
                return { success: false, error: (error as Error).message };
            }
        });

        // Pause simulation
        ipcMain.handle('pause-simulation', async () => {
            try {
                this.pauseSimulation();
                botDebug.log('⏸️ Simulation paused');
                return { success: true };
            } catch (error) {
                botDebug.error('Error pausing simulation:', error);
                return { success: false, error: (error as Error).message };
            }
        });

        // Stop simulation
        ipcMain.handle('stop-simulation', async () => {
            try {
                this.stopSimulation();
                botDebug.log('⏹️ Simulation stopped');
                return { success: true };
            } catch (error) {
                botDebug.error('Error stopping simulation:', error);
                return { success: false, error: (error as Error).message };
            }
        });

        // Reset statistics
        ipcMain.handle('reset-simulation-stats', async () => {
            try {
                this.resetStatistics();
                botDebug.log('🔄 Simulation statistics reset');
                return { success: true };
            } catch (error) {
                botDebug.error('Error resetting statistics:', error);
                return { success: false, error: (error as Error).message };
            }
        });

        // Update simulation configuration
        ipcMain.handle('update-simulation-config', async (event, config) => {
            try {
                this.updateSimulationConfig(config);
                botDebug.log('⚙️ Simulation config updated:', config);
                return { success: true };
            } catch (error) {
                botDebug.error('Error updating simulation config:', error);
                return { success: false, error: (error as Error).message };
            }
        });

        // Get simulation activity
        ipcMain.handle('get-simulation-activity', async () => {
            return {
                success: true,
                activities: this.activities.slice(-50) // Last 50 activities
            };
        });
    }

    /**
     * Start the simulation
     */
    private startSimulation(config: SimulationConfig): void {
        if (this.simulationStatus.status === 'running') {
            return;
        }

        this.simulationStatus = {
            status: 'running',
            startTime: Date.now(),
            config: config,
            stats: {
                activeBots: 2, // Mock: 2 bots active
                totalMessages: 0,
                uptime: 0
            }
        };

        // Start simulation loop
        this.simulationInterval = setInterval(() => {
            this.generateSimulationActivity();
            this.updateSimulationStats();
        }, Math.max(1000, 5000 / (config.speedMultiplier || 1))); // Adjust speed
    }

    /**
     * Pause the simulation
     */
    private pauseSimulation(): void {
        if (this.simulationStatus.status !== 'running') {
            return;
        }

        this.simulationStatus.status = 'paused';
        if (this.simulationInterval) {
            clearInterval(this.simulationInterval);
            this.simulationInterval = null;
        }
    }

    /**
     * Stop the simulation
     */
    private stopSimulation(): void {
        this.simulationStatus.status = 'stopped';
        this.simulationStatus.startTime = undefined;

        if (this.simulationInterval) {
            clearInterval(this.simulationInterval);
            this.simulationInterval = null;
        }
    }

    /**
     * Reset simulation statistics
     */
    private resetStatistics(): void {
        if (this.simulationStatus.stats) {
            this.simulationStatus.stats.totalMessages = 0;
            this.simulationStatus.stats.uptime = 0;
        }
        this.activities = [];
    }

    /**
     * Update simulation configuration
     */
    private updateSimulationConfig(config: SimulationConfig): void {
        if (this.simulationStatus.config) {
            this.simulationStatus.config = config;

            // Restart simulation loop with new speed if running
            if (this.simulationStatus.status === 'running' && this.simulationInterval) {
                clearInterval(this.simulationInterval);
                this.simulationInterval = setInterval(() => {
                    this.generateSimulationActivity();
                    this.updateSimulationStats();
                }, Math.max(1000, 5000 / (config.speedMultiplier || 1)));
            }
        }
    }

    /**
     * Generate mock simulation activity
     */
    private generateSimulationActivity(): void {
        if (this.simulationStatus.status !== 'running') {
            return;
        }

        const activities = [
            { type: 'message', templates: [
                'Bot sent a message in #general',
                'Bot replied to user question',
                'Bot shared a random thought',
                'Bot reacted to channel activity'
            ]},
            { type: 'reaction', templates: [
                'Bot added reaction to message',
                'Bot expressed amusement',
                'Bot showed agreement'
            ]},
            { type: 'join', templates: [
                'Bot joined voice channel',
                'Bot entered conversation'
            ]}
        ];

        const randomActivity = activities[Math.floor(Math.random() * activities.length)];
        const randomTemplate = randomActivity.templates[Math.floor(Math.random() * randomActivity.templates.length)];
        const botNames = ['TiiaV', 'SekoBoltsi'];

        const activity: SimulationActivity = {
            id: `activity_${Date.now()}_${Math.random()}`,
            type: randomActivity.type as any,
            description: randomTemplate,
            botName: botNames[Math.floor(Math.random() * botNames.length)],
            timestamp: Date.now()
        };

        this.activities.push(activity);

        // Keep only last 100 activities
        if (this.activities.length > 100) {
            this.activities = this.activities.slice(-100);
        }

        // Update message count
        if (this.simulationStatus.stats && randomActivity.type === 'message') {
            this.simulationStatus.stats.totalMessages++;
        }
    }

    /**
     * Update simulation statistics
     */
    private updateSimulationStats(): void {
        if (this.simulationStatus.stats && this.simulationStatus.startTime) {
            this.simulationStatus.stats.uptime = Date.now() - this.simulationStatus.startTime;
        }
    }

    /**
     * Get current simulation statistics
     */
    private getSimulationStats() {
        return this.simulationStatus.stats || {
            activeBots: 0,
            totalMessages: 0,
            uptime: 0
        };
    }

    /**
     * Close the simulation GUI window
     */
    public closeSimulationWindow(): void {
        if (this.simulationWindow && !this.simulationWindow.isDestroyed()) {
            this.simulationWindow.close();
        }
    }

    /**
     * Check if the simulation window is open
     */
    public isSimulationWindowOpen(): boolean {
        return this.simulationWindow !== null && !this.simulationWindow.isDestroyed();
    }

    /**
     * Get current simulation status
     */
    public getSimulationStatus(): SimulationStatus {
        return { ...this.simulationStatus };
    }
}

// Export singleton instance
export const simulationGuiService = new SimulationGuiService();
