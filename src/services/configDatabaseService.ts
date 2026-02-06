import { promises as fs } from 'fs';
import path from 'path';
import type { AppConfig } from '../types';

const dbPath = path.resolve(process.cwd(), 'db.json');

let db: AppConfig | null = null;

const defaultDb: AppConfig = {
  lastUpdated: new Date(0).toISOString(), // Oldest possible timestamp
  currentUserNickname: 'Bot',
  virtualUsers: '',
  channels: '',
  simulationSpeed: 'normal',
  aiModel: 'gemini-3-flash-preview',
  typingDelay: {
    enabled: true,
    baseDelay: 500,
    maxDelay: 1500
  },
  typingIndicator: {
    mode: 'all'
  },
  userObjects: [],
  channelObjects: []
};

export const loadDatabase = async (): Promise<void> => {
  try {
    const data = await fs.readFile(dbPath, 'utf-8');
    db = JSON.parse(data);
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      db = defaultDb;
    } else {
      console.error('Failed to load database:', error);
      throw error;
    }
  }
};

export const saveDatabase = async (): Promise<void> => {
  if (!db) {
    throw new Error('Database not loaded.');
  }
  try {
    db.lastUpdated = new Date().toISOString();
    await fs.writeFile(dbPath, JSON.stringify(db, null, 2), 'utf-8');
  } catch (error) {
    console.error('Failed to save database:', error);
    throw error;
  }
};

export const getDb = (): AppConfig => {
  if (!db) {
    throw new Error('Database not loaded. Call loadDatabase first.');
  }
  return db;
};

export const setDb = (newDb: AppConfig): void => {
  db = newDb;
};

/**
 * Loads the application configuration from the database file.
 * This is a convenience wrapper around loadDatabase and getDb.
 * @returns The saved AppConfig or null if an error occurs.
 */
export const loadConfigFromDatabase = async (): Promise<AppConfig | null> => {
  try {
    await loadDatabase();
    return getDb();
  } catch (error) {
    console.error('Failed to load config from database:', error);
    return null;
  }
};

/**
 * Saves the application configuration to the database file.
 * This is a convenience wrapper around setDb and saveDatabase.
 * @param config The AppConfig object to save.
 * @returns True if successful, false otherwise.
 */
export const saveConfigToDatabase = async (config: AppConfig): Promise<boolean> => {
  try {
    setDb(config);
    await saveDatabase();
    return true;
  } catch (error) {
    console.error('Failed to save config to database:', error);
    return false;
  }
};
