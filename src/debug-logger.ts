import * as dotenv from 'dotenv';
dotenv.config();

const debugLoggingEnabled = process.env.DEBUG_LOGGING_ENABLED === 'true';

export const debugLog = (...args: any[]) => {
  if (debugLoggingEnabled) {
    console.log('[DEBUG]', ...args);
  }
};