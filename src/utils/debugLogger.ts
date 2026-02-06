// import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
// import { join } from 'path';

const isServer = typeof process !== 'undefined' && process.versions && process.versions.node;

const logFilePath = '';
const configFilePath = '';

interface DebugConfig {
  enabled: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  categories: { [key: string]: boolean };
}

const defaultCategories = {
  'station-v:main': true,
  'station-v:server': true,
  'station-v:ai': true,
  'station-v:ai-responses': true,
  'station-v:simulation': true,
  'station-v:reactions': true,
  'station-v:network': true,
  'station-v:settings': true,
  'station-v:pm': true,
  'station-v:rate-limiter': true,
  'station-v:url-filter': true,
  'station-v:user-list': true,
  'station-v:join': true,
  'station-v:config': true,
  'station-v:chat-log': true,
  'station-v:bot': true,
  'station-v:image': true,
  'station-v:app': true,
  'station-v:message': true,
  'station-v:time': true,
  'station-v:input': true,
  'station-v:notification': true,
  'station-v:context': true,
  'station-v:unread': true,
  'station-v:content': true,
  'station-v:media': true,
  'station-v:irc': true,
  'station-v:data-export': true,
  'station-v:vision': true,
  'station-v:audio': true,
  'station-v:voice': true // Voice chat logging
};

let config: DebugConfig = {
  enabled: (typeof process !== 'undefined' && process.env?.DEBUG?.includes('station-v')) || false,
  logLevel: getValidLogLevel(typeof process !== 'undefined' ? process.env?.LOG_LEVEL : undefined),
  categories: defaultCategories
};

function loadDebugConfig() {
  // File system operations removed for browser compatibility
}

function saveDebugConfig() {
  // File system operations removed for browser compatibility
}

loadDebugConfig();

const logLevels = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

function getValidLogLevel(level: string | undefined): 'debug' | 'info' | 'warn' | 'error' {
  const validLevels = ['debug', 'info', 'warn', 'error'];
  return validLevels.includes(level || '') ? level as 'debug' | 'info' | 'warn' | 'error' : 'debug';
}

function isNamespaceEnabled(namespace: string): boolean {
  // Check for individual environment variable controls for performance optimization
  const category = namespace.replace('station-v:', '');
  const envVarName = `DEBUG_${category.toUpperCase().replace(/-/g, '_')}`;
  const envVarValue = ((typeof process !== 'undefined' && process.env?.[envVarName]) || '').trim();

  if (envVarValue === 'true') return true;
  if (envVarValue === 'false') return false;

  // Fallback to global debug config
  if (!config.enabled) return false;

  // Fallback to original DEBUG environment variable logic
  const envDebug = (typeof process !== 'undefined' && process.env?.DEBUG) || '';
  if (envDebug === '*') return true;
  const enabledNamespaces = envDebug.split(',');
  return enabledNamespaces.some(ns => ns === '*' || namespace.startsWith(ns.replace(/\*$/, '')));
}

export function createDebugger(namespace: string) {
  const log = (level: 'debug' | 'info' | 'warn' | 'error', message: string, ...args: unknown[]) => {
    if (!isNamespaceEnabled(namespace) || logLevels[level] < logLevels[config.logLevel]) {
      return;
    }
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level.toUpperCase()}] [${namespace}] ${message}`;

    if (level === 'error') {
      console.error(logMessage, ...args);
    } else if (level === 'warn') {
      console.warn(logMessage, ...args);
    } else {
      console.log(logMessage, ...args);
    }

    // File system operations removed for browser compatibility
  };

  return {
    log: (message: string, ...args: unknown[]) => log('info', message, ...args),
    info: (message: string, ...args: unknown[]) => log('info', message, ...args),
    warn: (message: string, ...args: unknown[]) => log('warn', message, ...args),
    error: (message: string, ...args: unknown[]) => log('error', message, ...args),
    debug: (message: string, ...args: unknown[]) => log('debug', message, ...args)
  };
}

// Exported logger instances
export const mainDebug = createDebugger('station-v:main');
export const serverDebug = createDebugger('station-v:server');
export const aiDebug = createDebugger('station-v:ai');
export const aiResponsesDebug = createDebugger('station-v:ai-responses');
export const simulationDebug = createDebugger('station-v:simulation');
export const reactionsDebug = createDebugger('station-v:reactions');
export const networkDebug = createDebugger('station-v:network');
export const settingsDebug = createDebugger('station-v:settings');
export const pmDebug = createDebugger('station-v:pm');
export const rateLimiterDebug = createDebugger('station-v:rate-limiter');
export const urlFilterDebug = createDebugger('station-v:url-filter');
export const userListDebug = createDebugger('station-v:user-list');
export const joinDebug = createDebugger('station-v:join');
export const configDebug = createDebugger('station-v:config');
export const chatLogDebug = createDebugger('station-v:chat-log');
export const botDebug = createDebugger('station-v:bot');
export const imageDebug = createDebugger('station-v:image');
export const appDebug = createDebugger('station-v:app');
export const messageDebug = createDebugger('station-v:message');
export const timeDebug = createDebugger('station-v:time');
export const inputDebug = createDebugger('station-v:input');
export const notificationDebug = createDebugger('station-v:notification');
export const contextDebug = createDebugger('station-v:context');
export const unreadDebug = createDebugger('station-v:unread');
export const contentDebug = createDebugger('station-v:content');
export const mediaDebug = createDebugger('station-v:media');
export const ircDebug = createDebugger('station-v:irc');
export const dataExportDebug = createDebugger('station-v:data-export');
export const visionDebug = createDebugger('station-v:vision');
export const audioDebug = createDebugger('station-v:audio');
export const voiceDebug = createDebugger('station-v:voice');

// --- Configuration Functions ---
export function getDebugConfig() {
  return config;
}

export function updateDebugConfig(newConfig: Partial<DebugConfig>) {
  config = { ...config, ...newConfig };
  saveDebugConfig();
}

export function setDebugEnabled(enabled: boolean) {
  config.enabled = enabled;
  saveDebugConfig();
}

export function setLogLevel(level: string) {
  config.logLevel = getValidLogLevel(level);
  saveDebugConfig();
}

export function toggleCategory(category: string, enabled: boolean) {
  config.categories[category] = enabled;
  saveDebugConfig();
}

export function enableAllDebugLogging() {
  config.enabled = true;
  for (const key in config.categories) {
    config.categories[key] = true;
  }
  saveDebugConfig();
}

export function disableAllDebugLogging() {
  config.enabled = false;
  for (const key in config.categories) {
    config.categories[key] = false;
  }
  saveDebugConfig();
}
