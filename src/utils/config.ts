import type { AppConfig, User, Channel } from '../types';
import { GeminiApiError } from '../gemini-api-error';
import { DEFAULT_NICKNAME, DEFAULT_VIRTUAL_USERS, DEFAULT_CHANNELS, DEFAULT_TYPING_DELAY, DEFAULT_TYPING_INDICATOR } from '../constants';
import { configInitService } from '../services/configInitializationService';
import { saveConfigToDatabase, loadConfigFromDatabase } from '../services/configDatabaseService';
import { sendConfigToMain, requestConfigFromMain } from '../services/electronConfigSync';
import { broadcastConfigUpdate } from '../services/configSyncService';
import { resetAIService } from '../services/vertexAIService';

const CONFIG_STORAGE_KEY = 'gemini-irc-simulator-config';
const CHANNEL_LOGS_STORAGE_KEY = 'station-v-channel-logs';

/**
 * Checks localStorage quota and estimates available space
 */
const checkLocalStorageQuota = (): { available: number; used: number; total: number } => {
  try {
    // Estimate total localStorage size
    let totalSize = 0;
    for (const key in localStorage) {
      if (localStorage.hasOwnProperty(key)) {
        totalSize += localStorage[key].length;
      }
    }

    // Most browsers have 5-10MB limit, we'll assume 5MB for safety
    const estimatedTotal = 5 * 1024 * 1024; // 5MB
    const available = estimatedTotal - totalSize;

    return {
      available,
      used: totalSize,
      total: estimatedTotal
    };
  } catch (error) {
    console.warn('Could not check localStorage quota:', error);
    return { available: 0, used: 0, total: 0 };
  }
};

/**
 * Loads the application configuration from multiple sources.
 * Priority: Electron (if available) > IndexedDB > localStorage
 * @returns The saved AppConfig or null if none is found.
 */
export const loadConfig = async (): Promise<AppConfig | null> => {
  try {
    // Try to load from Electron main process first (if in Electron)
    console.log('[Config Debug] Attempting to load config from Electron...');
    const electronConfig = await requestConfigFromMain();
    if (electronConfig) {
      console.log('[Config Debug] Loaded config from Electron');
      return {
        ...electronConfig,
        typingDelay: electronConfig.typingDelay || DEFAULT_TYPING_DELAY
      };
    }

    // Try to load from IndexedDB
    console.log('[Config Debug] No config in Electron, trying database...');
    const dbConfig = await loadConfigFromDatabase();
    if (dbConfig) {
      console.log('[Config Debug] Loaded config from database');
      // Sync to Electron if available
      await sendConfigToMain(dbConfig);
      return {
        ...dbConfig,
        typingDelay: dbConfig.typingDelay || DEFAULT_TYPING_DELAY
      };
    }

    // Fallback for server-side (Node.js) environment
    console.log('[Config Debug] No config in database, returning null');
    return null;
  } catch (error) {
    console.error('Failed to load config:', error);
    return null;
  }
};

/**
 * Initializes configuration with fallback support for executable builds.
 * This function ensures the app can start even without existing data.
 * @param configPath Optional path to default configuration JSON file
 * @returns Promise<AppConfig> Always returns a valid configuration
 */
export const initializeConfigWithFallback = async (configPath?: string): Promise<AppConfig> => {
  console.log('[Config Init] Initializing configuration with fallback support...');

  try {
    // Try to load saved configuration first (now async with database support)
    const savedConfig = await loadConfig();
    console.log('[Config Init] Loaded saved config from storage');

    // Initialize using the config service
    const config = await configInitService.initializeConfig(savedConfig, configPath);
    console.log('[Config Init] Configuration initialized successfully');

    // Save to database for future use
    await saveConfigToDatabase(config);

    console.log('[Config Init] Configuration initialized successfully');
    return config;
  } catch (error) {
    console.error('[Config Init] Error during config initialization:', error);

    // Ultimate fallback - create minimal config
    console.log('[Config Init] Using ultimate fallback configuration');
    return configInitService.createFallbackConfig();
  }
};

/**
 * Saves the application configuration to all available storage backends.
 * Saves to: Electron (if available) > IndexedDB > localStorage
 * @param config The AppConfig object to save.
 */
