// Vertex AI Service
// Handles Vertex AI authentication and configuration

import { GoogleGenAI } from '@google/genai';
import { aiDebug } from '../utils/debugLogger';
import type { OllamaConfig } from './ollamaService';

export interface VertexAIConfig {
  enabled: boolean;
  project: string;
  location: string;
}

export interface AIServiceConfig {
  useVertexAI: boolean;
  useOllama: boolean;
  vertexAI?: VertexAIConfig;
  ollama?: OllamaConfig;
  apiKey?: string;
}

/**
 * Creates a GoogleGenAI instance configured for either Vertex AI or API key authentication
 * @param config AI service configuration
 * @returns Configured GoogleGenAI instance
 */
export const createAIService = (config: AIServiceConfig): GoogleGenAI => {
  if (config.useVertexAI && config.vertexAI?.enabled) {
    aiDebug.log('🔧 Initializing Vertex AI service...');
    aiDebug.log(`   Project: ${config.vertexAI.project}`);
    aiDebug.log(`   Location: ${config.vertexAI.location}`);

    return new GoogleGenAI({
      vertexai: true,
      project: config.vertexAI.project,
      location: config.vertexAI.location
    });
  } else {
    aiDebug.log('🔧 Initializing API Key-based service...');

    // When using Ollama, API key is optional (only needed as fallback)
    if (!config.apiKey && config.useOllama) {
      aiDebug.log('⚠️  No API key provided, but Ollama is enabled. Gemini will only be used as fallback.');
      // Create a dummy instance that will fail gracefully if called
      return new GoogleGenAI({
        apiKey: 'dummy-key-ollama-primary'
      });
    }

    // If no API key and not using Ollama, we need an API key
    if (!config.apiKey) {
      aiDebug.warn('⚠️  No API key provided and Ollama is not enabled. AI generation will fail.');
      // Create a dummy instance that will fail gracefully if called
      return new GoogleGenAI({
        apiKey: 'dummy-key-no-provider'
      });
    }

    // Ensure API key is trimmed and valid before creating service
    const trimmedKey = config.apiKey.trim();
    if (trimmedKey.length < 10) {
      aiDebug.error(`❌ API key too short: ${trimmedKey.length} characters (expected at least 10)`);
      throw new Error('Gemini API key is too short or invalid');
    }
    
    aiDebug.debug(`Creating GoogleGenAI instance with API key: ${trimmedKey.substring(0, 10)}...${trimmedKey.substring(trimmedKey.length - 4)}`);
    return new GoogleGenAI({
      apiKey: trimmedKey
    });
  }
};

/**
 * Validates the Gemini API key by making a lightweight call
 * @param apiKey The API key to validate
 * @returns True if the key is valid, false otherwise
 */
export const validateGeminiApiKey = async (apiKey: string): Promise<boolean> => {
  if (!apiKey || apiKey.startsWith('dummy-key')) {
    return false;
  }

  // Trim whitespace (common issue with .env files)
  const trimmedKey = apiKey.trim();
  if (trimmedKey !== apiKey) {
    aiDebug.warn('⚠️  API key had leading/trailing whitespace - trimmed automatically');
  }

  try {
    // metadata only check - much lighter and doesn't consume generation quota
    const testResponse = await fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + trimmedKey);

    if (testResponse.ok) {
      return true;
    }

    // specific handling for rate limits - if we hit rate limit, the key is actually VALID
    if (testResponse.status === 429) {
      aiDebug.warn('⚠️ API Key is valid but quota is exceeded (429). Proceeding knowing requests might fail.');
      return true;
    }

    const errorBody = await testResponse.json();
    const errorMessage = errorBody.error?.message || `API validation failed: ${testResponse.status} ${testResponse.statusText}`;
    aiDebug.warn(`API Key validation failed: ${errorMessage}`);
    return false;

  } catch (error: unknown) {
    aiDebug.error('An unexpected error occurred during API key validation:', error);
    return false;
  }
};

/**
 * Gets the AI service configuration from environment variables
 * @returns AI service configuration
 */
import { loadConfig } from '../utils/config';
import type { AppConfig } from '../types';

