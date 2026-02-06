const debugLoggingEnabled = process.env.DEBUG_LOGGING_ENABLED === 'true';

export const debugLog = (...args: unknown[]) => {
  if (debugLoggingEnabled) {
    console.log('[DEBUG]', ...args);
  }
};
