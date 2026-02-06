import { ipcMain, BrowserWindow } from 'electron';
import type { AppConfig } from '../types';
import { getDb, setDb, saveDatabase } from './configDatabaseService';

/**
 * Broadcasts configuration changes to all renderer processes.
 * @param newConfig The new configuration to broadcast.
 */
export const broadcastConfigChanges = (newConfig: AppConfig): void => {
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send('config-updated', newConfig);
  });
};

/**
 * Sets up IPC handlers for configuration synchronization.
 */
export const setupElectronConfigSync = (): void => {
  // Handler for renderer processes to get the current configuration
  ipcMain.handle('get-config', async () => {
    return getDb();
  });

  // Handler for renderer processes to update the configuration
  ipcMain.handle('update-config', async (event, newConfig: AppConfig) => {
    try {
      setDb(newConfig);
      await saveDatabase();
      broadcastConfigChanges(newConfig); // Notify all renderers of the change
      return { success: true };
    } catch (error) {
      console.error('Failed to update config:', error);
      return { success: false, error: (error as Error).message };
    }
  });
};

/**
 * Sends the configuration to the Electron main process.
 * In a non-Electron environment, this function is a stub.
 * @param config The AppConfig object to save.
 * @returns A promise that resolves to true if successful, false otherwise.
 */
export const sendConfigToMain = async (config: AppConfig): Promise<boolean> => {
  // This is a stub for when not running in an Electron renderer process.
  // The main application logic in config.ts handles the false response gracefully.
  return Promise.resolve(false);
};

/**
 * Requests the configuration from the Electron main process.
 * In a non-Electron environment, this function is a stub.
 * @returns A promise that resolves to the AppConfig or null if not available.
 */
export const requestConfigFromMain = async (): Promise<AppConfig | null> => {
  // This is a stub for when not running in an Electron renderer process.
  // The main application logic in config.ts handles the null response gracefully.
  return Promise.resolve(null);
};
