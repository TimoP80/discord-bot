import { promises as fs } from 'fs';
import path from 'path';
import type { AppConfig } from '../types';
import { saveDatabase, getDb, setDb } from './configDatabaseService';

const dbPath = path.resolve(process.cwd(), 'db.json');

// Placeholder function
export const broadcastConfigUpdate = async (config: AppConfig): Promise<void> => {};

/**
 * Synchronizes the in-memory configuration with the configuration from the file system.
 * It merges the configurations, giving precedence to the one with the most recent timestamp.
 */
export const syncConfiguration = async (): Promise<void> => {
  try {
    const inMemoryDb = getDb();
    let fileDb: AppConfig;

    try {
      const data = await fs.readFile(dbPath, 'utf-8');
      fileDb = JSON.parse(data) as AppConfig;
    } catch (error: unknown) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        // If the file doesn't exist, the in-memory db is authoritative
        await saveDatabase();
        console.log('Configuration file not found, created from in-memory database.');
        return;
      }
      console.error('Failed to load database from file for sync:', error);
      return; // Don't proceed if we can't read the file
    }

    // Compare timestamps and merge if necessary
    if (new Date(fileDb.lastUpdated) > new Date(inMemoryDb.lastUpdated)) {
      // File system is newer, update in-memory
      setDb(fileDb);
      console.log('Configuration updated from file system.');
    } else if (new Date(fileDb.lastUpdated) < new Date(inMemoryDb.lastUpdated)) {
      // In-memory is newer, update file system
      await saveDatabase();
      console.log('Configuration saved to file system.');
    }
  } catch (error) {
    console.error('Failed to synchronize configuration:', error);
  }
};

/**
 * Sets up a periodic synchronization of the configuration.
 */
export const setupConfigSync = (): void => {
  // Sync every 5 minutes
  setInterval(syncConfiguration, 5 * 60 * 1000);
};