export const saveConfig = async (config: AppConfig): Promise<void> => {
  try {
    console.log('[Config Debug] saveConfig called with config:', config);
    console.log('[Config Debug] Config keys:', Object.keys(config));
    console.log('[Config Debug] Config aiModel:', config.aiModel);
    console.log('[Config Debug] Config simulationSpeed:', config.simulationSpeed);

    const configString = JSON.stringify(config);
    console.log('[Config Debug] Serialized config length:', configString.length);

    // Save to Electron main process (primary for Electron app)
    const electronSaved = await sendConfigToMain(config);
    if (electronSaved) {
      console.log('[Config Debug] Config saved successfully to Electron');
    } else {
      console.log('[Config Debug] Electron save not available or failed');
    }

    // Save to database (primary for web)
    const dbSaved = await saveConfigToDatabase(config);
    if (dbSaved) {
      console.log('[Config Debug] Config saved successfully to database');
    } else {
      console.warn('[Config Debug] Failed to save config to database, will use localStorage');
    }

    // Also save to localStorage as fallback
    localStorage.setItem(CONFIG_STORAGE_KEY, configString);
    console.log('[Config Debug] Config saved successfully to localStorage');

    // Broadcast config update to all tabs and Electron
    await broadcastConfigUpdate(config);

    // Verify the save worked
    const savedConfig = localStorage.getItem(CONFIG_STORAGE_KEY);
    if (savedConfig) {
      console.log('[Config Debug] Config verification successful, saved config exists');
    } else {
      console.error('[Config Debug] Config verification failed, no saved config found');
    }
  } catch (error) {
    console.error('Failed to save config:', error);
  }
};

const MAX_RETRIES = 10;
const INITIAL_BACKOFF_MS = 5000; // 5 seconds

const isRateLimitError = (error: unknown): boolean => {
  // Check for 0 quota limit (billing/configuration issue) - never retry
  const msg = error instanceof Error ? error.message : String(error);
  if (msg.includes('"quota_limit_value":"0"')) {
    return false;
  }

  // Check for standard rate limit / overload keywords
  return msg.includes('429') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('quota') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests') ||
    msg.includes('503') ||
    msg.includes('overloaded') ||
    msg.includes('UNAVAILABLE');
};

const isQuotaExhaustedError = (error: unknown): boolean => {
  const msg = error instanceof Error ? error.message : String(error);
  return (msg.includes('429') && msg.includes('RESOURCE_EXHAUSTED')) ||
    msg.includes('quota exhausted') ||
    msg.includes('exceeded your current quota');
};

const isNetworkError = (error: unknown): boolean => {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes('NetworkError') ||
    msg.includes('CORS') ||
    msg.includes('fetch') ||
    msg.includes('Failed to fetch') ||
    msg.includes('socket hang up') ||
    msg.includes('ECONNRESET');
};

/**
 * Wraps an API call with exponential backoff for rate limit errors.
 * @param apiCall The function that returns a promise for the API call.
 * @returns The result of the API call.
 * @throws Throws an error if retries are exhausted or a non-rate-limit error occurs.
 */
