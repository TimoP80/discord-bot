import type { AppConfig } from '../types';
import { DEFAULT_NICKNAME, DEFAULT_VIRTUAL_USERS, DEFAULT_CHANNELS, DEFAULT_TYPING_DELAY, DEFAULT_TYPING_INDICATOR } from '../constants';

class ConfigInitializationService {
  async initializeConfig(savedConfig: AppConfig | null, configPath?: string): Promise<AppConfig> {
    if (savedConfig) {
      return savedConfig;
    }
    return this.createFallbackConfig();
  }

  createFallbackConfig(): AppConfig {
    return {
      lastUpdated: new Date(0).toISOString(),
      currentUserNickname: DEFAULT_NICKNAME,
      virtualUsers: '',
      channels: '',
      simulationSpeed: 'normal',
      aiModel: 'openai',
      typingDelay: DEFAULT_TYPING_DELAY,
      typingIndicator: DEFAULT_TYPING_INDICATOR as { mode: 'all' | 'private_only' | 'none' },
      userObjects: [],
      channelObjects: []
    };
  }
}

export const configInitService = new ConfigInitializationService();