export const getAIServiceConfig = (config?: Partial<AppConfig>): AIServiceConfig => {
  const effectiveConfig = config || {};
  // Check if we're in a browser context
  // In browser: window exists and document exists
  // In Node.js: neither window nor document exist
  const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

  // Ollama can be used on server-side only (local inference)
  const useOllama = !isBrowser && process.env.USE_OLLAMA === 'true';

  // Vertex AI cannot be used in browser context - it requires server-side authentication
  // Always use API key in browser, only use Vertex AI on server
  const useVertexAI = !isBrowser && process.env.USE_VERTEX_AI === 'true' && !useOllama;
  const apiKey = (effectiveConfig.geminiApiKey || process.env.GEMINI_API_KEY)?.trim();

  // Debug logging for API key configuration

  if (useOllama) {
    const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    // Default to enhanced Finnish model for better Finnish language support
    const model = process.env.OLLAMA_MODEL || 'finnish-llama3-comprehensive';
    const temperature = process.env.OLLAMA_TEMPERATURE ? parseFloat(process.env.OLLAMA_TEMPERATURE) : 0.7;
    const topP = process.env.OLLAMA_TOP_P ? parseFloat(process.env.OLLAMA_TOP_P) : 0.9;
    const topK = process.env.OLLAMA_TOP_K ? parseInt(process.env.OLLAMA_TOP_K, 10) : 40;

    aiDebug.log('🔧 Initializing Ollama service...');
    aiDebug.log(`   Base URL: ${baseUrl}`);
    aiDebug.log(`   Model: ${model}`);

    return {
      useVertexAI: false,
      useOllama: true,
      apiKey: apiKey, // Include API key for fallback scenarios (when Ollama fails)
      ollama: {
        enabled: true,
        baseUrl,
        model,
        temperature,
        topP,
        topK
      }
    };
  } else if (useVertexAI) {
    const project = process.env.VERTEX_AI_PROJECT;
    const location = process.env.VERTEX_AI_LOCATION || 'us-central1';

    if (!project) {
      throw new Error('VERTEX_AI_PROJECT environment variable is required when USE_VERTEX_AI is true');
    }

    return {
      useVertexAI: true,
      useOllama: false,
      vertexAI: {
        enabled: true,
        project,
        location
      }
    };
  } else {
    // API key is optional when Ollama is enabled (only needed as fallback)
    // Only throw error if no API key AND Ollama is not enabled AND Vertex AI is not enabled
    if (!apiKey && !useOllama && !useVertexAI) {
      aiDebug.warn('⚠️  No API key provided and Ollama is not enabled. AI generation will fail.');
      // Don't throw - allow the app to start and fail gracefully when AI is needed
    }

    return {
      useVertexAI: false,
      useOllama: false,
      apiKey: apiKey || undefined
    };
  }
};

/**
 * Singleton instance of the AI service
 */
let aiServiceInstance: GoogleGenAI | null = null;

/**
 * Gets or creates the AI service instance
 * @returns GoogleGenAI instance
 */
export const getAIService = (): GoogleGenAI => {
  const config = getAIServiceConfig();
  
  // Recreate instance if:
  // 1. No instance exists, OR
  // 2. Current instance has dummy key but we now have a real API key (for fallback scenarios)
  //    This is important when Ollama is primary but Gemini is used as fallback
  const currentInstanceHasDummyKey = aiServiceInstance && (aiServiceInstance as any).apiKey?.startsWith('dummy-key');
  const hasRealApiKey = config.apiKey && !config.apiKey.startsWith('dummy-key') && config.apiKey.trim().length >= 10;
  const needsRecreate = !aiServiceInstance || 
    (hasRealApiKey && !config.useVertexAI && currentInstanceHasDummyKey);
  
  if (needsRecreate) {
    aiServiceInstance = createAIService(config);

    if (config.apiKey && !config.apiKey.startsWith('dummy-key')) {
      validateGeminiApiKey(config.apiKey).then(isValid => {
        if (!isValid) {
          aiDebug.error('❌ Invalid Gemini API Key. Please check your .env file.');
        } else {
          aiDebug.log('✅ Gemini API Key validated successfully.');
        }
      });
    }

    aiDebug.log('✅ AI Service initialized successfully');
    aiDebug.log(`   Mode: ${config.useVertexAI ? 'Vertex AI' : config.useOllama ? 'Ollama (Gemini fallback)' : 'API Key'}`);
    if (config.apiKey && !config.apiKey.startsWith('dummy-key')) {
      aiDebug.log(`   API Key: ${config.apiKey.substring(0, 10)}...${config.apiKey.substring(config.apiKey.length - 4)}`);
    }
  }

  // Always return a valid instance (createAIService always returns a GoogleGenAI, never null)
  return aiServiceInstance!;
};

/**
 * Resets the AI service instance (useful for testing or reconfiguration)
 */
export const resetAIService = (config?: AppConfig): void => {
  const serviceConfig = getAIServiceConfig(config);
  aiServiceInstance = createAIService(serviceConfig);
  aiDebug.log('🔄 AI Service instance reset and re-initialized');
};