export const withRateLimitAndRetries = async <T>(
  apiCall: () => Promise<T>,
  context?: string,
  options?: { maxRetries?: number; initialBackoffMs?: number }
): Promise<T> => {
  const maxRetries = options?.maxRetries ?? MAX_RETRIES;
  const initialBackoffMs = options?.initialBackoffMs ?? INITIAL_BACKOFF_MS;

  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      return await apiCall();
    } catch (error) {
      console.error(`[API Error] Attempt ${attempt + 1}/${maxRetries + 1} failed${context ? ` for ${context}` : ''}:`, error);

      if (isNetworkError(error)) {
        console.warn('[API Error] Network/CORS error detected. This may be due to browser security policies.');
        throw new Error('Network error: Unable to connect to AI service. This may be due to CORS restrictions or network issues. Please check your internet connection and try again.');
      }

      if (isRateLimitError(error)) {
        // If this looks like a hard quota exhaustion, don't retry to avoid log/traffic storms
        const msg = error instanceof Error ? error.message : String(error);
        const isHardQuota = /RESOURCE_EXHAUSTED|quota exceeded|GenerateRequestsPerDayPerProjectPerModel/i.test(msg);
        if (isHardQuota) {
          console.warn('[API Error] Hard quota/RESOURCE_EXHAUSTED detected. Not retrying.');
          // For quota exhausted errors, throw a special error that can be caught for fallback
          if (isQuotaExhaustedError(error)) {
            throw new Error('QUOTA_EXHAUSTED_FALLBACK');
          }
          // Force exit retry loop by setting attempt to max
          attempt = maxRetries;
        } else if (attempt < maxRetries) {
          attempt++;
          const delay = initialBackoffMs * Math.pow(2, attempt - 1) + Math.random() * 1000; // Add jitter
          console.warn(`Rate limit hit. Retrying in ${Math.round(delay / 1000)}s... (Attempt ${attempt}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
      }

      {
        if (error instanceof Error) {
          // Check for zero quota error (billing/configuration issue)
          if (error.message.includes('"quota_limit_value":"0"')) {
            throw new Error('❌ API Quota Error: Your Gemini API key has 0 quota allocated. This is a billing/configuration issue, not a rate limit.\n\n' +
              'Solutions:\n' +
              '1. Check your Google Cloud Console billing settings\n' +
              '2. Ensure your API key has quota allocated for your region\n' +
              '3. Try using a different API key\n' +
              '4. Check: https://console.cloud.google.com/apis/api/generativelanguage.googleapis.com/quotas');
          } else if (error.message.includes('RESOURCE_EXHAUSTED') || /GenerateRequestsPerDayPerProjectPerModel/i.test(error.message)) {
            throw new Error('AI service quota exhausted. Please try again later or check your API key limits.');
          } else if (error.message.match(/quota/i)) {
            throw new Error('AI service quota exceeded. Please try again later.');
          } else if (error.message.includes('429')) {
            throw new Error('Rate limit exceeded. Please wait a moment and try again.');
          } else if (error.message.includes('503') || error.message.includes('overloaded') || error.message.includes('UNAVAILABLE')) {
            throw new Error('AI service is temporarily overloaded. Please try again in a few moments.');
          }
        }
        throw error;
      }
    }
  }
  throw new Error('Exhausted retries for API call.');
};


/**
 * Parses the raw string configuration for virtual users into an array of User objects.
 * Format: one user per line, "nickname, personality".
 * @param usersString The raw string from the settings textarea.
 * @returns An array of User objects.
 */
const parseVirtualUsers = (usersString: string): User[] => {
  return usersString.split('\n')
    .map(line => line.trim())
    .filter(line => line.includes(','))
    .map(line => {
      const [nickname, ...personalityParts] = line.split(',');
      return {
        id: `virtual-${nickname.trim()}`, // Add a virtual ID
        nickname: nickname.trim(),
        personality: personalityParts.join(',').trim(),
        status: 'online' as const,
        userType: 'virtual' as const,
        languageSkills: {
          languages: [{
            language: 'English',
            fluency: 'native' as const,
            accent: ''
          }]
        },
        writingStyle: {
          formality: 'casual' as const,
          verbosity: 'moderate' as const,
          humor: 'none' as const,
          emojiUsage: 'rare' as const,
          punctuation: 'standard' as const
        }
      };
    });
};

/**
 * Parses the raw string configuration for channels into an array of Channel objects.
 * Format: one channel per line, "#channel, topic".
 * @param channelsString The raw string from the settings textarea.
 * @param allVirtualUsers The list of all available virtual users to populate the channels with.
 * @param currentUserNickname The nickname of the main user.
 * @returns An array of Channel objects.
 */
const parseChannels = (channelsString: string, allVirtualUsers: User[], currentUserNickname: string): Channel[] => {
  return channelsString.split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('#') && line.includes(','))
    .map((line, index) => {
      // Check if line has dominant language (format: "#channel, topic | language")
      const hasLanguage = line.includes(' | ');
      let name: string, topic: string, dominantLanguage: string | undefined;

      if (hasLanguage) {
        const [channelPart, dominantLanguagePart] = line.split(' | ');
        const [namePart, ...topicParts] = channelPart.split(',');
        name = namePart.trim();
        topic = topicParts.join(',').trim();
        dominantLanguage = dominantLanguagePart.trim();
      } else {
        // Legacy format without dominant language
        const [namePart, ...topicParts] = line.split(',');
        name = namePart.trim();
        topic = topicParts.join(',').trim();
        dominantLanguage = undefined;
      }

      // Start with empty channel (only current user) - users will be assigned through UI
      // This allows for proper channel-specific user management
      return {
        name,
        topic,
        dominantLanguage,
        users: [
          {
            id: 'human-user', // Placeholder ID for the human user
            nickname: currentUserNickname,
            status: 'online' as const,
            personality: 'The human user',
            userType: 'virtual' as const,
            languageSkills: {
              languages: [{
                language: 'English',
                fluency: 'native' as const,
                accent: ''
              }]
            },
            writingStyle: { formality: 'casual' as const, verbosity: 'moderate' as const, humor: 'none' as const, emojiUsage: 'rare' as const, punctuation: 'standard' as const }
          }
        ],
        messages: [
          { id: Date.now() + index, nickname: 'system', content: `You have joined ${name}`, timestamp: new Date(), type: 'system' }
        ],
        operators: [] // New channels start with no operators
      };
    });
};


/**
 * Initializes the application state from a saved or new configuration.
 * @param config The AppConfig object.
 * @returns An object containing the initialized nickname, users, and channels.
 */
export const initializeStateFromConfig = (config: AppConfig) => {
  console.log('[Config State] Initializing state from config');
  const nickname = config.currentUserNickname || DEFAULT_NICKNAME;
  const profilePicture = config.currentUserProfilePicture;
  // Use userObjects if available (for proper persistence), otherwise fall back to text parsing
  const virtualUsers = config.userObjects || (config.virtualUsers ? parseVirtualUsers(config.virtualUsers) : DEFAULT_VIRTUAL_USERS as User[]);

  // Use channel objects if available (preserves user assignments), otherwise parse from text
  let channels: Channel[];
  if (config.channelObjects && config.channelObjects.length > 0) {
    // Use saved channel objects to preserve user assignments
    channels = config.channelObjects.map(c => ({
      ...c,
      users: c.users.map(user =>
        user.nickname === DEFAULT_NICKNAME ? {
          id: 'human-user',
          nickname,
          profilePicture,
          status: 'online' as const,
          personality: 'The human user',
          userType: 'virtual' as const,
          languageSkills: {
            languages: [{
              language: 'English',
              fluency: 'native' as const,
              accent: ''
            }]
          },
          writingStyle: { formality: 'casual' as const, verbosity: 'moderate' as const, humor: 'none' as const, emojiUsage: 'rare' as const, punctuation: 'standard' as const }
        } : user
      )
    }));
  } else if (Array.isArray(config.channels)) { // Handle legacy format where channels might be an array
    channels = config.channels.map(c => ({
      ...c,
      users: c.users.map((user: User) =>
        user.nickname === DEFAULT_NICKNAME ? {
          id: 'human-user',
          nickname,
          profilePicture,
          status: 'online' as const,
          personality: 'The human user',
          userType: 'virtual' as const,
          languageSkills: {
            languages: [{
              language: 'English',
              fluency: 'native' as const,
              accent: ''
            }]
          },
          writingStyle: { formality: 'casual' as const, verbosity: 'moderate' as const, humor: 'none' as const, emojiUsage: 'rare' as const, punctuation: 'standard' as const }
        } : user
      )
    }));
  } else if (typeof config.channels === 'string' && config.channels.trim()) {
    channels = parseChannels(config.channels, virtualUsers, nickname);
  } else {
    // Use default channels but ensure they have the correct current user nickname
    // Only include the current user, not the default users from DEFAULT_CHANNELS
    channels = (DEFAULT_CHANNELS as Channel[]).map((c: Channel) => ({
      ...c,
      users: [
        {
          id: 'human-user',
          nickname,
          profilePicture,
          status: 'online' as const,
          personality: 'The human user',
          userType: 'virtual' as const,
          languageSkills: {
            languages: [{
              language: 'English',
              fluency: 'native' as const,
              accent: ''
            }]
          },
          writingStyle: { formality: 'casual' as const, verbosity: 'moderate' as const, humor: 'none' as const, emojiUsage: 'rare' as const, punctuation: 'standard' as const }
        }
      ]
    }));
  }

  const simulationSpeed = config.simulationSpeed || 'off';
  const aiModel = config.aiModel || 'gemini-3-flash-preview';
  const typingDelay = config.typingDelay || DEFAULT_TYPING_DELAY;
  const typingIndicator = config.typingIndicator || DEFAULT_TYPING_INDICATOR;
  const privateMessages = config.privateMessages || {
    allowRandomPMs: true
  };
  const ircExport = config.ircExport || {
    enabled: false,
    server: 'irc.libera.chat',
    port: 6697,
    nickname: 'station-v-user',
    realname: 'Station V User',
    channel: '#station-v-testing',
    ssl: true
  };
  const imageGeneration = config.imageGeneration || {
    provider: 'dalle',
    apiKey: '',
    model: 'dall-e-3',
    baseUrl: undefined
  };
  const spotify = config.spotify || {
    clientId: '',
    clientSecret: '',
    redirectUri: ''
  };

  return { nickname, virtualUsers, channels, simulationSpeed, aiModel, typingDelay, typingIndicator, privateMessages, ircExport, imageGeneration, spotify, profilePicture };
};

/**
 * Saves channel logs to localStorage.
 * @param channels Array of Channel objects to save.
 */
export const saveChannelLogs = (channels: Channel[]) => {
  try {
    // Check quota before attempting to save
    const quota = checkLocalStorageQuota();
    console.log(`[Config Debug] localStorage quota: ${Math.round(quota.used / 1024)}KB used, ${Math.round(quota.available / 1024)}KB available`);

    // Convert Date objects to strings for JSON serialization
    const serializedChannels = channels.map(channel => ({
      ...channel,
      messages: channel.messages.map(message => ({
        ...message,
        timestamp: message.timestamp instanceof Date
          ? message.timestamp.toISOString()
          : (() => {
            try {
              const date = new Date(message.timestamp);
              if (isNaN(date.getTime())) {
                console.warn('Invalid timestamp found, using current time:', message.timestamp);
                return new Date().toISOString();
              }
              return date.toISOString();
            } catch (error) {
              console.warn('Error parsing timestamp, using current time:', message.timestamp, error);
              return new Date().toISOString();
            }
          })()
      }))
    }));

    const dataToSave = JSON.stringify(serializedChannels);
    const dataSize = new Blob([dataToSave]).size;

    // Check if data is too large for localStorage
    const maxSize = 4 * 1024 * 1024; // 4MB limit (leave 1MB buffer)

    if (dataSize > maxSize || dataSize > quota.available) {
      console.warn(`Channel logs data is too large (${Math.round(dataSize / 1024)}KB), compressing...`);

      // Clean up old logs first
      cleanupOldLogs();

      // Compress data by limiting message history
      const compressedChannels = channels.map(channel => ({
        ...channel,
        messages: channel.messages.slice(-500) // Keep only last 500 messages per channel
      }));

      const compressedData = JSON.stringify(compressedChannels.map(channel => ({
        ...channel,
        messages: channel.messages.map(message => ({
          ...message,
          timestamp: message.timestamp instanceof Date
            ? message.timestamp.toISOString()
            : new Date(message.timestamp).toISOString()
        }))
      })));

      const compressedSize = new Blob([compressedData]).size;
      console.log(`Compressed data size: ${Math.round(compressedSize / 1024)}KB`);

      if (compressedSize > maxSize) {
        console.warn('Data still too large after compression, using ultra-compression...');

        // Try with even more aggressive compression
        const ultraCompressedChannels = channels.map(channel => ({
          ...channel,
          messages: channel.messages.slice(-100) // Keep only last 100 messages per channel
        }));

        const ultraCompressedData = JSON.stringify(ultraCompressedChannels.map(channel => ({
          ...channel,
          messages: channel.messages.map(message => ({
            ...message,
            timestamp: message.timestamp instanceof Date
              ? message.timestamp.toISOString()
              : new Date(message.timestamp).toISOString()
          }))
        })));

        localStorage.setItem(CHANNEL_LOGS_STORAGE_KEY, ultraCompressedData);
        console.log('Saved ultra-compressed channel logs');
        return;
      }

      localStorage.setItem(CHANNEL_LOGS_STORAGE_KEY, compressedData);
      console.log('Saved compressed channel logs');
      return;
    }

    localStorage.setItem(CHANNEL_LOGS_STORAGE_KEY, dataToSave);
    console.log(`Successfully saved channel logs (${Math.round(dataSize / 1024)}KB)`);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      console.warn('localStorage quota exceeded, attempting to clear old data and retry...');

      // Clear old logs and try again with compressed data
      clearChannelLogs();

      try {
        // Try with compressed data
        const compressedChannels = channels.map(channel => ({
          ...channel,
          messages: channel.messages.slice(-200) // Keep only last 200 messages per channel
        }));

        const compressedData = JSON.stringify(compressedChannels.map(channel => ({
          ...channel,
          messages: channel.messages.map(message => ({
            ...message,
            timestamp: message.timestamp instanceof Date
              ? message.timestamp.toISOString()
              : new Date(message.timestamp).toISOString()
          }))
        })));

        localStorage.setItem(CHANNEL_LOGS_STORAGE_KEY, compressedData);
        console.log('Successfully saved compressed channel logs after quota exceeded');
      } catch (retryError) {
        console.error('Failed to save channel logs even after compression:', retryError);
      }
    } else {
      console.error('Failed to save channel logs to localStorage:', error);
    }
  }
};

/**
 * Loads channel logs from localStorage.
 * @returns Array of Channel objects or null if none found.
 */
export const loadChannelLogs = (): Channel[] | null => {
  try {
    const savedLogs = localStorage.getItem(CHANNEL_LOGS_STORAGE_KEY);
    if (!savedLogs) return null;

    const parsedChannels = JSON.parse(savedLogs);

    // Convert timestamp strings back to Date objects
    return parsedChannels.map((channel: unknown) => ({
      ...(channel as Channel),
      messages: (channel as Channel).messages.map((message: unknown) => ({
        ...(message as any),
        timestamp: new Date((message as any).timestamp)
      }))
    }));
  } catch (error) {
    console.error('Failed to load channel logs from localStorage:', error);
    return null;
  }
};

/**
 * Clears all saved channel logs from localStorage.
 */
export const clearChannelLogs = () => {
  try {
    localStorage.removeItem(CHANNEL_LOGS_STORAGE_KEY);
  } catch (error) {
    console.error('Failed to clear channel logs from localStorage:', error);
  }
};

/**
 * Automatically cleans up old channel logs to prevent quota exceeded errors
 */
export const cleanupOldLogs = () => {
  try {
    const quota = checkLocalStorageQuota();
    const quotaThreshold = 0.8; // Clean up when 80% full

    if (quota.used / quota.total > quotaThreshold) {
      console.log('localStorage quota is getting full, cleaning up old logs...');

      const savedLogs = localStorage.getItem(CHANNEL_LOGS_STORAGE_KEY);
      if (savedLogs) {
        const channels = JSON.parse(savedLogs);

        // Keep only recent messages (last 200 per channel)
        const cleanedChannels = channels.map((channel: unknown) => ({
          ...(channel as any),
          messages: (channel as any).messages.slice(-200)
        }));

        const cleanedData = JSON.stringify(cleanedChannels);
        localStorage.setItem(CHANNEL_LOGS_STORAGE_KEY, cleanedData);

        console.log(`Cleaned up old logs, reduced from ${Math.round(quota.used / 1024)}KB to ${Math.round(new Blob([cleanedData]).size / 1024)}KB`);
      }
    }
  } catch (error) {
    console.error('Failed to cleanup old logs:', error);
  }
};

/**
 * Generates a random typing delay to simulate human typing time.
 * @param messageLength The length of the message being typed
 * @param config Optional typing delay configuration
 * @returns Promise that resolves after the calculated delay
 */
export const simulateTypingDelay = async (
  messageLength: number,
  config?: { enabled: boolean; baseDelay: number; maxDelay: number }
): Promise<void> => {
  // Use provided config or defaults
  const typingConfig = config || DEFAULT_TYPING_DELAY;

  // If typing delay is disabled, return immediately
  if (!typingConfig.enabled) {
    return Promise.resolve();
  }

  // Calculate delay based on message length with more realistic scaling
  const lengthFactor = messageLength / 10; // Slower typing speed
  const randomFactor = 0.5 + Math.random(); // Random factor between 0.5 and 1.5

  // Calculate final delay with a higher base
  const calculatedDelay = Math.min(
    typingConfig.baseDelay + (lengthFactor * 100 * randomFactor),
    typingConfig.maxDelay
  );

  // Add some randomness to make it feel more natural
  const finalDelay = calculatedDelay + (Math.random() * 1000 - 500); // ±500ms variation

  return new Promise(resolve => setTimeout(resolve, Math.max(finalDelay, 500))); // Minimum 500ms delay
};
