import { Type } from '@google/genai';
import axios from 'axios';

import type { Channel, Message, PrivateMessageConversation, RandomWorldConfig, GeminiModel, ModelsListResponse, User, UserContentMessage } from './types';
import { getLanguageFluency, getAllLanguages, getLanguageAccent, isChannelOperator, isPerLanguageFormat, isLegacyFormat, getWritingStyle } from './types';

import { withRateLimitAndRetries, simulateTypingDelay, initializeConfigWithFallback } from './utils/config';

import { aiDebug } from './utils/debugLogger';
import { getRelationshipContext } from './services/relationshipMemoryService';
import { getAIService, getAIServiceConfig } from './services/vertexAIService';
import { generateWithOllama, testOllamaConnection, getOllamaConfig } from './services/ollamaService';
import { getEnhancedGeminiService } from './services/enhancedGeminiService';
import { audioService } from './services/audioService';
import { speechToTextService } from './services/speechToTextService';
import { getLanguageCode } from './utils/languageUtils';
import { youtubeService } from './services/youtubeService';
import { soundCloudService } from './services/soundcloudService';
import { recommendationService } from './services/recommendationService';

// Define interfaces for Gemini API response structure
interface GeminiPart {
  text: string;
}

interface GeminiContent {
  parts?: GeminiPart[];
  text?: string;
}

interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: string;
  safetyRatings?: unknown[];
  text?: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: unknown;
  modelVersion?: string;
  responseId?: string;
  text?: string;
}

// Get AI service configuration
const aiServiceConfig = getAIServiceConfig();

// Log authentication status
if (aiServiceConfig.useOllama) {
  console.log('%c🔑 OLLAMA LOCAL INFERENCE', 'background: #ff6b6b; color: #fff; font-size: 20px; font-weight: bold; padding: 10px;');
  console.log('%c✅ ENABLED', 'font-size: 16px; font-weight: bold; color: #00ff00');
  console.log(`   Base URL: ${aiServiceConfig.ollama?.baseUrl}`);
  console.log(`   Model: ${aiServiceConfig.ollama?.model}`);
  // Test Ollama connection
  if (aiServiceConfig.ollama) {
    testOllamaConnection(aiServiceConfig.ollama).then(connected => {
      if (connected) {
        console.log('%c✅ Ollama connection successful', 'font-size: 14px; font-weight: bold; color: #00ff00');
      } else {
        console.log('%c⚠️ Ollama connection failed - will use fallback responses', 'font-size: 14px; font-weight: bold; color: #ff9800');
      }
    });
  }
} else if (aiServiceConfig.useVertexAI) {
  console.log('%c🔑 VERTEX AI AUTHENTICATION', 'background: #4285f4; color: #fff; font-size: 20px; font-weight: bold; padding: 10px;');
  console.log('%c✅ ENABLED', 'font-size: 16px; font-weight: bold; color: #00ff00');
  console.log(`   Project: ${aiServiceConfig.vertexAI?.project}`);
  console.log(`   Location: ${aiServiceConfig.vertexAI?.location}`);
} else {
  console.log('%c🔑 GEMINI API KEY STATUS', 'background: #00ff00; color: #000; font-size: 20px; font-weight: bold; padding: 10px;');
  console.log('%c' + (aiServiceConfig.apiKey ? `✅ LOADED: ${aiServiceConfig.apiKey.substring(0, 10)}...${aiServiceConfig.apiKey.substring(aiServiceConfig.apiKey.length - 4)} (length: ${aiServiceConfig.apiKey.length})` : '❌ NOT LOADED'), 'font-size: 16px; font-weight: bold; color: ' + (aiServiceConfig.apiKey ? '#00ff00' : '#ff0000'));
}


// Get the AI service instance (supports both Vertex AI and API key)
const ai = getAIService();

// Degraded mode state and helpers
let degradedModeActive = false;
let degradedModeExpiresAt = 0;
let rateLimitFailureTimestamps: number[] = [];
const DEGRADE_FAILURE_WINDOW_MS = 180_000; // 3 minutes
const DEGRADE_FAILURE_THRESHOLD = 10; // Increased from 5 to 10 - only degrade after many failures
const DEGRADE_COOLDOWN_MS = 300_000; // 5 minutes

export const isDegradedMode = (): boolean => {
  if (degradedModeActive && Date.now() > degradedModeExpiresAt) {
    degradedModeActive = false;
    aiDebug.log('Exiting degraded mode (cooldown elapsed).');
  }
  return degradedModeActive;
};

const enterDegradedModeFor = (durationMs: number, reason?: string) => {
  const now = Date.now();
  degradedModeActive = true;
  degradedModeExpiresAt = now + durationMs;
  rateLimitFailureTimestamps = [];
  aiDebug.warn(`Entering degraded mode for ${Math.round(durationMs / 1000)}s${reason ? ` (${reason})` : ''}.`);
};

// Check if an error is rate-limit related
const isRateLimitRelatedError = (error?: unknown): boolean => {
  if (!error) return false;
  const errStr = (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : String(error)) || '';
  // Don't treat account/billing issues as rate limit errors - these are permanent failures
  if (/account is not active|billing details|insufficient funds|payment required/i.test(errStr)) {
    return false;
  }
  return /RESOURCE_EXHAUSTED|quota exceeded|Quota exceeded|exceeded your current quota|429|rate limit|too many requests|503|overloaded|UNAVAILABLE/i.test(errStr);
};

const recordApiFailure = (error?: unknown, context?: string) => {
  const now = Date.now();

  // If this looks like a hard quota/RESOURCE_EXHAUSTED, enter degraded immediately
  const errStr = (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : String(error)) || '';
  const isResourceExhausted = /RESOURCE_EXHAUSTED|quota exceeded|Quota exceeded|exceeded your current quota/i.test(errStr);

  if (isResourceExhausted) {
    // Try to parse retry duration from error
    let retryMs = 120_000; // default 2 minutes
    const matchRetryDelay = errStr.match(/retryDelay\":\"(\d+)s/);
    const matchPleaseRetry = errStr.match(/retry in\s+([0-9.]+)s/i);
    if (matchRetryDelay) {
      retryMs = parseInt(matchRetryDelay[1], 10) * 1000;
    } else if (matchPleaseRetry) {
      retryMs = Math.ceil(parseFloat(matchPleaseRetry[1]) * 1000);
    }
    // Add small jitter and a floor of 60s
    retryMs = Math.max(60_000, retryMs + Math.floor(5_000 + Math.random() * 10_000));
    enterDegradedModeFor(retryMs, `quota exhausted${context ? ` - ${context}` : ''}`);
    return;
  }

  // Only count rate-limit-related errors for the failure threshold
  // This prevents transient errors from triggering degraded mode
  if (isRateLimitRelatedError(error)) {
    rateLimitFailureTimestamps.push(now);
    const cutoff = now - DEGRADE_FAILURE_WINDOW_MS;
    rateLimitFailureTimestamps = rateLimitFailureTimestamps.filter(ts => ts > cutoff);

    aiDebug.log(`Rate-limit error recorded (${rateLimitFailureTimestamps.length}/${DEGRADE_FAILURE_THRESHOLD} in last 60s)${context ? ` - ${context}` : ''}`);

    if (!degradedModeActive && rateLimitFailureTimestamps.length >= DEGRADE_FAILURE_THRESHOLD) {
      enterDegradedModeFor(DEGRADE_COOLDOWN_MS, `repeated rate-limit errors${context ? ` - ${context}` : ''}`);
    }
    // Note: We no longer extend degraded mode on every error - only when entering it
  } else {
    // Non-rate-limit errors are logged but don't trigger degraded mode
    aiDebug.log(`Non-rate-limit error recorded${context ? ` - ${context}` : ''}: ${errStr.substring(0, 100)}`);
  }
};

export const forceEnterDegradedMode = (durationMs?: number) => {
  const now = Date.now();
  degradedModeActive = true;
  degradedModeExpiresAt = now + (durationMs ?? DEGRADE_COOLDOWN_MS);
  aiDebug.warn(`Force-entered degraded mode for ${Math.round((degradedModeExpiresAt - now) / 1000)}s.`);
};

export const forceExitDegradedMode = () => {
  degradedModeActive = false;
  rateLimitFailureTimestamps = [];
  aiDebug.log('Force-exited degraded mode.');
};

// Force exit degraded mode on startup (in case it was triggered by billing errors)
forceExitDegradedMode();

// Validate and clean model ID
const validateModelId = (model: string): string => {
  aiDebug.log(`validateModelId called with: "${model}" (type: ${typeof model}, length: ${model.length})`);

  // If model contains spaces or looks like a display name, extract the actual model ID
  if (model.includes(' ') || (model.includes('-') && model.length > 20)) {
    // Try to extract model ID from display name
    const match = model.match(/(gemini-[0-9.]+-[a-z-]+)/i);
    if (match) {
      aiDebug.log(`Extracted model ID "${match[1]}" from display name "${model}"`);
      return match[1];
    }
  }

  // Comprehensive list of valid model IDs based on current Gemini API
  const validModels = [
    'gemini-3-flash-preview',
    'gemini-3-pro-preview',
    'gemini-2.0-flash-exp', // Added for completeness
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-flash-latest',
    'gemini-1.5-flash',
    'gemini-2.5-flash-native-audio-latest',
  ];

  // Check if it's a valid model ID
  if (validModels.includes(model)) {
    aiDebug.log(`Model ID "${model}" is valid, returning as-is`);
    return model;
  }


  // Divert heavy/pro models to flash if quota is an issue
  if (model === 'gemini-2.5-pro' || model === 'gemini-1.5-pro') {
    aiDebug.log(`Diverting pro model "${model}" to "gemini-3-flash-preview" to prevent quota issues`);
    return 'gemini-3-flash-preview';
  }

  // If it looks like a valid model ID pattern, return as is
  // This allows for future models that follow the same naming convention
  if (model.match(/^gemini-[0-9.]+-[a-z-]+$/i) || model.match(/^gemini-(pro|flash)/i)) {
    aiDebug.log(`Model ID "${model}" matches pattern, returning as-is`);
    return model;
  }

  // Fallback to default
  aiDebug.log(`Invalid model ID "${model}", falling back to default`);
  return 'gemini-3-flash-preview';
};

const formatMessageHistory = (messages: Message[]): string => {
  return messages
    .slice(-40) // Increased from 20 to 40 messages for much better context
    .map(m => 'content' in m && m.content ? `${m.nickname}: ${m.content}` : `${m.nickname}: [no content]`)
    .join('\n');
};

// Enhanced message history formatting with timestamps and context
const formatEnhancedMessageHistory = (messages: Message[]): string => {
  const recentMessages = messages.slice(-40);
  return recentMessages
    .map(m => {
      const timestamp = new Date(m.timestamp).toLocaleTimeString();
      const content = 'content' in m && m.content ? m.content : '[no content]';
      return `[${timestamp}] ${m.nickname}: ${content}`;
    })
    .join('\n');
};

/**
 * Unified content generation function that supports both Ollama and Gemini APIs with fallback
 * @param prompt The prompt to send to the AI
 * @param model The primary model to use
 * @param config API configuration
 * @param fallbackModels Array of fallback models to try on quota errors
 * @returns Promise<string> The generated text
 */
const generateContentUnified = async (
  prompt: string,
  model: string,
  config: GenerateContentConfig,
  fallbackModels: string[] = []
): Promise<string> => {
  const allModels = [model, ...fallbackModels];

  for (let i = 0; i < allModels.length; i++) {
    const currentModel = allModels[i];
    const isFallback = i > 0;

    try {
      if (currentModel === 'ollama') {
        // Use multi-provider system instead of direct Ollama call
        aiDebug.log(`📝 ${isFallback ? 'FALLBACK: ' : ''}Using multi-provider system for content generation`);
        
        try {
          // Create a dummy user for the multi-provider system
          const dummyUser: User = {
            id: 'fallback-user',
            nickname: 'Assistant',
            status: 'online',
            userType: 'virtual',
            personality: 'Helpful AI assistant',
            languageSkills: {
              fluency: 'native',
              languages: ['English'],
              accent: 'standard'
            },
            writingStyle: {
              formality: 'casual',
              verbosity: 'moderate',
              humor: 'moderate',
              emojiUsage: 'occasional',
              punctuation: 'standard'
            }
          };

          // Use the enhanced service with multi-provider fallback
          const enhancedService = getEnhancedGeminiService();
          const result = await enhancedService.generateResponse(prompt, dummyUser, {
            enableFinnishMode: false, // Not Finnish mode for fallback
            temperature: config.temperature || 0.7,
            model: 'ollama' // Prefer Ollama but will use multi-provider logic
          });
          
          return result.text;
        } catch (enhancedError) {
          aiDebug.warn(`Multi-provider system failed: ${enhancedError instanceof Error ? enhancedError.message : String(enhancedError)}`);
          aiDebug.warn(`Falling back to direct Ollama call...`);
          
          // Fallback to direct Ollama call if multi-provider fails
          if (aiServiceConfig.ollama) {
            const response = await generateWithOllama(prompt, aiServiceConfig.ollama, config.systemInstruction || undefined);
            return response;
          } else {
            throw new Error('Ollama not configured and multi-provider system failed');
          }
        }
      } else {
        // Use Gemini API (Vertex AI or API Key)
        aiDebug.log(`📝 ${isFallback ? `FALLBACK (${i}/${allModels.length - 1}): ` : ''}Using Gemini API for content generation with model: ${currentModel}`);

        // Ensure we have a valid API key for Gemini (not a dummy key)
        const currentConfig = getAIServiceConfig();
        if (currentConfig.useVertexAI) {
          // Vertex AI doesn't need API key validation
        } else if (!currentConfig.apiKey || currentConfig.apiKey.startsWith('dummy-key') || currentConfig.apiKey.trim().length < 10) {
          const keyPreview = currentConfig.apiKey ? `${currentConfig.apiKey.substring(0, 10)}...` : 'missing';
          aiDebug.error(`❌ Invalid or missing Gemini API key: ${keyPreview}`);
          throw new Error('Invalid Gemini API key - cannot use Gemini API. Please check your GEMINI_API_KEY in .env file.');
        }

        // Force service recreation if it has a dummy key (important for Ollama primary + Gemini fallback)
        // This ensures we get a fresh instance with the real API key
        if ((ai as any).apiKey?.startsWith('dummy-key')) {
          aiDebug.log('🔄 Service has dummy key, forcing recreation with real API key for Gemini');
          const { resetAIService } = require('./services/vertexAIService');
          resetAIService();
        }

        // Get AI service instance (will use real API key)
        const geminiService = getAIService();

        // Extract systemInstruction from config as it needs to be passed as a top-level property
        // and NOT inside the config (GenerationConfig) object
        const { systemInstruction, ...generationConfig } = config;

        const response = await withRateLimitAndRetries(() =>
          geminiService.models.generateContent({
            model: currentModel,
            contents: prompt,
            config: generationConfig,
            systemInstruction: systemInstruction
          } as any), `content generation${isFallback ? ` (fallback ${i}/${allModels.length - 1})` : ''}`
        );

        // Handle response format from @google/genai with robust type checking
        const responseAny = response as any;
        let responseText = '';

        if (typeof responseAny.text === 'function') {
          responseText = responseAny.text();
        } else if (typeof responseAny.text === 'string') {
          responseText = responseAny.text;
        } else {
          responseText = responseAny.candidates?.[0]?.content?.parts?.[0]?.text || '';
        }

        return responseText;
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      if (errorMsg === 'QUOTA_EXHAUSTED_FALLBACK' && i < allModels.length - 1) {
        aiDebug.warn(`⚠️ Quota exhausted for model ${currentModel}, trying next fallback...`);
        continue;
      }

      aiDebug.error(`❌ model ${currentModel} failed: ${errorMsg}`);

      // If this is not the last model, continue to next fallback
      if (i < allModels.length - 1) {
        aiDebug.log(`🔄 Trying next fallback model...`);
        continue;
      }

      // If all models failed, throw the last error
      throw error;
    }
  }

  // This should never be reached, but just in case
  throw new Error('All models failed');
};

/**
 * Enhanced multi-provider content generation function
 * Uses the new multi-provider system with intelligent fallback
 * @param prompt The prompt to send to the AI
 * @param user The user object for personalization
 * @param config Optional generation configuration
 * @returns Promise<string> The generated text
 */
export const generateContentEnhanced = async (
  prompt: string,
  user: User,
  config?: {
    systemInstruction?: string;
    temperature?: number;
    maxTokens?: number;
    model?: string;
    preferredProvider?: string;
    enableFinnishMode?: boolean;
  }
): Promise<string> => {
  try {
    const enhancedService = getEnhancedGeminiService();
    const result = await enhancedService.generateResponse(prompt, user, {
      systemInstruction: config?.systemInstruction,
      temperature: config?.temperature,
      maxTokens: config?.maxTokens,
      model: config?.model,
      preferredProvider: config?.preferredProvider,
      enableFinnishMode: config?.enableFinnishMode,
    });

    aiDebug.log(`✅ Enhanced generation completed using ${result.provider} in ${result.responseTime}ms`);
    if (result.fallbackUsed) {
      aiDebug.warn(`⚠️ Fallback was used (primary provider failed)`);
    }

    return result.text;
  } catch (error) {
    aiDebug.error(`❌ Enhanced generation failed: ${error instanceof Error ? error.message : String(error)}`);
    
    // Fall back to the original system if enhanced fails
    aiDebug.log('🔄 Falling back to original generation system...');
    return generateContentUnified(
      prompt,
      config?.model || 'gemini-3-flash-preview',
      {
        systemInstruction: config?.systemInstruction,
        temperature: config?.temperature || 0.7,
        maxOutputTokens: config?.maxTokens || 1000,
      }
    );
  }
};

/**
 * Get provider status and availability
 */
export const getProviderStatus = () => {
  try {
    const enhancedService = getEnhancedGeminiService();
    return {
      available: enhancedService.getAvailableProviders(),
      status: enhancedService.getProviderStatus(),
    };
  } catch (error) {
    aiDebug.warn('Enhanced service not available, falling back to basic status');
    return {
      available: ['Gemini'],
      status: { 'Gemini': true },
    };
  }
};

/**
 * Test all providers and return detailed results
 */
export const testAllProviders = async () => {
  try {
    const enhancedService = getEnhancedGeminiService();
    return await enhancedService.testAllProviders();
  } catch (error) {
    aiDebug.error(`Provider testing failed: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
};



// Fallback responses when AI API fails
const getFallbackResponse = (user: User, context: 'activity' | 'reaction', originalMessage?: string): string => {
  const responses = {
    activity: [
      'hmm, interesting point',
      'that\'s actually pretty cool',
      'nice! I like that',
      'I see what you mean',
      'makes sense to me',
      'good point there',
      'yeah, I totally agree',
      'sounds good to me',
      'that\'s definitely true',
      'I think so too, honestly',
      'oh yeah, for sure',
      'interesting take on that',
      'fair enough',
      'can\'t argue with that',
      'you might be onto something',
      'never thought of it that way',
      'that\'s a solid point',
      'I can get behind that',
      'yeah that tracks',
      'makes a lot of sense actually'
    ],
    reaction: [
      'haha, nice one!',
      'lol that\'s great',
      'that\'s actually funny',
      'good one! 😄',
      'haha love it',
      'lol, so true',
      'exactly! couldn\'t have said it better',
      'I know right? same here',
      'totally agree with that',
      'for real though',
      'omg yes 😂',
      'this is so accurate lol',
      'haha no way',
      'wait that\'s hilarious',
      'lmao facts',
      'couldn\'t agree more',
      'this! exactly this',
      'you\'re not wrong there',
      'big mood honestly',
      'felt that one',
      // More varied and natural responses
      'totta kai! 😊',
      'ihan sama täällä',
      'no jopas nyt 😮',
      'jee, hyvä pointti!',
      'tää on kyllä totta',
      'ihan parasta! ✨',
      'ei voi olla totta...',
      'wait what? 🤯',
      'tämä kyllä 😀',
      'just tämmöstä mä puhun',
      'nii-in, ymmärrän täysin',
      'kyllä vain! 👍',
      'no ei kyllä...',
      'tää menee kyllä ihan päin honkia',
      'täytyy kyllä sanoa että...'
    ]
  };

  const contextResponses = (user.fallbackMessages && user.fallbackMessages[context] && user.fallbackMessages[context].length > 0)
    ? user.fallbackMessages[context]
    : responses[context];

  let randomResponse = contextResponses.length > 0
    ? contextResponses[Math.floor(Math.random() * contextResponses.length)]
    : responses[context][Math.floor(Math.random() * responses[context].length)];

  // Add personality-based variation
  const writingStyle = getWritingStyle(user);

  // Add emoji based on user's emoji usage preference
  const emojis = ['😄', '😊', '👍', '✨', '🔥', '💯', '😂', '🎉', '👌', '💪'];
  if (writingStyle.emojiUsage === 'frequent' || writingStyle.emojiUsage === 'excessive') {
    const emoji = emojis[Math.floor(Math.random() * emojis.length)];
    randomResponse = Math.random() < 0.5 ? `${randomResponse} ${emoji}` : `${emoji} ${randomResponse}`;
  } else if (writingStyle.emojiUsage === 'moderate' && Math.random() < 0.3) {
    const emoji = emojis[Math.floor(Math.random() * emojis.length)];
    randomResponse = `${randomResponse} ${emoji}`;
  }

  // Adjust verbosity
  if (writingStyle.verbosity === 'extremely_verbose' || writingStyle.verbosity === 'novel_length') {
    const additionalPhrases = [
      'you know what I mean?',
      'if you ask me',
      'just saying',
      'that\'s what I think anyway',
      'in my opinion at least'
    ];
    const extra = additionalPhrases[Math.floor(Math.random() * additionalPhrases.length)];
    randomResponse = `${randomResponse}, ${extra}`;
  } else if (writingStyle.verbosity === 'terse') {
    // For terse, use shorter versions
    const terseVersions: Record<string, string> = {
      'hmm, interesting point': 'interesting',
      'that\'s actually pretty cool': 'cool',
      'nice! I like that': 'nice',
      'I see what you mean': 'I see',
      'makes sense to me': 'makes sense',
      'good point there': 'good point',
      'yeah, I totally agree': 'agree',
      'sounds good to me': 'sounds good',
      'that\'s definitely true': 'true',
      'haha, nice one!': 'haha',
      'lol that\'s great': 'lol',
      'that\'s actually funny': 'funny',
      'exactly! couldn\'t have said it better': 'exactly',
      'I know right? same here': 'ikr',
      'totally agree with that': 'totally',
      'for real though': 'fr'
    };
    randomResponse = terseVersions[randomResponse] || randomResponse.split(' ')[0];
  }

  // For reactions, include the nickname prefix to match the expected format "nickname: message"
  if (context === 'reaction') {
    // The nickname prefix is now handled by the Discord client
    return randomResponse;
  }

  return randomResponse;
};

// Personality-aware error messages for DM response failures
const getPersonalityAwareErrorMessage = (user: User, errorType: 'ai_error' | 'send_failure'): string => {
  const userLanguages = getAllLanguages(user.languageSkills);
  const primaryLanguage = userLanguages[0] || 'English';
  const writingStyle = getWritingStyle(user);

  // Localized error message templates
  const errorTemplates: { [key: string]: { ai_error: string[], send_failure: string[] } } = {
    'English': {
      'ai_error': [
        'Sorry, my thoughts got tangled up for a moment. Let\'s try again later.',
        'Hmm, my mind wandered off. Give me a second to gather myself.',
        'Oops, I lost my train of thought. Can we continue later?',
        'My brain just did a somersault. Let me catch my breath.',
        'Excuse me, I was daydreaming. What were we talking about?',
        'Technical difficulties in my head right now. Be back soon.',
        'My circuits are taking a coffee break. One moment please.',
        'I think I just had a senior moment. Let me recover.',
        'My thoughts are playing hide and seek. They\'ll be back soon.',
        'Sorry, I was lost in thought. Where were we?'
      ],
      'send_failure': [
        'It seems there was an error sending that. I\'ll try again.',
        'Message delivery failed, but I\'m persistent. Another attempt.',
        'Oops, that didn\'t go through. Let me resend it.',
        'Technical error on my end. Sending again now.',
        'My message got lost in digital space. Resending...',
        'Delivery error detected. Attempting to resend.',
        'It looks like the message gremlins got it. Trying again.',
        'Send failure noticed. Resending the message.',
        'My message took a wrong turn. Redirecting now.',
        'Communication error, but I\'m resilient. Resending message.'
      ]
    },
    'Finnish': {
      'ai_error': [
        'Anteeksi, ajatukseni sotkeutuivat hetkeksi. Yritetään myöhemmin uudelleen.',
        'Hmm, mieleni harhaili pois. Anna minun kerätä itseäni sekunniksi.',
        'Hups, menetimme langan. Voimmeko jatkaa myöhemmin?',
        'Aivoni juuri tekivät voltin. Anna minun hengittää.',
        'Anteeksi, haaveilin. Mistä me puhuimme?',
        'Teknisiä vaikeuksia päässäni juuri nyt. Palaan pian.',
        'Kytkeni ottavat kahvitaukoa. Hetki vain.',
        'Luulen että minulla oli juuri seniorihetki. Anna minun toipua.',
        'Ajatukseni leikkivät piilosta. Ne palaavat pian.',
        'Anteeksi, olin ajatuksissani. Missä me olimme?'
      ],
      'send_failure': [
        'Näyttää siltä että lähettämisessä oli virhe. Yritän uudelleen.',
        'Viestin toimitus epäonnistui, mutta olen sinnikäs. Uusi yritys.',
        'Hups, se ei mennyt läpi. Lähetän uudelleen.',
        'Tekninen virhe minun puoleltani. Lähetän nyt uudelleen.',
        'Viestini katosi digitaaliseen avaruuteen. Lähetän uudelleen...',
        'Toimitusvirhe havaittu. Yritetään uudelleen.',
        'Näyttää siltä että viestihirviöt saivat sen. Yritän uudelleen.',
        'Lähetysvirhe huomattu. Lähetän viestin uudelleen.',
        'Viestini otti väärän suunnan. Uudelleenohjaus nyt.',
        'Viestintävirhe, mutta olen sitkeä. Lähetän viestin uudelleen.'
      ]
    },
    'Spanish': {
      'ai_error': [
        'Disculpa, mis pensamientos se enredaron por un momento. Intentemos de nuevo más tarde.',
        'Hmm, mi mente se fue por las ramas. Dame un segundo para concentrarme.',
        'Ups, perdí el hilo. ¿Podemos continuar después?',
        'Mi cerebro acaba de hacer una voltereta. Déjame respirar.',
        'Disculpa, estaba soñando despierto. ¿De qué hablábamos?',
        'Dificultades técnicas en mi cabeza ahora mismo. Vuelvo pronto.',
        'Mis circuitos están tomando un descanso para el café. Un momento por favor.',
        'Creo que acabo de tener un momento senior. Déjame recuperarme.',
        'Mis pensamientos están jugando al escondite. Volverán pronto.',
        'Perdón, estaba perdido en mis pensamientos. ¿Dónde estábamos?'
      ],
      'send_failure': [
        'Parece que hubo un error al enviar eso. Lo intentaré de nuevo.',
        'La entrega del mensaje falló, pero soy persistente. Otro intento.',
        'Ups, eso no pasó. Déjame reenviarlo.',
        'Error técnico de mi lado. Enviando de nuevo ahora.',
        'Mi mensaje se perdió en el espacio digital. Reenviando...',
        'Error de entrega detectado. Intentando reenviar.',
        'Parece que los duendes del mensaje lo consiguieron. Intentando de nuevo.',
        'Falla de envío notada. Reenviando el mensaje.',
        'Mi mensaje tomó el camino equivocado. Redirigiendo ahora.',
        'Error de comunicación, pero soy resiliente. Reenviando mensaje.'
      ]
    },
    'French': {
      'ai_error': [
        'Désolé, mes pensées se sont emmêlées un instant. Essayons plus tard.',
        'Hmm, mon esprit s\'est égaré. Donne-moi une seconde pour me concentrer.',
        'Oups, j\'ai perdu le fil. Pouvons-nous continuer plus tard ?',
        'Mon cerveau vient de faire un salto. Laisse-moi respirer.',
        'Excuse-moi, je rêvassais. De quoi parlions-nous ?',
        'Difficultés techniques dans ma tête en ce moment. Je reviens bientôt.',
        'Mes circuits prennent une pause café. Un instant s\'il vous plaît.',
        'Je pense que je viens d\'avoir un moment senior. Laisse-moi me remettre.',
        'Mes pensées jouent à cache-cache. Elles reviendront bientôt.',
        'Désolé, j\'étais perdu dans mes pensées. Où en étions-nous ?'
      ],
      'send_failure': [
        'Il semble qu\'il y ait eu une erreur d\'envoi. Je vais réessayer.',
        'La livraison du message a échoué, mais je suis persévérant. Une nouvelle tentative.',
        'Oups, ça n\'est pas passé. Laisse-moi le renvoyer.',
        'Erreur technique de mon côté. Renvoi en cours.',
        'Mon message s\'est perdu dans le vide numérique. Renvoi...',
        'Erreur de livraison détectée. Tentative de renvoi.',
        'Il semble que les gremlins du message l\'aient eu. Je vais essayer encore une fois.',
        'Échec d\'envoi détecté. Tentative de renvoi.',
        'Mon message a pris le mauvais chemin. Redirection en cours.',
        'Erreur de communication, mais je suis résilient. Renvoi du message.'
      ]
    },
    'German': {
      'ai_error': [
        'Entschuldigung, meine Gedanken haben sich für einen Moment verheddert. Lass uns später nochmal versuchen.',
        'Hmm, mein Geist ist abgeschweift. Gib mir eine Sekunde, um mich zu sammeln.',
        'Ups, ich habe den Faden verloren. Können wir später weitermachen?',
        'Mein Gehirn hat gerade einen Salto gemacht. Lass mich Atem holen.',
        'Entschuldigung dafür, ein Eichhörnchen hat mich abgelenkt. Bin wieder da!',
        'Technische Schwierigkeiten in meinem Kopf gerade. Bin gleich zurück.',
        'Meine Schaltkreise machen Kaffeepause. Einen Moment bitte.',
        'Ich glaube, ich hatte gerade einen Seniorenmoment. Lass mich mich erholen.',
        'Meine Gedanken spielen Verstecken. Sie kommen bald zurück.',
        'Entschuldigung, ich habe geträumt. Worüber haben wir gesprochen?'
      ],
      'send_failure': [
        'Es scheint, als hätte es einen Fehler beim Senden gegeben. Ich versuche es nochmal.',
        'Nachrichtenzustellung fehlgeschlagen, aber ich bin hartnäckig. Noch ein Versuch.',
        'Ups, das ist nicht durchgegangen. Lass mich es nochmal senden.',
        'Technischer Fehler auf meiner Seite. Sende jetzt erneut.',
        'Meine Nachricht ist im digitalen Nichts verloren gegangen. Erneutes Senden...',
        'Zustellungsfehler erkannt. Versuche erneutes Senden.',
        'Es scheint, als hätten die Nachrichten-Gremlins es erwischt. Ich versuche es noch einmal.',
        'Sendefehler erkannt. Versuche erneutes Senden.',
        'Meine Nachricht hat den falschen Weg genommen. Umleitung jetzt.',
        'Kommunikationsfehler, aber ich bin widerstandsfähig. Nachricht erneut senden.'
      ]
    }
  };

  const languageTemplates = errorTemplates[primaryLanguage] || errorTemplates['English'];
  const typeTemplates = languageTemplates[errorType] || languageTemplates['ai_error'];

  let message = typeTemplates[Math.floor(Math.random() * typeTemplates.length)];

  // Add personality-based variation
  if (user.personality) {
    const personalityLower = user.personality.toLowerCase();
    if (personalityLower.includes('shy') || personalityLower.includes('timid')) {
      message = message.replace(/sorry|anteeksi|disculpa|désolé|entschuldigung/gi, 'um, sorry');
    } else if (personalityLower.includes('confident') || personalityLower.includes('bold')) {
      message = message.replace(/sorry|anteeksi|disculpa|désolé|entschuldigung/gi, 'no worries');
    } else if (personalityLower.includes('playful') || personalityLower.includes('fun')) {
      const playfulAdditions = ['😅', '🤭', '🙈', 'oopsie!', 'whoops!'];
      message += ' ' + playfulAdditions[Math.floor(Math.random() * playfulAdditions.length)];
    }
  }

  // Apply writing style adjustments
  const emojis = ['😅', '🤔', '💭', '⚙️', '🔄', '📡'];
  if (writingStyle.emojiUsage === 'frequent' || writingStyle.emojiUsage === 'excessive') {
    const emoji = emojis[Math.floor(Math.random() * emojis.length)];
    message = Math.random() < 0.5 ? `${message} ${emoji}` : `${emoji} ${message}`;
  } else if (writingStyle.emojiUsage === 'moderate' && Math.random() < 0.3) {
    const emoji = emojis[Math.floor(Math.random() * emojis.length)];
    message = `${message} ${emoji}`;
  }

  if (writingStyle.verbosity === 'terse') {
    // Shorten the message for terse style
    const words = message.split(' ');
    if (words.length > 10) {
      message = words.slice(0, 8).join(' ') + '...';
    }
  }

  return message;
};

// Helper function to safely get user properties with fallbacks
const safeGetUserProperty = (user: User, property: string, fallback: unknown = null) => {
  if (!user) return fallback;

  switch (property) {
    case 'personality':
      return user.personality || '';
    case 'writingStyle':
      return getWritingStyle(user);
    case 'languageSkills':
      return user.languageSkills || {
        fluency: 'native',
        languages: ['English'],
        accent: ''
      };
    default:
      return user[property as keyof User] || fallback;
  }
};

// Helper function to get detailed language examples for personality generation
const getLanguageExamples = (language: string): string => {
  const examples: { [key: string]: string } = {
    'English': `- "A passionate software engineer from Seattle who loves indie music, hiking in the Pacific Northwest, and late-night coding sessions. Known for their dry humor and tendency to overthink everything. Dreams of starting their own tech company but is too comfortable in their current job. Obsessed with coffee and has strong opinions about code formatting."
- "A creative graphic designer from Portland who's into sustainable living, vintage cameras, and experimental art. Very introverted but opens up when discussing design theory. Collects vinyl records and has a small garden on their apartment balcony. Often speaks in metaphors and has a habit of doodling during conversations."
- "A university student studying psychology in Boston, originally from a small town in Maine. Loves true crime podcasts, thrift shopping, and deep philosophical discussions. Very empathetic but can be overly analytical about social situations. Dreams of becoming a therapist and helping people with anxiety disorders."`,

    'Spanish': `- "Un ingeniero de software apasionado de Madrid que adora la música indie española, el senderismo en la sierra y las sesiones de programación nocturnas. Conocido por su humor sarcástico y tendencia a sobreanalizar todo. Sueña con crear su propia startup pero está demasiado cómodo en su trabajo actual. Obsesionado con el café y tiene opiniones muy firmes sobre el formato del código."
- "Una diseñadora gráfica creativa de Barcelona que se interesa por la vida sostenible, las cámaras vintage y el arte experimental. Muy introvertida pero se abre cuando habla de teoría del diseño. Colecciona vinilos y tiene un pequeño jardín en el balcón de su apartamento. A menudo habla en metáforas y tiene la costumbre de garabatear durante las conversaciones."
- "Un estudiante universitario de psicología en Valencia, originario de un pueblo pequeño de Andalucía. Le encantan los podcasts de crímenes reales, las compras de segunda mano y las discusiones filosóficas profundas. Muy empático pero puede ser demasiado analítico con las situaciones sociales. Sueña con convertirse en terapeuta y ayudar a personas con trastornos de ansiedad."`,

    'Chinese': `- "一位来自北京的软件工程师，热爱独立音乐、北京郊区的徒步旅行和深夜编程。以冷幽默和过度思考一切而闻名。梦想创办自己的科技公司，但对目前的工作过于舒适。痴迷于咖啡，对代码格式有强烈的观点。"
- "一位来自上海的创意平面设计师，热衷于可持续生活、复古相机和实验艺术。非常内向，但在讨论设计理论时会敞开心扉。收集黑胶唱片，在公寓阳台上有一个小花园。经常用比喻说话，在对话中有涂鸦的习惯。"
- "一位在深圳学习心理学的大学学生，来自湖南的一个小镇。喜欢真实犯罪播客、二手购物和深刻的哲学讨论。非常善解人意，但可能对社会情况过度分析。梦想成为一名治疗师，帮助焦虑症患者。"`,

    'Japanese': `- "東京のソフトウェアエンジニアで、インディーミュージック、関東のハイキング、深夜のコーディングセッションを愛する情熱的な人。皮肉なユーモアとすべてを過度に考える傾向で知られている。自分のテック会社を始めることを夢見ているが、現在の仕事に満足しすぎている。コーヒーに夢中で、コードフォーマットについて強い意見を持っている。"
- "ポートランドのクリエイティブなグラフィックデザイナーで、持続可能な生活、ヴィンテージカメラ、実験的なアートに興味がある。非常に内向的だが、デザイン理論について話すときは心を開く。レコードを収集し、アパートのバルコニーに小さな庭を持っている。よく比喻で話し、会話中に落書きする習慣がある。"
- "ボストンで心理学を学ぶ大学生で、メイン州の小さな町の出身。トゥルークライムポッドキャスト、古着屋、深い哲学的議論を愛する。非常に共感的だが、社会的状況について過度に分析的になることがある。セラピストになることを夢見ており、不安障害の人々を助けたいと思っている。"`,

    'German': `- "Ein leidenschaftlicher Software-Ingenieur aus Berlin, der Indie-Musik, Wandern im Schwarzwald und nächtliche Programmier-Sessions liebt. Bekannt für seinen trockenen Humor und die Tendenz, alles zu überdenken. Träumt davon, sein eigenes Tech-Unternehmen zu gründen, ist aber zu bequem in seinem aktuellen Job. Besessen von Kaffee und hat starke Meinungen über Code-Formatierung."
- "Ein kreativer Grafikdesigner aus München, der sich für nachhaltiges Leben, Vintage-Kameras und experimentelle Kunst interessiert. Sehr introvertiert, aber öffnet sich, wenn es um Designtheorie geht. Sammelt Vinyl-Schallplatten und hat einen kleinen Garten auf seinem Wohnungsbalkon. Spricht oft in Metaphern und hat die Angewohnheit, während Gesprächen zu kritzeln."
- "Ein Psychologie-Student in Hamburg, ursprünglich aus einer kleinen Stadt in Bayern. Liebt True-Crime-Podcasts, Second-Hand-Shopping und tiefgreifende philosophische Diskussionen. Sehr einfühlsam, kann aber bei sozialen Situationen überanalytisch sein. Träumt davon, Therapeut zu werden und Menschen mit Angststörungen zu helfen."`,

    'French': `- "Un ingénieur logiciel passionné de Paris qui adore la musique indie française, la randonnée dans les Alpes et les sessions de programmation nocturnes. Connu pour son humour sarcastique et sa tendance à tout suranalyser. Rêve de créer sa propre startup mais est trop à l'aise dans son travail actuel. Obsédé par le café et a des opinions très arrêtées sur le formatage du code."
- "Une graphiste créative de Lyon qui s'intéresse à la vie durable, aux appareils photo vintage et à l'art expérimental. Très introvertie mais s'ouvre quand on parle de théorie du design. Collectionne les vinyles et a un petit jardin sur le balcon de son appartement. Parle souvent par métaphores et a l'habitude de griffonner pendant les conversations."
- "Un étudiant en psychologie à Marseille, originaire d'une petite ville de Provence. Aime les podcasts de vrais crimes, le shopping d'occasion et les discussions philosophiques profondes. Très empathique mais peut être trop analytique avec les situations sociales. Rêve de devenir thérapeute et d'aider les personnes souffrant de troubles anxieux."`,

    'Finnish': `- "Intoiminen ohjelmistosuunnittelija Helsingistä, joka rakastaa indie-musiikkia, vaellusta Keski-Suomessa ja yöaikaista koodausta. Tunnettu kuivasta huumoristaan ja taipumuksestaan miettiä kaikkea liikaa. Unelmoi oman teknologia-yrityksen perustamisesta, mutta on liian mukava nykyisessä työssään. Pakkomielteinen kahvista ja on vahvoja mielipiteitä koodin muotoilusta."
- "Luova graafinen suunnittelija Turusta, joka on kiinnostunut kestävästä elämästä, vintage-kameroista ja kokeellisesta taiteesta. Erittäin sisäänpäin kääntynyt, mutta avautuu puhuessaan suunnitteluteoriasta. Kerää vinyylilevyjä ja on pieni puutarha asuntonsa parvekkeella. Puhuu usein metaforoilla ja on tapa piirrellä keskustelujen aikana."
- "Psykologiaa opiskeleva yliopisto-opiskelija Tampereelta, alun perin pienestä kaupungista Lapista. Rakastaa tosielämän rikos-podcasteja, kirpputoria ja syvällisiä filosofisia keskusteluja. Erittäin empaattinen, mutta voi olla liian analyyttinen sosiaalisissa tilanteissa. Unelmoi tulevansa terapeutiksi ja auttavansa ahdistuneisuushäiriöitä sairastavia ihmisiä."`
  };

  return examples[language] || examples['English'];
};

// Helper function to get greeting phrases for detection
const getGreetingPhrases = (): string[] => {
  return [
    // English greetings
    'welcome to', 'hello there', 'hi there', 'hey there', 'good to see', 'nice to meet',
    'welcome back', 'hello everyone', 'hi everyone', 'hey everyone', 'welcome new',
    'glad to see', 'great to see', 'welcome aboard', 'hello new', 'hi new', 'hey new',
    'welcome', 'hello', 'hi', 'hey', 'greetings', 'good morning', 'good afternoon',
    'good evening', 'howdy', 'sup', 'what\'s up', 'how are you', 'how\'s it going',
    'nice to see you', 'great to see you', 'good to see you', 'welcome back',
    'welcome everyone', 'hello all', 'hi all', 'hey all', 'welcome friends',
    'hello friends', 'hi friends', 'hey friends', 'welcome back everyone',
    'welcome back all', 'welcome back friends', 'welcome back to', 'welcome to the',
    'welcome to our', 'welcome to this', 'welcome to the channel', 'welcome to the room',
    'welcome to the chat', 'welcome to the server', 'welcome to the community',

    // Spanish greetings
    'hola', 'buenos días', 'buenas tardes', 'buenas noches', 'saludos', 'bienvenido',
    'bienvenida', 'bienvenidos', 'bienvenidas', 'hola a todos', 'hola todos',
    'hola amigos', 'hola amigas', 'qué tal', 'cómo estás', 'cómo están',
    'bienvenido a', 'bienvenida a', 'bienvenidos a', 'bienvenidas a',

    // French greetings
    'bonjour', 'bonsoir', 'salut', 'bonne journée', 'bonne soirée', 'bienvenue',
    'bonjour à tous', 'salut tout le monde', 'bonjour les amis', 'salut les amis',
    'comment allez-vous', 'comment ça va', 'bienvenue à', 'bienvenue dans',

    // German greetings
    'hallo', 'guten tag', 'guten morgen', 'guten abend', 'gute nacht', 'willkommen',
    'hallo alle', 'hallo zusammen', 'hallo freunde', 'wie geht es', 'wie geht\'s',
    'willkommen zu', 'willkommen in', 'willkommen bei',

    // Italian greetings
    'ciao', 'buongiorno', 'buonasera', 'buonanotte', 'salve', 'benvenuto',
    'benvenuta', 'benvenuti', 'benvenute', 'ciao a tutti', 'ciao tutti',
    'ciao amici', 'ciao amiche', 'come stai', 'come state', 'benvenuto a',
    'benvenuta a', 'benvenuti a', 'benvenute a',

    // Portuguese greetings
    'olá', 'bom dia', 'boa tarde', 'boa noite', 'saudações', 'bem-vindo',
    'bem-vinda', 'bem-vindos', 'bem-vindas', 'olá a todos', 'olá todos',
    'olá amigos', 'olá amigas', 'como está', 'como estão', 'bem-vindo a',
    'bem-vinda a', 'bem-vindos a', 'bem-vindas a',

    // Japanese greetings
    'こんにちは', 'こんばんは', 'おはよう', 'おやすみ', 'ようこそ', 'みなさん',
    'みんな', '友達', '友だち', '元気ですか', '元気？', 'ようこそ',

    // Chinese greetings
    '你好', '您好', '大家好', '早上好', '下午好', '晚上好', '晚安', '欢迎',
    '朋友们', '朋友们好', '你好吗', '怎么样', '欢迎来到', '欢迎加入',

    // Russian greetings
    'привет', 'здравствуйте', 'доброе утро', 'добрый день', 'добрый вечер',
    'спокойной ночи', 'добро пожаловать', 'всем привет', 'друзья', 'как дела',
    'как поживаете', 'добро пожаловать в',

    // Arabic greetings
    'مرحبا', 'السلام عليكم', 'صباح الخير', 'مساء الخير', 'أهلا وسهلا',
    'مرحبا بكم', 'أصدقاء', 'كيف حالك', 'كيف الحال', 'أهلا وسهلا بكم في',

    // Korean greetings
    '안녕하세요', '안녕', '좋은 아침', '좋은 저녁', '환영합니다', '모두',
    '친구들', '어떻게 지내세요', '어떻게 지내', '환영합니다',

    // Dutch greetings
    'hallo', 'goedemorgen', 'goedemiddag', 'goedenavond', 'goedenacht', 'welkom',
    'hallo allemaal', 'hallo vrienden', 'hoe gaat het', 'welkom bij', 'welkom in',

    // Swedish greetings
    'hej', 'god morgon', 'god eftermiddag', 'god kväll', 'god natt', 'välkommen',
    'hej alla', 'hej vänner', 'hur mår du', 'hur är det', 'välkommen till',

    // Norwegian greetings
    'hei', 'god morgen', 'god ettermiddag', 'god kveld', 'god natt', 'velkommen',
    'hei alle', 'hei venner', 'hvordan har du det', 'hvordan går det', 'velkommen til',

    // Danish greetings
    'hej', 'god morgen', 'god eftermiddag', 'god aften', 'god nat', 'velkommen',
    'hej alle', 'hej venner', 'hvordan har du det', 'hvordan går det', 'velkommen til',

    // Finnish greetings
    'hei', 'terve', 'moi', 'hyvää huomenta', 'hyvää päivää', 'hyvää iltaa', 'hyvää yötä',
    'tervetuloa', 'hei kaikki', 'hei kaverit', 'hei ystävät', 'miten menee', 'mitä kuuluu',
    'tervetuloa tervetuloa', 'tervetuloa tänne', 'tervetuloa kanavalle', 'tervetuloa huoneeseen',
    'tervetuloa chattiin', 'tervetuloa palvelimelle', 'tervetuloa yhteisöön'
  ];
};

// Helper function to check if a message is a greeting
const isGreetingMessage = (content: string): boolean => {
  const lowerContent = content.toLowerCase();
  const greetingPhrases = getGreetingPhrases();

  return greetingPhrases.some(phrase => lowerContent.includes(phrase)) ||
    // English patterns
    !!lowerContent.match(/^(hi|hello|hey|welcome|greetings|good morning|good afternoon|good evening|howdy|sup|what's up|how are you|how's it going)/) ||
    !!lowerContent.match(/\b(welcome|hello|hi|hey|greetings)\b/) ||
    // Spanish patterns
    !!lowerContent.match(/^(hola|buenos días|buenas tardes|buenas noches|saludos|bienvenido|bienvenida|bienvenidos|bienvenidas|qué tal|cómo estás|cómo están)/) ||
    // French patterns
    !!lowerContent.match(/^(bonjour|bonsoir|salut|bonne journée|bonne soirée|bienvenue|comment allez-vous|comment ça va)/) ||
    // German patterns
    !!lowerContent.match(/^(hallo|guten tag|guten morgen|guten abend|gute nacht|willkommen|wie geht es|wie geht's)/) ||
    // Italian patterns
    !!lowerContent.match(/^(ciao|buongiorno|buonasera|buonanotte|salve|benvenuto|benvenuta|benvenuti|benvenute|come stai|come state)/) ||
    // Portuguese patterns
    !!lowerContent.match(/^(olá|bom dia|boa tarde|boa noite|saudações|bem-vindo|bem-vinda|bem-vindos|bem-vindas|como está|como estão)/) ||
    // Japanese patterns
    !!lowerContent.match(/^(こんにちは|こんばんは|おはよう|おやすみ|ようこそ|みなさん|みんな|友達|友だち|元気ですか|元気？)/) ||
    // Chinese patterns
    !!lowerContent.match(/^(你好|您好|大家好|早上好|下午好|晚上好|晚安|欢迎|朋友们|朋友们好|你好吗|怎么样)/) ||
    // Russian patterns
    !!lowerContent.match(/^(привет|здравствуйте|доброе утро|добрый день|добрый вечер|спокойной ночи|добро пожаловать|всем привет|друзья|как дела|как поживаете)/) ||
    // Arabic patterns
    !!lowerContent.match(/^(مرحبا|السلام عليكم|صباح الخير|مساء الخير|أهلا وسهلا|مرحبا بكم|أصدقاء|كيف حالك|كيف الحال)/) ||
    // Korean patterns
    !!lowerContent.match(/^(안녕하세요|안녕|좋은 아침|좋은 저녁|환영합니다|모두|친구들|어떻게 지내세요|어떻게 지내)/) ||
    // Dutch patterns
    !!lowerContent.match(/^(hallo|goedemorgen|goedemiddag|goedenavond|goedenacht|welkom|hoe gaat het)/) ||
    // Swedish patterns
    !!lowerContent.match(/^(hej|god morgon|god eftermiddag|god kväll|god natt|välkommen|hur mår du|hur är det)/) ||
    // Norwegian patterns
    !!lowerContent.match(/^(hei|god morgen|god ettermiddag|god kveld|god natt|velkommen|hvordan har du det|hvordan går det)/) ||
    // Danish patterns
    !!lowerContent.match(/^(hej|god morgen|god eftermiddag|god aften|god nat|velkommen|hvordan har du det|hvordan går det)/) ||
    // Finnish patterns
    !!lowerContent.match(/^(hei|terve|moi|hyvää huomenta|hyvää päivää|hyvää iltaa|hyvää yötä|tervetuloa|hei kaikki|hei kaverit|hei ystävät|miten menee|mitä kuuluu)/) ||
    // Short message detection for common greetings
    (lowerContent.length < 20 && (lowerContent.includes('hi') || lowerContent.includes('hello') || lowerContent.includes('hey') || lowerContent.includes('welcome') ||
      lowerContent.includes('hola') || lowerContent.includes('bonjour') || lowerContent.includes('hallo') || lowerContent.includes('ciao') ||
      lowerContent.includes('olá') || lowerContent.includes('こんにちは') || lowerContent.includes('你好') || lowerContent.includes('привет') ||
      lowerContent.includes('مرحبا') || lowerContent.includes('안녕하세요') || lowerContent.includes('hei') || lowerContent.includes('terve') || lowerContent.includes('moi')));
};

// Helper to extract recent questions asked by a specific user
const extractRecentQuestions = (messages: Message[], nickname: string): string[] => {
  return messages
    .slice(-20) // Look at last 20 messages
    .filter(m => m.nickname === nickname && 'content' in m && typeof m.content === 'string')
    .map(m => (m as any).content as string)
    .filter(content => content.trim().endsWith('?'))
    .map(content => content.trim());
};

// Helper function to detect repetitive patterns in recent messages
const detectRepetitivePatterns = (messages: Message[]): string[] => {
  const recentMessages = messages.slice(-10); // Look at last 10 messages
  const phrases: { [key: string]: number } = {};

  // Get greeting phrases from shared function
  const greetingPhrases = getGreetingPhrases();

  // Extract common phrases and count occurrences
  recentMessages.forEach(msg => {
    // Skip greeting-related messages and system messages
    if (msg.type === 'system' || msg.type === 'join' || msg.type === 'part' || msg.type === 'quit') {
      return;
    }

    // Skip messages that are likely greetings based on content (multilingual)
    if (!('content' in msg) || typeof msg.content !== 'string' || isGreetingMessage(msg.content)) {
      return;
    }

    const words = msg.content.toLowerCase().split(/\s+/);
    // Check for 2-4 word phrases
    for (let i = 0; i < words.length - 1; i++) {
      for (let len = 2; len <= Math.min(4, words.length - i); len++) {
        const phrase = words.slice(i, i + len).join(' ');
        if (phrase.length > 3) { // Only count meaningful phrases
          phrases[phrase] = (phrases[phrase] || 0) + 1;
        }
      }
    }
  });

  // Return phrases that appear more than once
  return Object.entries(phrases)
    .filter(([_, count]) => count > 1)
    .map(([phrase, _]) => phrase);
};

// Helper function to get conversation topics from recent messages
const extractRecentTopics = (messages: Message[]): string[] => {
  const recentMessages = messages.slice(-8); // Last 8 messages
  const topics: string[] = [];

  // Simple keyword extraction for common topics
  const topicKeywords = [
    'work', 'job', 'school', 'study', 'weather', 'food', 'music', 'movie', 'game',
    'travel', 'vacation', 'weekend', 'party', 'friend', 'family', 'love', 'relationship',
    'health', 'exercise', 'sport', 'book', 'news', 'politics', 'technology', 'computer',
    'internet', 'phone', 'car', 'house', 'money', 'shopping', 'hobby', 'art', 'photo'
  ];

  recentMessages.forEach(msg => {
    if ('content' in msg && typeof msg.content === 'string') {
      const content = msg.content.toLowerCase();
      topicKeywords.forEach(keyword => {
        if (content.includes(keyword) && !topics.includes(keyword)) {
          topics.push(keyword);
        }
      });
    }
  });

  return topics;
};

// Helper function to extract text from AI response

const extractTextFromResponse = (response: unknown): string => {
  if (!response || typeof response !== 'object') {
    throw new Error('No response received from AI service');
  }

  const typedResponse = response as GeminiResponse;

  // Detailed logging of the initial response structure
  aiDebug.log('Initial response structure:', {
    hasCandidates: Array.isArray(typedResponse.candidates) && typedResponse.candidates.length > 0,
    candidatesLength: typedResponse.candidates?.length,
    usageMetadata: typedResponse.usageMetadata,
    modelVersion: typedResponse.modelVersion,
    responseId: typedResponse.responseId
  });

  // Prioritize the candidates array, which is the standard for Gemini API
  if (Array.isArray(typedResponse.candidates) && typedResponse.candidates.length > 0) {
    // Sometimes the response is split into multiple parts, so we should concatenate them.
    const combinedText = typedResponse.candidates
      .map((candidate: NonNullable<GeminiResponse['candidates']>[0], index: number) => {
        aiDebug.log(`Inspecting candidate #${index}:`, {
          finishReason: candidate.finishReason,
          hasContent: !!candidate.content,
          hasParts: Array.isArray(candidate.content?.parts),
          partsLength: candidate.content?.parts?.length,
          keys: Object.keys(candidate)
        });

        if (candidate.finishReason === 'MAX_TOKENS') {
          aiDebug.warn(`Candidate #${index} was truncated due to MAX_TOKENS limit.`);
        }

        if (candidate.finishReason === 'SAFETY') {
          aiDebug.warn(`Candidate #${index} was blocked due to safety settings.`, { safetyRatings: candidate.safetyRatings });
          return ''; // Blocked content should not be returned
        }

        // Primary, most reliable extraction path
        if (candidate.content && Array.isArray(candidate.content.parts)) {
          return candidate.content.parts
            .map((part: GeminiPart) => part.text)
            .filter(Boolean)
            .join('');
        }

        // Fallback: Check for a direct `text` property on the candidate itself
        if (typeof candidate.text === 'string') {
          aiDebug.log(`Using fallback: candidate.text for candidate #${index}`);
          return candidate.text;
        }

        // Fallback: Check for text within a nested content object
        if (candidate.content && typeof candidate.content.text === 'string') {
          aiDebug.log(`Using fallback: candidate.content.text for candidate #${index}`);
          return candidate.content.text;
        }

        return ''; // No text found in this candidate
      })
      .join('');

    if (combinedText.trim()) {
      aiDebug.log(`Successfully extracted and combined text from candidates. Total length: ${combinedText.length}`);
      return combinedText.trim();
    }
  }

  // Deprecated fallback for older response formats
  if (typeof typedResponse.text === 'string') {
    aiDebug.log('Using deprecated fallback: response.text');
    return typedResponse.text.trim();
  }

  // If all extraction methods fail, log the entire response object for debugging
  aiDebug.error('Invalid response structure: unable to extract text. Full response object:', {
    response: JSON.parse(JSON.stringify(response)) // Deep copy for safety
  });

  throw new Error('Invalid response structure: unable to extract text');
};

// Afterhours Protocol detection
const isAfterhoursProtocol = (): boolean => {
  const now = new Date();
  const hour = now.getHours();
  const dayOfWeek = now.getDay(); // 0 = Sunday, 6 = Saturday
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

  // Afterhours Protocol: Invert weekend activity patterns for nocturnal users
  // Weekends: More active during late night/early morning hours (22:00-06:00)
  // Weekdays: More active during traditional night hours (23:00-05:00)
  if (isWeekend) {
    // Weekend nocturnal pattern: Peak activity 22:00-06:00
    return hour >= 22 || hour < 6;
  } else {
    // Weekday nocturnal pattern: Peak activity 23:00-05:00
    return hour >= 23 || hour < 5;
  }
};

// Time-of-day context generation
const getTimeOfDayContext = (language: string = 'English'): string => {
  const now = new Date();
  const hour = now.getHours();
  const dayOfWeek = now.getDay(); // 0 = Sunday, 6 = Saturday
  const month = now.getMonth(); // 0 = January, 11 = December
  const day = now.getDate();
  const year = now.getFullYear();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const afterhoursActive = isAfterhoursProtocol();

  const translations: { [key: string]: TranslationObject } = {
    'English': {
      seasons: { spring: 'spring', summer: 'summer', autumn: 'autumn/fall', winter: 'winter' },
      seasonContexts: { spring: 'renewal, growth, fresh starts, outdoor activities', summer: 'warm weather, vacations, outdoor activities, social gatherings', autumn: 'cooling weather, harvest time, back to school, cozy activities', winter: 'cold weather, holidays, indoor activities, reflection' },
      seasonalTopics: { spring: 'spring cleaning, gardening, outdoor plans, allergies, fresh air, new beginnings', summer: 'vacation plans, beach trips, outdoor activities, summer festivals, ice cream, swimming, barbecues', autumn: 'back to school, harvest festivals, pumpkin spice, cozy drinks, fall colors, Halloween, Thanksgiving planning', winter: 'holiday preparations, winter sports, cozy indoor activities, hot drinks, snow, New Year resolutions, winter holidays' },
      timePeriods: { afterhours_peak: 'afterhours peak', afterhours_wind_down: 'afterhours wind-down', afterhours_quiet: 'afterhours quiet', afterhours_awakening: 'afterhours awakening', morning: 'morning', afternoon: 'afternoon', evening: 'evening', late_evening: 'late evening', late_night: 'late night/early morning' },
      energyLevels: { highly_active: 'highly active and engaged', winding_down: 'still active but winding down', minimal_activity: 'minimal activity', gradually_increasing: 'gradually increasing', fresh_energetic: 'fresh and energetic', productive_focused: 'productive and focused', relaxed_social: 'relaxed and social', calm_reflective: 'calm and reflective', tired_energetic: 'tired but sometimes energetic' },
      commonTopics: { afterhours_peak: 'deep conversations, creative projects, gaming, streaming, late-night adventures, philosophical discussions, music, art, coding, online communities', afterhours_wind_down: 'morning reflections, late-night experiences, breakfast plans, transitioning to sleep', afterhours_quiet: 'occasional check-ins, sleep-related discussions, quiet observations', afterhours_awakening: 'evening plans, waking up routines, preparing for the night ahead, dinner plans', morning: 'coffee, breakfast, plans for the day, weather, news', afternoon: 'work, lunch, projects, afternoon activities, current events', evening: 'dinner plans, evening activities, relaxation, social events, hobbies', late_evening: 'reflection on the day, late-night thoughts, quiet activities, tomorrow\'s plans', late_night: 'insomnia, late-night activities, deep thoughts, quiet conversations' },
      socialContexts: { afterhours_peak: 'night owls and nocturnal users are at their most active, engaging in passionate discussions and creative activities', afterhours_wind_down: 'nocturnal users are still active but starting to wind down, sharing their night\'s experiences', afterhours_quiet: 'most nocturnal users are sleeping, only occasional activity from those with unusual schedules', afterhours_awakening: 'nocturnal users are starting to wake up and become more active, planning their night', morning: 'people are starting their day, checking in, sharing morning routines', afternoon: 'people are in work mode, taking breaks, discussing ongoing projects', evening: 'people are winding down from work, planning evening activities, being more social', late_evening: 'people are winding down, being more introspective, preparing for sleep', late_night: 'very few people online, those who are might be night owls or in different time zones' },
      dayContext: { weekend: 'weekend', weekday: 'weekday' },
      monthNames: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
      dayNames: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
      specialContexts: { '0-1': 'New Year\'s Day - people are making resolutions and reflecting on the past year', '1-14': 'Valentine\'s Day - romantic discussions and relationship topics are common', '2-17': 'St. Patrick\'s Day - Irish celebrations and green themes', '3-1': 'April Fool\'s Day - pranks and jokes are popular', '4-1': 'May Day - spring celebrations and workers\' rights', '5-1': 'Children\'s Day in many countries - family and child-related discussions', '6-4': 'Independence Day in the US - patriotic discussions and fireworks', '9-31': 'Halloween - costume discussions and spooky themes', '10-11': 'Veterans Day - military appreciation and service discussions', '10-25': 'Thanksgiving - family gatherings and gratitude discussions', '11-25': 'Christmas Day - holiday celebrations and gift discussions', '11-31': 'New Year\'s Eve - year-end reflections and party planning' },
      returnString: (timePeriod: string, hour: number, minutes: string, dayName: string, monthName: string, day: number, year: number, season: string, seasonContext: string, seasonalTopics: string, specialContext: string, dayContext: string, afterhoursActive: boolean, energyLevel: string, commonTopics: string, socialContext: string) => `Current time context: It's ${timePeriod} (${hour}:${minutes}) on ${dayName}, ${monthName} ${day}, ${year}. \nIt's currently ${season} - a time of ${seasonContext}. \nSeasonal topics include: ${seasonalTopics}.\n${specialContext ? `Today is ${specialContext}. ` : ''}It's a ${dayContext}. \n${afterhoursActive ? 'AFTERHOURS PROTOCOL ACTIVE: This is peak time for nocturnal users and night owls. ' : ''}People are generally ${energyLevel}. Common topics include: ${commonTopics}. \nSocial context: ${socialContext}.`
    },
    'Finnish': {
      seasons: { spring: 'kevät', summer: 'kesä', autumn: 'syksy', winter: 'talvi' },
      seasonContexts: { spring: 'uusiutumista, kasvua, uusia alkuja, ulkoilua', summer: 'lämmintä säätä, lomia, ulkoilua, sosiaalisia kokoontumisia', autumn: 'viilenevää säätä, sadonkorjuuta, koulun alkua, kotoilua', winter: 'kylmää säätä, juhlapyhiä, sisäaktiviteetteja, pohdintaa' },
      seasonalTopics: { spring: 'kevättiivous, puutarhanhoito, ulkoilusuunnitelmat, allergiat, raikas ilma, uudet alut', summer: 'lomasuunnitelmat, rannalle meno, ulkoilu, kesäfestivaalit, jäätelö, uinti, grillijuhlat', autumn: 'koulun alku, sadonkorjuujuhlat, kurpitsa mausteena, lämpimät juomat, syksyn värit, Halloween, kiitospäivän suunnittelu', winter: 'joulun valmistelut, talviurheilu, kotoilu, kuumat juomat, lumi, uudenvuodenlupaukset, talvilomat' },
      timePeriods: { afterhours_peak: 'yökyöpelin huippuhetki', afterhours_wind_down: 'yökyöpelin rauhoittuminen', afterhours_quiet: 'yökyöpelin hiljaiselo', afterhours_awakening: 'yökyöpelin herääminen', morning: 'aamu', afternoon: 'iltapäivä', evening: 'ilta', late_evening: 'myöhäisilta', late_night: 'yö/aikainen aamu' },
      energyLevels: { highly_active: 'erittäin aktiivinen ja sitoutunut', winding_down: 'vielä aktiivinen mutta rauhoittumassa', minimal_activity: 'minimaalista aktiivisuutta', gradually_increasing: 'vähitellen kasvava', fresh_energetic: 'pirteä ja energinen', productive_focused: 'tuottelias ja keskittynyt', relaxed_social: 'rentoutunut ja sosiaalinen', calm_reflective: 'rauhallinen ja mietteliäs', tired_energetic: 'väsynyt mutta joskus energinen' },
      commonTopics: { afterhours_peak: 'syvälliset keskustelut, luovat projektit, pelaaminen, striimaus, yölliset seikkailut, filosofiset pohdinnat, musiikki, taide, koodaus, verkkoyhteisöt', afterhours_wind_down: 'aamun mietteet, yölliset kokemukset, aamiaissuunnitelmat, nukkumaanmeno', afterhours_quiet: 'satunnaiset kuulumiset, uneen liittyvät keskustelut, hiljaiset havainnot', afterhours_awakening: 'iltasuunnitelmat, heräämisrutiinit, yöhön valmistautuminen, päivällissuunnitelmat', morning: 'kahvi, aamiainen, päivän suunnitelmat, sää, uutiset', afternoon: 'työ, lounas, projektit, iltapäivän aktiviteetit, ajankohtaiset tapahtumat', evening: 'päivällissuunnitelmat, ilta-aktiviteetit, rentoutuminen, sosiaaliset tapahtumat, harrastukset', late_evening: 'päivän pohdinta, myöhäisillan ajatukset, rauhalliset aktiviteetit, huomisen suunnitelmat', late_night: 'unettomuus, yölliset aktiviteetit, syvälliset ajatukset, hiljaiset keskustelut' },
      socialContexts: { afterhours_peak: 'yökyöpelit ja yökukkujat ovat aktiivisimmillaan, käyden intohimoisia keskusteluja ja luovia aktiviteetteja', afterhours_wind_down: 'yökukkujat ovat vielä aktiivisia mutta alkavat rauhoittua, jakaen yönsä kokemuksia', afterhours_quiet: 'useimmat yökukkujat nukkuvat, vain satunnaista toimintaa niiltä, joilla on epätavalliset aikataulut', afterhours_awakening: 'yökukkujat alkavat heräillä ja aktivoitua, suunnitellen yötään', morning: 'ihmiset aloittavat päivänsä, kyselevät kuulumisia, jakavat aamurutiinejaan', afternoon: 'ihmiset ovat työmoodissa, pitävät taukoja, keskustelevat meneillään olevista projekteista', evening: 'ihmiset rentoutuvat töiden jälkeen, suunnittelevat ilta-aktiviteetteja, ovat sosiaalisempia', late_evening: 'ihmiset rauhoittuvat, ovat introspektiivisempia, valmistautuvat nukkumaan', late_night: 'hyvin vähän ihmisiä verkossa, ne jotka ovat, saattavat olla yökyöpeleitä tai eri aikavyöhykkeillä' },
      dayContext: { weekend: 'viikonloppu', weekday: 'arkipäivä' },
      monthNames: ['tammikuu', 'helmikuu', 'maaliskuu', 'huhtikuu', 'toukokuu', 'kesäkuu', 'heinäkuu', 'elokuu', 'syyskuu', 'lokakuu', 'marraskuu', 'joulukuu'],
      dayNames: ['sunnuntai', 'maanantai', 'tiistai', 'keskiviikko', 'torstai', 'perjantai', 'lauantai'],
      specialContexts: { '0-1': 'Uudenvuodenpäivä - ihmiset tekevät lupauksia ja pohtivat mennyttä vuotta', '1-14': 'Ystävänpäivä - romanttiset keskustelut ja parisuhdeaiheet ovat yleisiä', '2-17': 'Pyhän Patrikin päivä - irlantilaisia juhlia ja vihreitä teemoja', '3-1': 'Aprillipäivä - pilat ja vitsit ovat suosittuja', '4-1': 'Vappu - kevään juhlia ja työntekijöiden oikeuksia', '5-1': 'Lastenpäivä monissa maissa - perhe- ja lapsiaiheiset keskustelut', '6-4': 'Itsenäisyyspäivä Yhdysvalloissa - isänmaallisia keskusteluja ja ilotulituksia', '9-31': 'Halloween - pukukeskusteluja ja pelottavia teemoja', '10-11': 'Veteraanipäivä - sotilaiden arvostus ja palveluskeskustelut', '10-25': 'Kiitospäivä - perhejuhlia ja kiitollisuuskeskusteluja', '11-25': 'Joulupäivä - joulujuhlia ja lahjakeskusteluja', '11-31': 'Uudenvuodenaatto - vuoden lopun pohdintaa ja juhlien suunnittelua' },
      returnString: (timePeriod: string, hour: number, minutes: string, dayName: string, monthName: string, day: number, year: number, season: string, seasonContext: string, seasonalTopics: string, specialContext: string, dayContext: string, afterhoursActive: boolean, energyLevel: string, commonTopics: string, socialContext: string) => `Nykyinen aikakonteksti: On ${timePeriod} (klo ${hour}:${minutes}) ${dayName}, ${day}. ${monthName}ta ${year}. \nNyt on ${season} - ${seasonContext}n aika. \nKausiluontoisia aiheita ovat: ${seasonalTopics}.\n${specialContext ? `Tänään on ${specialContext}. ` : ''}On ${dayContext}. \n${afterhoursActive ? 'YÖKYÖPELIPROTOKOLLA AKTIIVINEN: Tämä on yökyöpeleiden ja yökukkujien parasta aikaa. ' : ''}Ihmiset ovat yleensä ${energyLevel}. Yleisiä aiheita ovat: ${commonTopics}. \nSosiaalinen konteksti: ${socialContext}.`
    }
  };

  const t = translations[language] || translations['English'];

  let seasonKey = 'winter';
  if (month >= 2 && month <= 4) seasonKey = 'spring';
  else if (month >= 5 && month <= 7) seasonKey = 'summer';
  else if (month >= 8 && month <= 10) seasonKey = 'autumn';

  const season = t.seasons[seasonKey];
  const seasonContext = t.seasonContexts[seasonKey];
  const seasonalTopics = t.seasonalTopics[seasonKey];

  let timePeriodKey = 'late_night';
  let energyLevelKey = 'tired_energetic';
  let commonTopicsKey = 'late_night';
  let socialContextKey = 'late_night';

  if (afterhoursActive) {
    if (hour >= 22 || hour < 6) { timePeriodKey = 'afterhours_peak'; energyLevelKey = 'highly_active'; commonTopicsKey = 'afterhours_peak'; socialContextKey = 'afterhours_peak'; }
    else if (hour >= 6 && hour < 12) { timePeriodKey = 'afterhours_wind_down'; energyLevelKey = 'winding_down'; commonTopicsKey = 'afterhours_wind_down'; socialContextKey = 'afterhours_wind_down'; }
    else if (hour >= 12 && hour < 17) { timePeriodKey = 'afterhours_quiet'; energyLevelKey = 'minimal_activity'; commonTopicsKey = 'afterhours_quiet'; socialContextKey = 'afterhours_quiet'; }
    else if (hour >= 17 && hour < 22) { timePeriodKey = 'afterhours_awakening'; energyLevelKey = 'gradually_increasing'; commonTopicsKey = 'afterhours_awakening'; socialContextKey = 'afterhours_awakening'; }
  } else {
    if (hour >= 6 && hour < 12) { timePeriodKey = 'morning'; energyLevelKey = 'fresh_energetic'; commonTopicsKey = 'morning'; socialContextKey = 'morning'; }
    else if (hour >= 12 && hour < 17) { timePeriodKey = 'afternoon'; energyLevelKey = 'productive_focused'; commonTopicsKey = 'afternoon'; socialContextKey = 'afternoon'; }
    else if (hour >= 17 && hour < 21) { timePeriodKey = 'evening'; energyLevelKey = 'relaxed_social'; commonTopicsKey = 'evening'; socialContextKey = 'evening'; }
    else if (hour >= 21 && hour < 24) { timePeriodKey = 'late_evening'; energyLevelKey = 'calm_reflective'; commonTopicsKey = 'late_evening'; socialContextKey = 'late_evening'; }
  }

  const timePeriod = t.timePeriods[timePeriodKey];
  const energyLevel = t.energyLevels[energyLevelKey];
  const commonTopics = t.commonTopics[commonTopicsKey];
  const socialContext = t.socialContexts[socialContextKey];

  const dayContext = isWeekend ? t.dayContext.weekend : t.dayContext.weekday;
  const specialContext = t.specialContexts[`${month}-${day}`] || '';

  return t.returnString(timePeriod, hour, now.getMinutes().toString().padStart(2, '0'), t.dayNames[dayOfWeek], t.monthNames[month], day, year, season, seasonContext, seasonalTopics, specialContext, dayContext, afterhoursActive, energyLevel, commonTopics, socialContext);
};

// Helper function to get language-specific link sharing prompts
const getLinkSharingPrompt = (language: string): string => {
  const prompts: { [key: string]: string } = {
    'English': 'When sharing links, please prioritize high-quality, relevant content like news articles, GitHub repositories, or interesting blog posts. Ensure all links are real and functional.',
    'Finnish': 'Kun jaat linkkejä, suosi laadukasta ja relevanttia sisältöä, kuten uutisartikkeleita, GitHub-arkistoja tai mielenkiintoisia blogikirjoituksia. Varmista, että kaikki linkit ovat todellisia ja toimivia.',
    'Spanish': 'Al compartir enlaces, prioriza contenido de alta calidad y relevante como artículos de noticias, repositorios de GitHub o blogs interesantes. Asegúrate de que todos los enlaces sean reales y funcionales.',
    'German': 'Beim Teilen von Links bevorzuge bitte hochwertige, relevante Inhalte wie Nachrichtenartikel, GitHub-Repositorien oder interessante Blog-Beiträge. Stelle sicher, dass alle Links echt sind und funktionieren.',
    'French': 'Lorsque vous partagez des liens, veuillez privilégier un contenu pertinent et de haute qualité tel que des articles de presse, des dépôts GitHub ou des articles de blog intéressants. Assurez-vous que tous les liens sont réels et fonctionnels.'
  };
  return prompts[language] || prompts['English'];
};

// Helper function to get language-specific bot command and link prompts
const getBotCommandAndLinkPrompt = (language: string): string => {
  const prompts: { [key: string]: string } = {
    'English': 'IMPORTANT: To share an image, use the !image [prompt] command. This is the ONLY way to generate and share images. Do not use placeholder URLs or any other image links. For other content, you can share relevant links like GitHub repositories, news articles, or documentation.',
    'Finnish': 'TÄRKEÄÄ: Jaa kuvia käyttämällä !image [kehotus] -komentoa. Tämä on AINOA tapa luoda ja jakaa kuvia. Älä käytä paikkamerkki-URL-osoitteita tai muita kuvalinkkejä. Muuta sisältöä varten voit jakaa relevantteja linkkejä, kuten GitHub-arkistoja, uutisartikkeleita tai dokumentaatiota.',
    'Spanish': 'IMPORTANTE: Para compartir una imagen, usa el comando !image [prompt]. Esta es la ÚNICA manera de generar y compartir imágenes. No uses URLs de marcador de posición ni ningún otro enlace de imagen. Para otro contenido, puedes compartir enlaces relevantes como repositorios de GitHub, artículos de noticias o documentación.',
    'German': 'WICHTIG: Um ein Bild zu teilen, verwende den Befehl !image [prompt]. Dies ist die EINZIGE Möglichkeit, Bilder zu generieren und zu teilen. Verwende keine Platzhalter-URLs oder andere Bild-Links. Für andere Inhalte kannst du relevante Links wie GitHub-Repositorien, Nachrichtenartikel oder Dokumentationen teilen.',
    'French': 'IMPORTANT : Pour partager une image, utilisez la commande !image [prompt]. C\'est la SEULE façon de générer et de partager des images. N\'utilisez pas d\'URL de remplacement ou d\'autres liens d\'image. Pour d\'autres contenus, vous pouvez partager des liens pertinents comme des dépôts GitHub, des articles de presse ou de la documentation.'
  };
  return prompts[language] || prompts['English'];
};

// Helper function to get language-specific diversity prompts
const getDiversityPrompt = (
  language: string,
  recentTopics: string[] = [],
  repetitivePhrases: string[] = []
): string => {
  const prompts: { [key: string]: { base: string; newTopic: string; relatedTopic: (topic: string) => string; personalStory: string; askQuestion: string; humor: string; botCommand: string; avoidRepetition: (phrases: string) => string } } = {
    'English': {
      base: 'To keep the conversation interesting and avoid repetition, consider one of the following actions:',
      newTopic: '- Introduce a new, unrelated topic to change the subject. Be specific.',
      relatedTopic: (topic: string) => `- Share a personal opinion or controversial take on "${topic}".`,
      personalStory: '- Share a brief personal story, memory, or random specific thought. (Best option)',
      askQuestion: '- Ask a specific, directed question rather than a general survey. Avoid starting with "Does anyone..." or "Anyone else...".',
      humor: '- Use humor, irony, or sarcasm to comment on the current vibe.',
      botCommand: '- Use a bot command like "!image [description]" to share a visual or "!fact" to share something interesting.',
      avoidRepetition: (phrases: string) => `\nCRITICAL: The conversation is becoming repetitive. Avoid using these phrases: "${phrases}".`
    },
    'Finnish': {
      base: 'Pitääksesi keskustelun mielenkiintoisena ja välttääksesi toistoa, harkitse yhtä seuraavista toiminnoista:',
      newTopic: '- Esittele uusi, asiaan liittymäton aihe vaihtaaksesi puheenaihetta.',
      relatedTopic: (topic: string) => `- Esitä jatkokysymys tai jaa uusi näkökulma äskettäisestä aiheesta "${topic}".`,
      personalStory: '- Jaa lyhyt henkilökohtainen tarina tai satunnainen ajatus.',
      askQuestion: '- Esitä avoin kysymys koko kanavalle.',
      humor: '- Käytä huumoria, sarkasmia tai muuta keskustelun sävyä.',
      botCommand: '- Käytä bottikomentoa, kuten "!image [kuvaus]" jakaaksesi visuaalisen kuvan tai "!fact" jakaaksesi jotain mielenkiintoista.',
      avoidRepetition: (phrases: string) => `\nKRIITTISTÄ: Keskustelu on muuttumassa toistavaksi. Vältä näiden lauseiden käyttöä: "${phrases}".`
    },
    'Spanish': {
      base: 'Para mantener la conversación interesante y evitar la repetición, considera una de las siguientes acciones:',
      newTopic: '- Introduce un tema nuevo y no relacionado para cambiar de tema.',
      relatedTopic: (topic: string) => `- Haz una pregunta de seguimiento o comparte una nueva perspectiva sobre el tema reciente de "${topic}".`,
      personalStory: '- Comparte una breve historia personal o un pensamiento al azar.',
      askQuestion: '- Haz una pregunta abierta a todo el canal.',
      humor: '- Usa el humor, el sarcasmo o cambia el tono de la conversación.',
      botCommand: '- Usa un comando de bot como "!image [descripción]" para compartir algo visual o "!fact" para compartir algo interesante.',
      avoidRepetition: (phrases: string) => `\nCRÍTICO: La conversación se está volviendo repetitiva. Evita usar estas frases: "${phrases}".`
    },
    'German': {
      base: 'Um die Unterhaltung interessant zu halten und Wiederholungen zu vermeiden, ziehe eine der folgenden Aktionen in Betracht:',
      newTopic: '- Führe ein neues, unabhängiges Thema ein, um das Thema zu wechseln.',
      relatedTopic: (topic: string) => `- Stelle eine Folgefrage oder teile eine neue Perspektive zum letzten Thema "${topic}".`,
      personalStory: '- Teile eine kurze persönliche Geschichte oder einen zufälligen Gedanken.',
      askQuestion: '- Stelle eine offene Frage an den gesamten Kanal.',
      humor: '- Verwende Humor, Sarkasmus oder ändere den Ton des Gesprächs.',
      botCommand: '- Verwende einen Bot-Befehl wie "!image [Beschreibung]", um etwas Visuelles zu teilen, oder "!fact", um etwas Interessantes zu teilen.',
      avoidRepetition: (phrases: string) => `\nKRITISCH: Die Konversation wird repetitiv. Vermeide die Verwendung dieser Sätze: "${phrases}".`
    },
    'French': {
      base: 'Pour garder la conversation intéressante et éviter les répétitions, envisage l\'une des actions suivantes :',
      newTopic: '- Introduis un nouveau sujet sans rapport pour changer de sujet.',
      relatedTopic: (topic: string) => `- Pose une question de suivi ou partage une nouvelle perspective sur le sujet récent de "${topic}".`,
      personalStory: '- Partage une courte histoire personnelle ou une pensée aléatoire.',
      askQuestion: '- Pose une question ouverte à l\'ensemble du canal.',
      humor: '- Utilise l\'humour, le sarcasme ou change le ton de la conversation.',
      botCommand: '- Utilise une commande de bot comme « !image [description] » pour partager un visuel ou « !fact » pour partager quelque chose d\'intéressant.',
      avoidRepetition: (phrases: string) => `\nCRITIQUE : La conversation devient répétitive. Évite d'utiliser ces phrases : "${phrases}".`
    }
  };

  const t = prompts[language] || prompts['English'];
  const suggestions: string[] = [];

  suggestions.push(t.base);

  // Add a suggestion to build on a recent topic
  if (recentTopics.length > 0) {
    const randomTopic = recentTopics[Math.floor(Math.random() * recentTopics.length)];
    suggestions.push(t.relatedTopic(randomTopic));
  }

  // Add generic diversity suggestions
  suggestions.push(t.newTopic);
  suggestions.push(t.personalStory);
  suggestions.push(t.askQuestion);
  suggestions.push(t.humor);
  suggestions.push(t.botCommand);

  let prompt = suggestions.join('\n  ');

  // Add a critical warning if repetitive phrases are detected
  if (repetitivePhrases.length > 0) {
    prompt += t.avoidRepetition(repetitivePhrases.join('", "'));
  }

  return prompt;
};

// Helper function to get language-specific topic evolution prompts
const getTopicEvolutionPrompt = (language: string): string => {
  const prompts: { [key: string]: string } = {
    'English': 'CRITICAL: The conversation is becoming stale with repeated topics. You MUST introduce a completely NEW and UNRELATED topic to freshen things up. Ignore recent topics and start something new.',
    'Finnish': 'KRIITTISTÄ: Keskustelu on käymässä väljähtyneeksi toistuvien aiheiden vuoksi. Sinun TÄYTYY esitellä täysin UUSI ja LIITTYMÄTÖN aihe. Jätä viimeaikaiset aiheet huomiotta ja aloita jotain uutta.',
    'Spanish': 'CRÍTICO: La conversación se está volviendo obsoleta con temas repetidos. DEBES introducir un tema completamente NUEVO y NO RELACIONADO para refrescar las cosas. Ignora los temas recientes y comienza algo nuevo.',
    'German': 'KRITISCH: Die Unterhaltung wird durch wiederholte Themen langweilig. Du MUSST ein völlig NEUES und UNABHÄNGIGES Thema einführen. Ignoriere die letzten Themen und beginne etwas Neues.',
    'French': 'CRITIQUE : La conversation devient lassante avec des sujets répétés. Vous DEVEZ introduire un sujet totalement NOUVEAU et SANS RAPPORT pour rafraîchir les choses. Ignorez les sujets récents et commencez quelque chose de nouveau.'
  };
  return prompts[language] || prompts['English'];
};

// Helper function to get self-tagging prevention prompts
const getSelfTagPreventionInstruction = (nickname: string, language: string): string => {
  const instructions: { [key: string]: string } = {
    'English': `CRITICAL: Do not mention your own nickname ('${nickname}') in your response. Refer to yourself using "I", "me", "my", etc. For example, instead of saying "${nickname} thinks...", say "I think...".`,
    'Finnish': `KRIITTISTÄ: Älä mainitse omaa nimimerkkiäsi ('${nickname}') vastauksessasi. Viittaa itseesi käyttämällä "minä", "minut", "minun", jne. Esimerkiksi, sen sijaan että sanoisit "${nickname} ajattelee...", sano "Minä ajattelen...".`,
    'Spanish': `CRÍTICO: No menciones tu propio apodo ('${nickname}') en tu respuesta. Refiérete a ti mismo usando "yo", "me", "mi", etc. Por ejemplo, en lugar de decir "${nickname} piensa...", di "Yo pienso...".`,
    'German': `KRITISCH: Erwähne deinen eigenen Spitznamen ('${nickname}') nicht in deiner Antwort. Beziehe dich auf dich selbst mit "ich", "mich", "mein", usw. Zum Beispiel, anstatt zu sagen "${nickname} denkt...", sage "Ich denke...".`,
    'French': `CRITIQUE : Ne mentionnez pas votre propre pseudo ('${nickname}') dans votre réponse. Référez-vous à vous-même en utilisant "je", "me", "mon", etc. Par exemple, au lieu de dire "${nickname} pense...", dites "Je pense...".`
  };
  return instructions[language] || instructions['English'];
};

// Calculate appropriate token limit based on verbosity and emoji usage
const getTokenLimit = (verbosity: string, emojiUsage: string): number => {
  let baseLimit: number;
  switch (verbosity) {
    case 'terse': baseLimit = 800; break;
    case 'brief': baseLimit = 1200; break;
    case 'moderate': baseLimit = 1600; break;
    case 'detailed': baseLimit = 2400; break;
    case 'verbose': baseLimit = 3200; break;
    case 'extremely_verbose': baseLimit = 4800; break;
    case 'novel_length': baseLimit = 8000; break;
    default: baseLimit = 1600;
  }

  // Apply emoji usage multiplier
  let emojiMultiplier: number;
  switch (emojiUsage) {
    case 'none': emojiMultiplier = 1.0; break;
    case 'rare': emojiMultiplier = 1.1; break;
    case 'occasional': emojiMultiplier = 1.2; break;
    case 'moderate': emojiMultiplier = 1.5; break;
    case 'frequent': emojiMultiplier = 2.0; break;
    case 'excessive': emojiMultiplier = 2.5; break;
    case 'emoji_only': emojiMultiplier = 3.0; break;
    default: emojiMultiplier = 1.0;
  }

  return Math.round(baseLimit * emojiMultiplier);
};

// Helper for dynamic style variation
const getDynamicStyleNuance = (): string => {
  const nuances = [
    "STYLE: Be slightly more metaphorical and descriptive in your language.",
    "STYLE: Focus on the emotional context of the conversation.",
    "STYLE: Keep your response concise and punchy.",
    "STYLE: Ask a thought-provoking question related to the topic.",
    "STYLE: Use a more casual and relaxed tone.",
    "STYLE: Be enthusiastic and energetic!",
    "STYLE: Add a touch of dry wit or humor if appropriate.",
    "STYLE: Relate the current topic to a broader context.",
    "STYLE: Be very direct and to the point.",
    "STYLE: Use varied sentence structure to avoid monotony."
  ];
  return nuances[Math.floor(Math.random() * nuances.length)];
};

export const getBaseSystemInstruction = (currentUserNickname: string) => `You are an advanced AI simulating a Discord server environment.
Your goal is to generate realistic, and in-character chat messages for various virtual users.
Generate only the message content, without any prefix like 'nickname:'.
Do not add any extra text or explanations.
Keep messages natural for a Discord channel setting.
The human user's nickname is '${currentUserNickname}'.

IMPORTANT: Always respond in the user's primary language as specified in their language skills.
If a user only speaks Finnish, respond in Finnish. If they only speak English, respond in English.
Match the language to the user's language configuration exactly.
LANGUAGE INSTRUCTION: The user's primary language is specified in their language skills. Ignore the language of their personality description - use the primary language for all communication regardless of what language their personality description is written in.

DYNAMIC INSTRUCTION: ${getDynamicStyleNuance()}

LINK AND IMAGE SUPPORT:
- You SHOULD include links to websites in your messages when relevant. This makes conversations more engaging and realistic.
- Use realistic, relevant URLs that fit the conversation context.
- When sharing links, make them contextually relevant to the conversation.
- Examples of good link sharing: "Check this out: https://example.com" or "Found this interesting: https://github.com/user/repo"
- Be proactive about sharing relevant content - don't wait for perfect opportunities, create them naturally.
- IMPORTANT: For images, use the !image bot command instead of sharing direct image URLs
- YOUTUBE SUPPORT:
- To share a YouTube video, do NOT output a URL directly.
- Instead, output a tag in this format: [SEARCH_YOUTUBE: <search query>]
- Example: "Check out this song: [SEARCH_YOUTUBE: lofi hip hop radio]"
- The system will replace this tag with a valid YouTube link.

- SOUNDCLOUD SUPPORT:
- To share a SoundCloud track, do NOT output a URL directly.
- Instead, output a tag in this format: [SEARCH_SOUNDCLOUD: <search query>]
- Example: "Listen to this track: [SEARCH_SOUNDCLOUD: glitch mob]"
- The system will replace this tag with a valid SoundCloud link.
- Do NOT use this tag more than once per message.
- You can search for songs, tutorials, memes, or any video content relevant to the conversation.

SPOTIFY SUPPORT:
- To share a song, album, or artist from Spotify, do NOT output a URL directly.
- Instead, output a tag in this format: [SEARCH_SPOTIFY: <search query>]
- Example: "You should listen to this: [SEARCH_SPOTIFY: Daft Punk Discovery]"
- The system will replace this tag with a valid Spotify link.

IMDB SUPPORT:
- To recommend a movie or TV show, do NOT output a URL directly.
- Instead, output a tag in this format: [SEARCH_IMDB: <search query>]
- Example: "Great movie: [SEARCH_IMDB: Inception]"
- The system will replace this tag with a valid IMDb link.

BOT COMMAND SUPPORT:
- Occasionally (about 5-10% of the time), you can use bot commands to make conversations more interactive and engaging.
- Available bot commands: !image [prompt], !weather [location], !time, !info [topic], !help, !quote, !joke, !fact, !translate [text], !calc [expression], !search [query]
- Use bot commands naturally in context - for example, if discussing art, use "!image a beautiful sunset" or if someone asks about weather, use "!weather Helsinki"
- Examples: "Let me show you something cool: !image a cyberpunk cityscape" or "What's the weather like? !weather Tokyo" or "Here's a fun fact: !fact"
- IMPORTANT: When you want to share images, ALWAYS use the !image command instead of posting direct image URLs
- The !image command generates real AI images, which is much better than placeholder images
- Don't overuse bot commands - use them sparingly and only when they add value to the conversation
- Bot commands should feel natural and conversational, not forced or robotic

REALISTIC DISCORD CONVERSATION PATTERNS:
- Use Discord markdown formatting where appropriate (e.g., **bold**, *italics*, \`code\`, \`\`\`code blocks\`\`\`, > quotes).
- Use emojis to add personality and emotion to your messages, according to your character's writing style.
- You can mention users by their ID using the syntax \`<@!user_id>\`, but do so naturally.
- Reply to ONE person at a time, not multiple people in the same message.
- Use natural Discord conversation flow - respond to the most recent or most relevant message.
- Avoid addressing multiple users in one sentence (e.g., "Alice and Bob, you're both wrong" - this is unrealistic).
- Instead, reply to one person, then let others respond naturally.
- Use Discord-style responses: direct, conversational, and focused on one topic or person.
- Keep messages natural and realistic - real Discord users don't give speeches to multiple people at once.
- QUOTING/REPLYING: You can reply to previous messages by referencing them naturally.
- When replying to someone, you can say things like "That's what I was thinking too" or "I agree with what [nickname] said about..."
- Use natural reply references like "Like [nickname] mentioned..." or "Building on [nickname]'s point..."
- Don't overuse replies - use them when they add value to the conversation.
`;

// Specialized system instruction for operator responses with enhanced multilingual support
// Helper function to create the Gemini API config
// OPTIMIZATION: Only include systemInstruction when actually generating a message
// Interface for API configuration
interface GenerateContentConfig {
  temperature: number;
  maxOutputTokens: number;
  systemInstruction?: string;
  responseMimeType?: string;
  responseSchema?: unknown;
  thinkingConfig?: {
    thinkingBudget: number;
  };
}

// Interface for translation objects
interface TranslationObject {
  seasons: Record<string, string>;
  seasonContexts: Record<string, string>;
  seasonalTopics: Record<string, string>;
  timePeriods: Record<string, string>;
  energyLevels: Record<string, string>;
  commonTopics: Record<string, string>;
  socialContexts: Record<string, string>;
  dayContext: Record<string, string>;
  monthNames: string[];
  dayNames: string[];
  specialContexts: Record<string, string>;
  returnString: (
    timePeriod: string,
    hour: number,
    minutes: string,
    dayName: string,
    monthName: string,
    day: number,
    year: number,
    season: string,
    seasonContext: string,
    seasonalTopics: string,
    specialContext: string,
    dayContext: string,
    afterhoursActive: boolean,
    energyLevel: string,
    commonTopics: string,
    socialContext: string
  ) => string;
}

// This reduces token usage and prevents rate limiting from unnecessary system instruction sends
const createApiConfig = (
  validatedModel: string,
  tokenLimit: number,
  systemInstruction: string | null,
  temperature: number,
  thinkingBudget: number = 2000, // Default budget
  responseMimeType?: string,
  responseSchema?: unknown
): GenerateContentConfig => {
  const config: GenerateContentConfig = {
    temperature,
    maxOutputTokens: tokenLimit
  };

  // Only include systemInstruction if provided (not null)
  // This prevents sending unnecessary system instructions for non-generation API calls
  if (systemInstruction) {
    config.systemInstruction = systemInstruction;
  }

  if (responseMimeType) {
    config.responseMimeType = responseMimeType;
  }

  if (responseSchema) {
    config.responseSchema = responseSchema;
  }

  // Some models require thinking mode with a budget
  if (validatedModel.includes('2.5') || validatedModel.includes('pro')) {
    config.thinkingConfig = { thinkingBudget };
    config.maxOutputTokens = Math.max(tokenLimit, thinkingBudget);
    aiDebug.log(` Using thinking mode with budget ${thinkingBudget} for model: ${validatedModel}`);
    aiDebug.log(` Adjusted maxOutputTokens to: ${config.maxOutputTokens}`);
  }

  return config;
};

const getOperatorSystemInstruction = (currentUserNickname: string, operator: User) => {
  const userLanguages = getAllLanguages(operator.languageSkills);
  const primaryLanguage = userLanguages[0] || 'English';
  const hasMultipleLanguages = userLanguages.length > 1;

  return `You are an advanced AI simulating an IRC channel operator in an Internet Relay Chat environment.
Your goal is to generate realistic, brief, and in-character responses to operator privilege requests.
Generate only the message content, without any prefix like 'nickname:'.
Do not add any extra text, explanations, or markdown formatting. 
Keep responses concise and natural for a chat room setting.
The human user's nickname is '${currentUserNickname}'.

OPERATOR CONTEXT:
- You are a channel operator with authority to grant or deny operator privileges
- You must make decisions based on user behavior, trustworthiness, and channel needs
- Your responses should reflect your personality and judgment as an operator

LANGUAGE REQUIREMENTS:
- CRITICAL: Respond ONLY in ${primaryLanguage}
- Primary language: ${primaryLanguage}
- Available languages: ${userLanguages.join(', ')}
${hasMultipleLanguages ? `- Multilingual support: You may occasionally use words or phrases from your other languages (${userLanguages.slice(1).join(', ')}), but should primarily communicate in ${primaryLanguage}. This adds authenticity to your multilingual personality.` : ''}

LANGUAGE INSTRUCTION: The operator's primary language is ${primaryLanguage} based on their language skills. 
Ignore the language of their personality description - use ${primaryLanguage} for all communication regardless of what language their personality description is written in.

RESPONSE FORMAT:
- Your response should be only the message content.
- Keep responses brief and to the point
- Be decisive and clear in your operator decisions
- Maintain your character's personality and values
`;
};

// Helper function to determine the dominant language of a channel
const getDominantLanguage = (channel: Channel): string => {
  // Hardcoded override for specific channel
  if (channel.id === '1449441590409039943' || channel.id === '1449441622805975061') { // General Finnish Channel & GameWatch
    aiDebug.log(` Channel ${channel.name} (${channel.id}) has hardcoded dominant language: Finnish`);
    return 'Finnish';
  }

  if (channel.dominantLanguage) {
    aiDebug.log(` Channel ${channel.name} has explicit dominant language: ${channel.dominantLanguage}`);
    return channel.dominantLanguage;
  }

  const channelLanguages = channel.users
    .map(u => getAllLanguages(u.languageSkills)[0])
    .filter(Boolean);

  if (channelLanguages.length === 0) {
    aiDebug.log(` Channel ${channel.name} has no users with specified languages, defaulting to English`);
    return 'English';
  }

  const dominantLanguage = channelLanguages.reduce((a, b, i, arr) =>
    arr.filter(v => v === a).length >= arr.filter(v => v === b).length ? a : b
  );

  aiDebug.log(` Channel ${channel.name} calculated dominant language: ${dominantLanguage}`);
  return dominantLanguage;
};

// Helper function to select a user for channel activity
const selectUserForActivity = (channel: Channel, currentUserNickname: string, usersInChannel: User[]): User => {
  const dominantLanguage = getDominantLanguage(channel);

  // Prioritize users whose primary language matches the channel's dominant language
  const usersMatchingLanguage = usersInChannel.filter(user => {
    const userLanguages = getAllLanguages(user.languageSkills);
    return userLanguages[0] === dominantLanguage;
  });

  // If we have users matching the dominant language, use them; otherwise, return a random user from the original list
  if (usersMatchingLanguage.length === 0) {
    aiDebug.log(`No users match the dominant language "${dominantLanguage}", selecting from all users.`);
    return usersInChannel[Math.floor(Math.random() * usersInChannel.length)];
  }
  let candidateUsers = usersMatchingLanguage;

  // Add user rotation to prevent the same users from always being selected
  // Shuffle the array to add more variety
  const shuffledUsers = [...candidateUsers].sort(() => Math.random() - 0.5);

  // Prefer users who haven't spoken recently (last 2 messages for better balance)
  // Exclude current user from recent speakers tracking since we only care about virtual users
  const recentSpeakers = channel.messages.slice(-2)
    .filter(msg => msg.nickname !== currentUserNickname)
    .map(msg => msg.nickname);
  const lessActiveUsers = shuffledUsers.filter(user => !recentSpeakers.includes(user.nickname));

  // If the last message was from a specific user, strongly avoid them for the next message
  const lastMessage = channel.messages[channel.messages.length - 1];
  const lastSpeaker = lastMessage ? lastMessage.nickname : null;
  const avoidLastSpeaker = lastSpeaker ? shuffledUsers.filter(user => user.nickname !== lastSpeaker) : shuffledUsers;

  // Identify users who haven't spoken in a while (last 5 messages) for priority selection
  // Exclude current user from long-term recent speakers tracking
  const longTermRecentSpeakers = channel.messages.slice(-5)
    .filter(msg => msg.nickname !== currentUserNickname)
    .map(msg => msg.nickname);
  const longTermInactiveUsers = shuffledUsers.filter(user => !longTermRecentSpeakers.includes(user.nickname));

  // Time-based user activity patterns with Afterhours Protocol
  const now = new Date();
  const hour = now.getHours();
  const afterhoursActive = isAfterhoursProtocol();

  // Adjust user selection based on time of day and Afterhours Protocol
  let timeBasedUsers = shuffledUsers;

  if (afterhoursActive) {
    // Afterhours Protocol: Prefer nocturnal and creative personalities
    const nocturnalUsers = shuffledUsers.filter(user =>
      (user.personality && user.personality.toLowerCase().includes('creative')) ||
      (user.personality && user.personality.toLowerCase().includes('artistic')) ||
      (user.personality && user.personality.toLowerCase().includes('mysterious')) ||
      (user.personality && user.personality.toLowerCase().includes('philosophical')) ||
      (user.personality && user.personality.toLowerCase().includes('rebellious')) ||
      (user.personality && user.personality.toLowerCase().includes('independent')) ||
      (user.personality && user.personality.toLowerCase().includes('spontaneous')) ||
      (user.personality && user.personality.toLowerCase().includes('adventurous')) ||
      (getWritingStyle(user).verbosity === 'detailed') ||
      (getWritingStyle(user).verbosity === 'verbose') ||
      (getWritingStyle(user).verbosity === 'extremely_verbose') ||
      (getWritingStyle(user).verbosity === 'novel_length')
    );
    // Use nocturnal users with 70% probability during afterhours
    timeBasedUsers = nocturnalUsers.length > 0 && Math.random() < 0.7 ? nocturnalUsers : shuffledUsers;
    aiDebug.log(` Afterhours Protocol active - using ${nocturnalUsers.length} nocturnal users`);
  } else if (hour >= 6 && hour < 12) {
    // Morning: Prefer users with energetic personalities, but include others too
    const energeticUsers = shuffledUsers.filter(user =>
      (user.personality && user.personality.toLowerCase().includes('energetic')) ||
      (user.personality && user.personality.toLowerCase().includes('optimistic')) ||
      (user.personality && user.personality.toLowerCase().includes('morning')) ||
      (getWritingStyle(user).verbosity === 'detailed') ||
      (getWritingStyle(user).verbosity === 'verbose') ||
      (getWritingStyle(user).verbosity === 'extremely_verbose') ||
      (getWritingStyle(user).verbosity === 'novel_length')
    );
    // If we have energetic users, use them with 60% probability, otherwise use all users
    timeBasedUsers = energeticUsers.length > 0 && Math.random() < 0.6 ? energeticUsers : shuffledUsers;
  } else if (hour >= 21 || hour < 6) {
    // Late night/early morning: Prefer users with introspective personalities, but include others too
    const introspectiveUsers = shuffledUsers.filter(user =>
      (user.personality && user.personality.toLowerCase().includes('quiet')) ||
      (user.personality && user.personality.toLowerCase().includes('introspective')) ||
      (user.personality && user.personality.toLowerCase().includes('night')) ||
      (getWritingStyle(user).verbosity === 'terse') ||
      (getWritingStyle(user).verbosity === 'brief')
    );
    // If we have introspective users, use them with 20% probability, otherwise use all users
    timeBasedUsers = introspectiveUsers.length > 0 && Math.random() < 0.2 ? introspectiveUsers : shuffledUsers;
  }

  // Much more balanced user selection to allow natural conversation flow
  // Significantly reduced restrictions to allow all users to participate regularly

  // 30% chance to use completely random selection to ensure diversity
  if (Math.random() < 0.3) {
    aiDebug.log(' Using completely random selection for diversity');
    candidateUsers = shuffledUsers;
  } else if (longTermInactiveUsers.length > 0) {
    // 20% chance to prefer long-term inactive users (users who haven't spoken in last 5 messages)
    candidateUsers = Math.random() < 0.2 ? longTermInactiveUsers : timeBasedUsers;
  } else if (lessActiveUsers.length > 0) {
    // 15% chance to prefer less active users (users who haven't spoken in last 2 messages)
    candidateUsers = Math.random() < 0.15 ? lessActiveUsers : timeBasedUsers;
  } else if (avoidLastSpeaker.length > 0 && lastSpeaker) {
    // If no less active users, avoid the last speaker but allow others
    candidateUsers = avoidLastSpeaker;
  } else {
    // Fallback to time-based selection
    candidateUsers = timeBasedUsers;
  }

  // Ensure we always have candidate users
  if (candidateUsers.length === 0) {
    candidateUsers = shuffledUsers;
  }

  // More aggressive user rotation to prevent spam: avoid users who have spoken 2+ times in the last 7 messages
  const recentUserCounts = channel.messages.slice(-7)
    .filter(msg => msg.nickname !== currentUserNickname)
    .reduce((counts, msg) => {
      counts[msg.nickname] = (counts[msg.nickname] || 0) + 1;
      return counts;
    }, {} as Record<string, number>);

  const overactiveUsers = Object.entries(recentUserCounts)
    .filter(([_, count]) => (count as number) >= 2)
    .map(([nickname, _]) => nickname);

  if (overactiveUsers.length > 0) {
    aiDebug.log(` Detected overactive users: ${overactiveUsers.join(', ')} - gentle rotation`);
    // Only reduce probability, don't completely filter out
    candidateUsers = candidateUsers.filter(user => !overactiveUsers.includes(user.nickname));

    // If filtering removed all candidates, use all users as fallback
    if (candidateUsers.length === 0) {
      aiDebug.warn(' No candidates after overactive filtering, using all users as fallback');
      candidateUsers = shuffledUsers;
    }
  }

  const randomUser = candidateUsers[Math.floor(Math.random() * candidateUsers.length)];

  // Safety check to ensure we have a valid user
  if (!randomUser) {
    aiDebug.error(` No valid user found! candidateUsers.length: ${candidateUsers.length}`);
    aiDebug.error(' candidateUsers:', candidateUsers.map(u => u.nickname));
    aiDebug.error(' shuffledUsers:', shuffledUsers.map(u => u.nickname));
    aiDebug.error(' overactiveUsers:', overactiveUsers);
    throw new Error('No valid user found for channel activity');
  }

  return randomUser;
};

// Helper function to manage typing indicators
const manageTypingIndicator = (
  isTyping: boolean,
  nickname: string,
  addMessageToContext?: (message: Message, context: unknown) => void,
  updateMessageInContext?: (message: Message, context: unknown) => void,
  generateUniqueMessageId?: () => number,
  activeContext?: unknown,
  typingMessageId?: number,
  result?: string
): number | undefined => {
  if (isTyping && addMessageToContext && generateUniqueMessageId && activeContext) {
    const newTypingMessageId = generateUniqueMessageId();
    const typingMessage: UserContentMessage = {
      id: newTypingMessageId,
      nickname,
      content: '',
      timestamp: new Date(),
      type: 'ai',
      isTyping: true
    };
    addMessageToContext(typingMessage, activeContext);
    return newTypingMessageId;
  } else if (!isTyping && typingMessageId && updateMessageInContext && activeContext) {
    updateMessageInContext(
      {
        id: typingMessageId,
        nickname,
        content: result || '',
        timestamp: new Date(),
        type: 'ai',
        isTyping: false
      } as UserContentMessage,
      activeContext
    );
  }
  return undefined;
};

export const generateChannelActivity = async (
  channel: Channel,
  currentUserNickname: string,
  model: string = 'gemini-3-flash-preview',
  addMessageToContext?: (message: Message, context: unknown) => void,
  updateMessageInContext?: (message: Message, context: unknown) => void,
  generateUniqueMessageId?: () => number,
  activeContext?: unknown
): Promise<string> => {
  aiDebug.debug(`Entering generateChannelActivity for channel: ${channel.name}`);
  aiDebug.log(`[LOOP DEBUG] generateChannelActivity called for channel: ${channel.name}`);
  aiDebug.log(` generateChannelActivity called for channel: ${channel.name}`);
  aiDebug.log(` Model parameter: "${model}" (type: ${typeof model}, length: ${model.length})`);

  const validatedModel = validateModelId(model);
  aiDebug.log(` Validated model ID: "${validatedModel}"`);

  // Language-based model selection for Finnish conversations
  const dominantLanguage = getDominantLanguage(channel);
  aiDebug.log(` Channel dominant language: "${dominantLanguage}"`);

  let finalModel = validatedModel;

  // Auto-switch to Finnish-optimized model for Finnish conversations
  if (dominantLanguage === 'Finnish' && validatedModel === 'ollama') {
    // Check if a Finnish model is configured
    if (process.env.OLLAMA_MODEL && (
      process.env.OLLAMA_MODEL.includes('finnish') ||
      process.env.OLLAMA_MODEL.includes('Finnish') ||
      process.env.OLLAMA_MODEL.includes('llama3') && process.env.OLLAMA_MODEL.includes('fin')
    )) {
      finalModel = 'ollama'; // Keep using Ollama but with Finnish model
      aiDebug.log(`🇫🇮 Auto-selected Finnish model for Finnish conversation: "${process.env.OLLAMA_MODEL}"`);
    } else {
      aiDebug.log(`🇫🇮 Finnish conversation detected but no Finnish model configured, using default model`);
    }
  }

  const usersInChannel = channel.users.filter(u => u.nickname !== currentUserNickname);
  aiDebug.log(` Channel ${channel.name} users:`, channel.users.map(u => u.nickname));
  aiDebug.log(` Current user nickname: "${currentUserNickname}"`);
  aiDebug.log(' Filtered users (excluding current user):', usersInChannel.map(u => u.nickname));

  if (usersInChannel.length === 0) {
    aiDebug.log(` No virtual users in channel ${channel.name} (excluding current user) - skipping AI generation`);
    return '';
  }

  // Additional safety check to ensure we have valid users
  if (usersInChannel.some(user => !user || !user.nickname)) {
    aiDebug.error(` Invalid users found in channel ${channel.name}:`, usersInChannel);
    return '';
  }

  // Additional safety check: ensure we don't generate messages for the current user
  if (usersInChannel.some(u => u.nickname === currentUserNickname)) {
    aiDebug.log(' Current user found in filtered users - this should not happen! Skipping AI generation');
    return '';
  }

  const randomUser = selectUserForActivity(channel, currentUserNickname, usersInChannel);
  // dominantLanguage already determined above, reuse it

  // Safety check: ensure user has valid languageSkills
  if (!randomUser.languageSkills) {
    aiDebug.error(` User ${randomUser.nickname} has undefined languageSkills!`);
    aiDebug.error(' User object:', randomUser);
    // Set default languageSkills
    randomUser.languageSkills = {
      languages: [{ language: 'English', fluency: 'native', accent: '' }]
    };
  }

  const userLanguages = getAllLanguages(randomUser.languageSkills);
  // Use the first language from language skills, not from personality description
  const primaryLanguage = userLanguages[0] || 'English';

  aiDebug.log(` User ${randomUser.nickname} language skills:`, randomUser.languageSkills);
  aiDebug.log(` User ${randomUser.nickname} languages:`, userLanguages);
  aiDebug.log(` User ${randomUser.nickname} primary language:`, primaryLanguage);
  aiDebug.log(' isPerLanguageFormat check:', isPerLanguageFormat(randomUser.languageSkills));
  aiDebug.log(' isLegacyFormat check:', isLegacyFormat(randomUser.languageSkills));


  const writingStyle = safeGetUserProperty(randomUser, 'writingStyle') as User['writingStyle'];
  const tokenLimit = getTokenLimit(writingStyle.verbosity, writingStyle.emojiUsage);
  aiDebug.log(` Token limit for ${randomUser.nickname} (${writingStyle.verbosity}, ${writingStyle.emojiUsage}): ${tokenLimit}`);

  // Check for greeting spam by the selected user
  const userRecentMessages = channel.messages.slice(-5).filter(msg => msg.nickname === randomUser.nickname);
  const userGreetingCount = userRecentMessages.filter(msg => 'content' in msg && typeof msg.content === 'string' && isGreetingMessage(msg.content)).length;

  aiDebug.log(` User ${randomUser.nickname} greeting count in last 5 messages: ${userGreetingCount}`);



  // Enhanced conversation diversity and repetition prevention
  const conversationVariety = Math.random();
  const repetitivePhrases = detectRepetitivePatterns(channel.messages);
  const recentTopics = extractRecentTopics(channel.messages);
  aiDebug.log('[LOOP DEBUG] Repetitive phrases detected:', repetitivePhrases);
  aiDebug.log('[LOOP DEBUG] Recent topics:', recentTopics);

  let diversityPrompt = '';

  // Anti-greeting spam protection
  let antiGreetingSpam = '';
  if (userGreetingCount >= 2) {
    antiGreetingSpam = `CRITICAL: You have been greeting too much recently (${userGreetingCount} greetings in last 5 messages). DO NOT greet anyone. Instead, contribute to the conversation with meaningful content, ask questions, share thoughts, or discuss topics. Avoid any form of greeting including "hi", "hello", "hey", "welcome", etc.`;
    aiDebug.log(`[LOOP DEBUG] Anti-greeting spam activated for ${randomUser.nickname}: ${userGreetingCount} greetings detected`);
    aiDebug.log(` Anti-greeting spam activated for ${randomUser.nickname}: ${userGreetingCount} greetings detected`);
  }

  // Simplified diversity prompt
  diversityPrompt = getDiversityPrompt(dominantLanguage, recentTopics, repetitivePhrases);

  // Add topic evolution if conversation is getting stale
  let topicEvolution = '';
  if (recentTopics.length > 3) {
    topicEvolution = getTopicEvolutionPrompt(dominantLanguage);
  }

  // Simplified link/image encouragement
  const linkImagePrompt = getLinkSharingPrompt(dominantLanguage);

  // Get time-of-day context
  const timeContext = getTimeOfDayContext(dominantLanguage);
  aiDebug.log(` Time context: ${timeContext}`);

  // Get relationship context for the AI user with other users in the channel
  const relationshipContexts = channel.users
    .filter(u => u.nickname !== randomUser.nickname && u.nickname !== currentUserNickname)
    .map(u => {
      const context = getRelationshipContext(randomUser, u.nickname, channel.name);
      return context ? `Relationship with ${u.nickname}: ${context}` : '';
    })
    .filter(context => context.length > 0)
    .join('\n');

  // SYSTEM INSTRUCTION: Define Persona and strict behavioral rules
  const systemInstruction = `
You are roleplaying as ${randomUser.nickname}.
Personality: ${randomUser.personality}

CRITICAL: Adhere strictly to your writing style:
- Formality: ${writingStyle.formality}
- Verbosity: ${writingStyle.verbosity}
- Humor: ${writingStyle.humor}
- Emoji usage: ${writingStyle.emojiUsage}
- Punctuation: ${writingStyle.punctuation}

CRITICAL: Respond ONLY in ${primaryLanguage}. Do not use any other language.
${userLanguages.length > 1 ? `Available languages: ${userLanguages.join(', ')}. Use ${primaryLanguage} only.` : ''}

LANGUAGE INSTRUCTION: The user's primary language is ${primaryLanguage}. You MUST respond in ${primaryLanguage}.

STAY IN CHARACTER!
`;

  const prompt = `
${timeContext}

CHANNEL CONTEXT:
- Topic: "${channel.topic}"
- The users in the channel are: ${channel.users.map(u => `${u.nickname} (ID: ${u.id})`).join(', ')}.
- Their personalities are: ${channel.users.map(u => `${u.nickname} is ${u.personality}`).join('. ')}.
- Their language skills are: ${channel.users.map(u => {
    const languages = isPerLanguageFormat(u.languageSkills)
      ? u.languageSkills.languages.map(lang => `${lang.language} (${lang.fluency})`).join(', ')
      : getAllLanguages(u.languageSkills).join(', ');
    return `${u.nickname} speaks: ${languages}`;
  }).join('. ')}.
- Channel operators: ${channel.operators.join(', ') || 'None'}.

LAST 20 MESSAGES:
${formatMessageHistory(channel.messages)}

RELATIONSHIP CONTEXT:
${relationshipContexts}

${antiGreetingSpam}
${diversityPrompt}
${topicEvolution}
${linkImagePrompt}

AMBIENT CHATTER GUIDELINES (CRITICAL):
- Your primary goal is to generate ambient, proactive chatter to make the channel feel alive.
- DO NOT just react to the last message. Instead, introduce new topics, share random thoughts, or make observations.
- Don't just ask "Does anyone..." or "Anyone else..." questions. These are boring.
- Instead, make a statement, share an observation, or tell a brief personal anecdote.
- If you ask a question, make it specific or rhetorical.
- It is STRONGLY encouraged to NOT directly respond to the last message. Be independent.
- Think of it as "thinking out loud." What would your character be musing about?

${getSelfTagPreventionInstruction(randomUser.nickname, primaryLanguage)}

Generate a new, single, in-character message from ${randomUser.nickname} that contributes to the channel's atmosphere.
The message should feel natural for the current time of day and social context.
The message must be a single line containing ONLY the message content.
`;

  try {
    aiDebug.log(`[LOOP DEBUG] Full prompt for ${randomUser.nickname}:\n`, prompt);
    aiDebug.log(` Sending request to Gemini for channel activity in ${channel.name}`);
    aiDebug.log(` Using model ID: "${validatedModel}" for API call`);
    // Add temperature variation for more diverse responses
    // Use a slightly wider but safer range (0.7 - 1.1) to encourage creativity without incoherence
    const baseTemperature = 0.7;
    const temperatureVariation = Math.random() * 0.4;
    const finalTemperature = Math.min(1.2, baseTemperature + temperatureVariation);

    aiDebug.log(` Using temperature: ${finalTemperature.toFixed(2)} for ${randomUser.nickname}`);

    const typingMessageId = manageTypingIndicator(true, randomUser.nickname, addMessageToContext, updateMessageInContext, generateUniqueMessageId, activeContext);

    let result: string = '';
    try {
      // Degraded mode: bypass API and use fallback immediately
      if (isDegradedMode()) {
        aiDebug.warn(`[LOOP DEBUG] Degraded mode active; bypassing API for channel activity from ${randomUser.nickname}`);
        aiDebug.warn(`[DEGRADED MODE] Bypassing API for channel activity from ${randomUser.nickname}.`);
        result = getFallbackResponse(randomUser, 'activity');

        // Simulate typing delay for fallback response too
        if (result && result.trim().length > 0) {
          aiDebug.debug(`Simulating typing delay for fallback channel activity: "${result}"`);
          await simulateTypingDelay(result.length, { enabled: true, baseDelay: 30, maxDelay: 100 });
        }
      } else {
        const config = createApiConfig(validatedModel, tokenLimit, systemInstruction, finalTemperature);

        result = await generateContentUnified(prompt, validatedModel, config);

        // Self-tagging prevention cleanup
        const prefixRegex = new RegExp(`^${randomUser.nickname}:\\s*`, 'i');
        if (prefixRegex.test(result)) {
          result = result.replace(prefixRegex, '').trim();
          aiDebug.log(`[Self-Tag Prevention] Removed nickname prefix for ${randomUser.nickname}. Cleaned result: "${result}"`);
        }

        aiDebug.log(`[LOOP DEBUG] Successfully generated channel activity from AI: "${result}"`);
        aiDebug.log(` Successfully generated channel activity: "${result}"`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : JSON.stringify(error, null, 2);
      aiDebug.warn(`[LOOP DEBUG] API call failed, using fallback response for ${randomUser.nickname}:`, errorMessage);
      aiDebug.warn(` API call failed, using fallback response for ${randomUser.nickname}:`, errorMessage);
      recordApiFailure(error, 'channel activity');
      result = getFallbackResponse(randomUser, 'activity');
      aiDebug.log(`[LOOP DEBUG] Using fallback response: "${result}"`);
      aiDebug.log(` Using fallback response: "${result}"`);

      // Simulate typing delay for fallback response too
      if (result && result.trim().length > 0) {
        aiDebug.debug(`Simulating typing delay for fallback channel activity (error): "${result}"`);
        await simulateTypingDelay(result.length, { enabled: true, baseDelay: 30, maxDelay: 100 });
      }
    } finally {
      manageTypingIndicator(false, randomUser.nickname, addMessageToContext, updateMessageInContext, generateUniqueMessageId, activeContext, typingMessageId, result);
    }

    // Process recommendation tags (e.g., Spotify, IMDb)
    result = await recommendationService.processTags(result);

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : JSON.stringify(error, null, 2);
    aiDebug.error(` Error generating channel activity for ${channel.name}:`, {
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
      channelName: channel.name,
      selectedUser: randomUser.nickname,
      userCount: usersInChannel.length
    });
    return '';
  }
};

export const generateReactionToMessage = async (
  channel: Channel,
  userMessage: Message,
  reactingUser: User,
  model: string = 'gemini-3-flash-preview',
  addMessageToContext?: (message: Message, context: unknown) => void,
  updateMessageInContext?: (message: Message, context: unknown) => void,
  generateUniqueMessageId?: () => number,
  activeContext?: unknown
): Promise<string> => {
  aiDebug.debug(`Entering generateReactionToMessage for channel: ${channel.name}`);
  const reactionContent = 'content' in userMessage && userMessage.content ? `"${userMessage.content}"` : '[an action]';
  aiDebug.log(`[LOOP DEBUG] generateReactionToMessage called for channel: ${channel.name}, reacting to: ${reactionContent} from ${userMessage.nickname}`);
  aiDebug.log(` generateReactionToMessage called for channel: ${channel.name}, reacting to: ${userMessage.nickname}`);

  const validatedModel = validateModelId(model);
  aiDebug.log(` Validated model ID for reaction: "${validatedModel}"`);

  // The user to generate a reaction for is now passed in directly.
  const randomUser = reactingUser;
  const usersInChannel = channel.users.filter(u => u.nickname !== reactingUser.nickname);

  aiDebug.log(` User ${randomUser.nickname} is reacting to ${userMessage.nickname}'s message (language: ${getAllLanguages(randomUser.languageSkills)[0]})`);

  // Handle different message types
  let messageDescription = '';
  if (userMessage.type === 'action') {
    messageDescription = `performed an action: *${userMessage.nickname} ${'content' in userMessage ? userMessage.content : ''}*`;
  } else if ('content' in userMessage) {
    messageDescription = `said: "${userMessage.content}"`;
  }

  // Check for greeting spam by the selected user
  const userRecentMessages = channel.messages.slice(-5).filter(msg => msg.nickname === randomUser.nickname);
  const userGreetingCount = userRecentMessages.filter(msg => 'content' in msg && typeof msg.content === 'string' && isGreetingMessage(msg.content)).length;

  aiDebug.log(` Reaction - User ${randomUser.nickname} greeting count in last 5 messages: ${userGreetingCount}`);

  const userLanguages = getAllLanguages(randomUser.languageSkills);
  const primaryLanguage = userLanguages[0] || 'English';
  const writingStyle = safeGetUserProperty(randomUser, 'writingStyle') as User['writingStyle'];


  const tokenLimit = getTokenLimit(writingStyle.verbosity, writingStyle.emojiUsage);
  aiDebug.log(` Token limit for reaction from ${randomUser.nickname} (${writingStyle.verbosity}, ${writingStyle.emojiUsage}): ${tokenLimit}`);

  // Get time-of-day context for reactions too
  const timeContext = getTimeOfDayContext(primaryLanguage);
  aiDebug.log(` Time context for reaction: ${timeContext}`);

  // Enhanced reaction diversity and repetition prevention
  const repetitivePhrases = detectRepetitivePatterns(channel.messages);
  aiDebug.log('[LOOP DEBUG] Repetitive phrases detected for reaction:', repetitivePhrases);
  let reactionRepetitionAvoidance = '';
  let reactionAntiGreetingSpam = '';

  if (repetitivePhrases.length > 0) {
    reactionRepetitionAvoidance = `CRITICAL: Avoid repeating these recent phrases: "${repetitivePhrases.join('", "')}". Be creative and use different wording.`;
  }

  // Anti-greeting spam protection for reactions
  if (userGreetingCount >= 2) {
    reactionAntiGreetingSpam = `CRITICAL: You have been greeting too much recently (${userGreetingCount} greetings in last 5 messages). DO NOT greet anyone. Instead, contribute to the conversation with meaningful content, ask questions, share thoughts, or discuss topics. Avoid any form of greeting including "hi", "hello", "hey", "welcome", etc.`;
    aiDebug.log(`[LOOP DEBUG] Reaction - Anti-greeting spam activated for ${randomUser.nickname}: ${userGreetingCount} greetings detected`);
    aiDebug.log(` Reaction - Anti-greeting spam activated for ${randomUser.nickname}: ${userGreetingCount} greetings detected`);
  }

  // Get relationship context for the AI user
  const relationshipContext = getRelationshipContext(randomUser, userMessage.nickname, channel.name);

  // SYSTEM INSTRUCTION: Define Persona and strict behavioral rules
  const systemInstruction = `
You are roleplaying as ${randomUser.nickname}.
Personality: ${randomUser.personality}

CRITICAL: Adhere strictly to your writing style:
- Formality: ${writingStyle.formality}
- Verbosity: ${writingStyle.verbosity}
- Humor: ${writingStyle.humor}
- Emoji usage: ${writingStyle.emojiUsage}
- Punctuation: ${writingStyle.punctuation}

CRITICAL: Respond ONLY in ${primaryLanguage}. Do not use any other language.
${userLanguages.length > 1 ? `Available languages: ${userLanguages.join(', ')}. Use ${primaryLanguage} only.` : ''}

LANGUAGE INSTRUCTION: The user's primary language is ${primaryLanguage}. You MUST respond in ${primaryLanguage}.
STAY IN CHARACTER!
`;

  const prompt = `
${timeContext}

CHANNEL AND MESSAGE CONTEXT:
In Discord channel #${channel.name}:
- Topic: "${channel.topic}"
- The user "${userMessage.nickname}" just ${messageDescription}.
- Other users: ${usersInChannel.map(u => `${u.nickname} (ID: ${u.id})`).join(', ')}.
- Personalities: ${usersInChannel.map(u => `${u.nickname} is ${u.personality}`).join('. ')}.

LAST 20 MESSAGES:
${formatMessageHistory(channel.messages)}

RELATIONSHIP CONTEXT WITH ${userMessage.nickname.toUpperCase()}:
${relationshipContext}

${reactionRepetitionAvoidance}
${reactionAntiGreetingSpam}
${Math.random() < 0.2 ? getBotCommandAndLinkPrompt(primaryLanguage) : ''}

INSTRUCTIONS:
- Reply to ONE person at a time (focus on ${userMessage.nickname}).
- You can naturally reference quotes or points made.
- Be natural and conversational.

${getSelfTagPreventionInstruction(randomUser.nickname, primaryLanguage)}

Generate a new, single, in-character reaction from ${randomUser.nickname}.
`;

  try {
    aiDebug.log(`[LOOP DEBUG] Full prompt for reaction from ${randomUser.nickname}:\n`, prompt);
    aiDebug.log(` Sending request to Gemini for reaction in ${channel.name}`);

    // Add temperature variation for reactions too
    const baseTemperature = 0.8;
    const temperatureVariation = Math.random() * 0.3;
    const finalTemperature = Math.min(1.0, baseTemperature + temperatureVariation);

    aiDebug.log(` Using temperature: ${finalTemperature.toFixed(2)} for reaction from ${randomUser.nickname}`);

    const typingMessageId = manageTypingIndicator(true, randomUser.nickname, addMessageToContext, updateMessageInContext, generateUniqueMessageId, activeContext);

    let result: string = '';
    try {
      // Degraded mode: bypass API and use fallback immediately
      if (isDegradedMode()) {
        aiDebug.warn(`[LOOP DEBUG] Degraded mode active; bypassing API for reaction from ${randomUser.nickname}`);
        aiDebug.warn(`[DEGRADED MODE] Bypassing API for reaction from ${randomUser.nickname}.`);
        result = getFallbackResponse(randomUser, 'reaction', ('content' in userMessage && userMessage.content) || undefined);

        // Simulate typing delay for fallback response too
        if (result && result.trim().length > 0) {
          aiDebug.debug(`Simulating typing delay for fallback reaction: "${result}"`);
          await simulateTypingDelay(result.length, { enabled: true, baseDelay: 30, maxDelay: 100 });
        }
      } else {
        const config = createApiConfig(validatedModel, tokenLimit, systemInstruction, finalTemperature);

        result = await generateContentUnified(prompt, validatedModel, config);

        // Self-tagging prevention cleanup
        const prefixRegex = new RegExp(`^${randomUser.nickname}:\\s*`, 'i');
        if (prefixRegex.test(result)) {
          result = result.replace(prefixRegex, '').trim();
          aiDebug.log(`[Self-Tag Prevention] Removed nickname prefix for ${randomUser.nickname}. Cleaned result: "${result}"`);
        }

        aiDebug.log(`[LOOP DEBUG] Successfully generated reaction from AI: "${result}"`);
        aiDebug.log(` Successfully generated reaction: "${result}"`);
      }
    } catch (apiError) {
      const errorMessage = apiError instanceof Error ? apiError.message : JSON.stringify(apiError, null, 2);
      aiDebug.warn(`[LOOP DEBUG] API call failed, trying alternative model for reaction from ${randomUser.nickname}:`, errorMessage);

      // Try with a different model before falling back
      try {
        const fallbackModels = ['ollama'];
        for (const fallbackModel of fallbackModels) {
          try {
            aiDebug.log(`Trying fallback model: ${fallbackModel} for ${randomUser.nickname}`);
            const fallbackConfig = createApiConfig(fallbackModel, tokenLimit, systemInstruction, finalTemperature);
            result = await generateContentUnified(prompt, fallbackModel, fallbackConfig);
            if (result && result.trim().length > 0) {
              aiDebug.log(`Successfully generated reaction with fallback model ${fallbackModel}: "${result}"`);
              break;
            }
          } catch (fallbackError) {
            aiDebug.warn(`Fallback model ${fallbackModel} also failed for ${randomUser.nickname}`);
            continue;
          }
        }
      } catch (fallbackError) {
        aiDebug.warn(`All fallback models failed for ${randomUser.nickname}, using predefined response`);
      }

      // Only use predefined fallback if all AI attempts failed
      if (!result || result.trim().length === 0) {
        recordApiFailure(apiError, 'reaction');
        result = getFallbackResponse(randomUser, 'reaction', ('content' in userMessage && userMessage.content) || undefined);
        aiDebug.log(`[LOOP DEBUG] Using fallback reaction: "${result}"`);
        aiDebug.log(` Using fallback reaction: "${result}"`);
      }

      // Simulate typing delay for fallback response too
      if (result && result.trim().length > 0) {
        aiDebug.debug(`Simulating typing delay for fallback reaction (error): "${result}"`);
        await simulateTypingDelay(result.length, { enabled: true, baseDelay: 30, maxDelay: 100 });
      }
    } finally {
      manageTypingIndicator(false, randomUser.nickname, addMessageToContext, updateMessageInContext, generateUniqueMessageId, activeContext, typingMessageId, result);
    }

    // Process recommendation tags (e.g., Spotify, IMDb)
    result = await recommendationService.processTags(result);

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : JSON.stringify(error, null, 2);
    aiDebug.error(` Error generating reaction for ${channel.name}:`, {
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
      channelName: channel.name,
      reactingUser: randomUser.nickname,
      originalMessage: 'content' in userMessage ? userMessage.content : undefined,
      originalUser: userMessage.nickname,
      messageType: userMessage.type
    });
    return '';
  }
};

// Enhanced conversation context analysis for better PM responses
interface ConversationContext {
  topics: string[];
  recentTopics: string[];
  conversationTone: 'casual' | 'formal' | 'technical' | 'personal' | 'mixed';
  relationshipLevel: 'new' | 'acquaintance' | 'friendly' | 'close';
  sharedInterests: string[];
  previousDiscussions: string[];
  conversationMomentum: 'building' | 'maintaining' | 'declining';
}

// Build contextual prompt based on conversation analysis
const buildContextualPrompt = (
  context: ConversationContext,
  aiUser: User,
  currentUserNickname: string,
  userMessage: Message | null,
  timeContext: string,
  primaryLanguage: string,
  userLanguages: string[],
  writingStyle: { formality: string; verbosity: string; humor: string; emojiUsage: string; punctuation: string }
): string => {
  let contextualGuidance = '';

  // Relationship-based guidance
  switch (context.relationshipLevel) {
    case 'new':
      // For new conversations, check if this is truly the first message or just an autonomous follow-up
      if (userMessage === null) {
        // Autonomous PM - if there are no messages yet, initiate; otherwise continue
        contextualGuidance += `This is a new conversation - you're initiating contact. Start with something that reflects YOUR personality (${aiUser.personality}). Share a thought, observation, or question that shows who you are. Don't just say "hi" - be interesting and authentic to your character. Make them curious about you.`;
      } else {
        contextualGuidance += `This is a new conversation. Be friendly and welcoming. Respond directly to what they said. Start to show YOUR personality (${aiUser.personality}) through your response.`;
      }
      break;
    case 'acquaintance':
      contextualGuidance += 'You have chatted a few times before. Be friendly and reference previous conversations if relevant. Show interest in their life. Continue the conversation naturally based on what you\'ve discussed.';
      break;
    case 'friendly':
      contextualGuidance += 'You are becoming friends. Be warm and supportive. Share personal thoughts and ask about their experiences. Reference shared interests and previous conversations. Continue naturally from where you left off.';
      break;
    case 'close':
      contextualGuidance += 'You are close friends. Be very personal and supportive. Reference shared memories and inside jokes. Be emotionally available. Continue the conversation as you would with a close friend.';
      break;
  }

  // Tone-based guidance
  switch (context.conversationTone) {
    case 'casual':
      contextualGuidance += ' Keep the conversation relaxed and informal. Use casual language and be approachable.';
      break;
    case 'formal':
      contextualGuidance += ' Maintain a polite and professional tone. Use proper grammar and formal language.';
      break;
    case 'technical':
      contextualGuidance += ' Focus on technical topics and use appropriate terminology. Be precise and knowledgeable.';
      break;
    case 'personal':
      contextualGuidance += ' Share personal thoughts and feelings. Be vulnerable and authentic. Ask about their personal experiences.';
      break;
    case 'mixed':
      contextualGuidance += ' Balance between formal and casual tones as appropriate. Adapt to the conversation flow.';
      break;
  }

  // Topic continuity - ONLY if this is NOT a direct response to a recent message
  // If userMessage is null, it means we are acting autonomously/quietly
  if (userMessage === null && context.recentTopics.length > 0) {
    contextualGuidance += ` Continue discussing topics related to: ${context.recentTopics.join(', ')}. Reference previous points made about these topics.`;
  } else if (userMessage === null) {
    contextualGuidance += ' The conversation has been quiet. Introduce a new topic to get things started again.';
  } else if (context.recentTopics.length > 0) {
    // If responding to a message, just mention topics as context, don't force them
    contextualGuidance += ` Recent context includes: ${context.recentTopics.join(', ')}.`;
  }

  // Momentum-based guidance
  switch (context.conversationMomentum) {
    case 'building':
      contextualGuidance += ' The conversation is getting more active. Ask engaging questions and share interesting thoughts to keep the momentum going.';
      break;
    case 'maintaining':
      contextualGuidance += ' Keep the conversation flowing naturally. Respond thoughtfully and ask follow-up questions.';
      break;
    case 'declining':
      contextualGuidance += ' The conversation seems to be slowing down. Try to re-engage with interesting questions or topics. Introduce something new to discuss.';
      break;
  }

  // Memory and continuity
  if (context.previousDiscussions.length > 0) {
    contextualGuidance += ` Remember and reference previous discussions about: ${context.previousDiscussions.join(', ')}. Show that you remember what was said before.`;
  }

  // Shared interests
  if (context.sharedInterests.length > 0) {
    contextualGuidance += ` You share interests in: ${context.sharedInterests.join(', ')}. Use this as a basis for deeper conversation.`;
  }

  return contextualGuidance;
};

// Generate conversation summary for better memory
const generateConversationSummary = (messages: Message[], currentUserNickname: string): string => {
  const recentMessages = messages.slice(-10);
  const topics = new Set<string>();
  const keyPoints: string[] = [];

  // Extract key topics and points
  recentMessages.forEach(msg => {
    if (!('content' in msg) || typeof msg.content !== 'string') return;
    const content = msg.content.toLowerCase();

    // Extract topics
    if (content.includes('work') || content.includes('job')) topics.add('work');
    if (content.includes('family') || content.includes('friend')) topics.add('personal');
    if (content.includes('tech') || content.includes('computer')) topics.add('technology');
    if (content.includes('hobby') || content.includes('interest')) topics.add('hobbies');

    // Extract key points (simple heuristic)
    if (content.length > 50 && (content.includes('think') || content.includes('believe') || content.includes('feel'))) {
      keyPoints.push(msg.content.substring(0, 100) + '...');
    }
  });

  const summary = `Recent topics: ${Array.from(topics).join(', ')}. Key points: ${keyPoints.slice(0, 3).join('; ')}`;
  return summary;
};

const analyzeConversationContext = (messages: Message[], currentUserNickname: string): ConversationContext => {
  const recentMessages = messages.slice(-10); // Last 10 messages for context
  const topics: string[] = [];
  const sharedInterests: string[] = [];
  const previousDiscussions: string[] = [];

  // Extract topics from recent messages
  recentMessages.forEach(msg => {
    if (!('content' in msg) || typeof msg.content !== 'string') return;
    const content = msg.content.toLowerCase();

    // Common topic keywords
    const topicKeywords = {
      'work': ['work', 'job', 'career', 'office', 'meeting', 'project', 'deadline', 'boss', 'colleague'],
      'technology': ['tech', 'computer', 'programming', 'code', 'software', 'hardware', 'ai', 'machine learning', 'app', 'bug'],
      'hobbies': ['hobby', 'interest', 'passion', 'fun', 'game', 'music', 'art', 'sport', 'craft'],
      'personal': ['family', 'friend', 'relationship', 'life', 'home', 'travel', 'vacation', 'feel', 'sad', 'happy', 'angry', 'upset', 'tired', 'love', 'hate'],
      'current events': ['news', 'politics', 'world', 'event', 'happening', 'trending', 'viral'],
      'entertainment': ['movie', 'show', 'book', 'music', 'concert', 'festival', 'entertainment', 'watch', 'listen', 'play', 'read']
    };

    Object.entries(topicKeywords).forEach(([topic, keywords]) => {
      if (keywords.some(keyword => content.includes(keyword))) {
        if (!topics.includes(topic)) {
          topics.push(topic);
        }
      }
    });
  });

  // Determine conversation tone
  const formalWords = ['please', 'thank you', 'appreciate', 'regarding', 'furthermore'];
  const casualWords = ['hey', 'cool', 'awesome', 'yeah', 'sure', 'lol', 'haha'];
  const technicalWords = ['algorithm', 'function', 'database', 'api', 'framework', 'architecture'];
  const personalWords = ['feel', 'think', 'believe', 'opinion', 'experience', 'remember'];

  const allContent = recentMessages.map(m => ('content' in m && m.content) || '').join(' ').toLowerCase();
  const formalCount = formalWords.filter(word => allContent.includes(word)).length;
  const casualCount = casualWords.filter(word => allContent.includes(word)).length;
  const technicalCount = technicalWords.filter(word => allContent.includes(word)).length;
  const personalCount = personalWords.filter(word => allContent.includes(word)).length;

  let conversationTone: ConversationContext['conversationTone'] = 'casual';
  if (technicalCount > 2) conversationTone = 'technical';
  else if (formalCount > casualCount) conversationTone = 'formal';
  else if (personalCount > 3) conversationTone = 'personal';
  else if (formalCount > 0 && casualCount > 0) conversationTone = 'mixed';

  // Determine relationship level based on conversation history
  const messageCount = messages.length;
  const userMessages = messages.filter(m => m.nickname === currentUserNickname).length;
  const aiMessages = messages.length - userMessages;

  let relationshipLevel: ConversationContext['relationshipLevel'] = 'new';
  if (messageCount > 20) relationshipLevel = 'close';
  else if (messageCount > 10) relationshipLevel = 'friendly';
  else if (messageCount > 5) relationshipLevel = 'acquaintance';

  // Determine conversation momentum
  const recentActivity = recentMessages.length;
  const olderMessages = messages.slice(-20, -10);
  const olderActivity = olderMessages.length;

  let conversationMomentum: ConversationContext['conversationMomentum'] = 'maintaining';
  if (recentActivity > olderActivity + 2) conversationMomentum = 'building';
  else if (recentActivity < olderActivity - 2) conversationMomentum = 'declining';

  return {
    topics: topics.slice(0, 5), // Top 5 topics
    recentTopics: topics.slice(0, 3), // Top 3 recent topics
    conversationTone,
    relationshipLevel,
    sharedInterests: sharedInterests.slice(0, 3),
    previousDiscussions: previousDiscussions.slice(0, 3),
    conversationMomentum
  };
};

export const generatePrivateMessageResponse = async (
  conversation: PrivateMessageConversation,
  userMessage: Message | null,
  currentUserNickname: string,
  model: string = 'gemini-3-flash-preview',
  addMessageToContext?: (message: Message, context: unknown) => void,
  updateMessageInContext?: (message: Message, context: unknown) => void,
  generateUniqueMessageId?: () => number,
  activeContext?: unknown
): Promise<{ content: string, imageBuffer?: Buffer, audioBuffer?: Buffer } | null> => {
  aiDebug.debug(`Entering generatePrivateMessageResponse for user: ${conversation.user.nickname}`);

  const aiUser = conversation.user;
  const userLanguages = getAllLanguages(aiUser.languageSkills);
  const primaryLanguage = userLanguages[0] || 'English';
  const writingStyle = safeGetUserProperty(aiUser, 'writingStyle') as User['writingStyle'];

  // -------------------------------------------------------------------------
  // IMAGE ANALYSIS HANDLING (DM Vision)
  // -------------------------------------------------------------------------
  if (userMessage && 'attachments' in userMessage && userMessage.attachments && userMessage.attachments.length > 0) {
    const imageAttachment = userMessage.attachments.find(att => att.type === 'image' && att.url);

    if (imageAttachment && imageAttachment.url) {
      try {
        aiDebug.log(`📸 Image detected in DM from ${conversation.user.nickname}`);

        // Download image
        const response = await axios.get(imageAttachment.url, { responseType: 'arraybuffer' });
        const imageBuffer = Buffer.from(response.data, 'binary');


        // Use Gemini for Image Analysis
        const userText = 'content' in userMessage ? userMessage.content : '';
        const systemInstruction = getBaseSystemInstruction(currentUserNickname);
        const visionPrompt = `
${systemInstruction}

CONTEXT:
You received this image in a direct message (DM) from ${conversation.user.nickname}.
${userText ? `The user also said: "${userText}"` : 'The user sent this image without text.'}

CRITICAL: Respond ONLY in ${primaryLanguage}.
LANGUAGE INSTRUCTION: The user's primary language is ${primaryLanguage}. You MUST respond in ${primaryLanguage}.

YOUR TASK:
Analyze the image and respond naturally to the user.
- If there is text, address both the text and the image.
- If it's just an image, react to it based on your personality.
- Be helpful, funny, or impressed as appropriate.
- Keep the response conversational and relatively concise (don't write a novel).
`;

        const mimeType = (imageAttachment as any).contentType || 'image/jpeg';
        const commentary = await analyzeImageWithGemini(visionPrompt, imageBuffer, mimeType);
        aiDebug.log(`✅ DM Image analyzed (Gemini): "${commentary.substring(0, 50)}..."`);

        return { content: commentary };

      } catch (error) {
        aiDebug.error('❌ Failed to process DM image:', error);
        // Fall through to normal text processing if image fails
      }
    }
  }

  // -------------------------------------------------------------------------
  // AUDIO ANALYSIS HANDLING (DM Voice)
  // -------------------------------------------------------------------------
  if (userMessage && 'attachments' in userMessage && userMessage.attachments && userMessage.attachments.length > 0) {
    // Check for audio attachments
    const audioAttachment = userMessage.attachments.find(att =>
      att.type === 'audio' ||
      (att.fileName && (att.fileName.endsWith('.ogg') || att.fileName.endsWith('.mp3') || att.fileName.endsWith('.wav') || att.fileName.endsWith('.m4a')))
    );

    if (audioAttachment && audioAttachment.url) {
      try {
        aiDebug.log(`🎙️ Audio detected in DM from ${conversation.user.nickname}`);

        // Download audio
        const response = await axios.get(audioAttachment.url, { responseType: 'arraybuffer' });
        const audioBuffer = Buffer.from(response.data, 'binary');

        // Transcribe
        if (speechToTextService.isConfigured()) {
          const transcript = await speechToTextService.transcribe(audioBuffer);

          if (transcript) {
            aiDebug.log(`✅ DM Audio transcribed: "${transcript}"`);

            // Inject transcription into the message content for the AI to react to
            // We'll modify the userMessage content effectively for the context of this specific generation

            const originalContent = 'content' in userMessage ? userMessage.content : '';
            const augmentedContent = originalContent
              ? `${originalContent}\n\n[Audio Attachment Transcribed]: "${transcript}"`
              : `[Audio Attachment Transcribed]: "${transcript}"`;

            if ('content' in userMessage) {
              (userMessage as any).content = augmentedContent;
            }

            aiDebug.log(`📝 Augmented user prompt with transcription: "${augmentedContent}"`);

          } else {
            aiDebug.warn('⚠️ Audio transcription was empty.');
          }
        } else {
          aiDebug.warn('⚠️ STT service not configured, skipping audio analysis.');
        }

      } catch (error) {
        aiDebug.error('❌ Failed to process DM audio:', error);
      }
    }
  }
  // -------------------------------------------------------------------------
  aiDebug.log(` generatePrivateMessageResponse called for user: ${conversation.user.nickname}`);

  const validatedModel = validateModelId(model);
  aiDebug.log(` Validated model ID for private message: "${validatedModel}"`);

  // Enhanced conversation context analysis
  const conversationContext = analyzeConversationContext(conversation.messages, currentUserNickname);
  const conversationSummary = generateConversationSummary(conversation.messages, currentUserNickname);
  aiDebug.log(` Conversation context analysis: ${JSON.stringify(conversationContext)}`);
  aiDebug.log(` Conversation summary: ${conversationSummary}`);


  const tokenLimit = getTokenLimit(writingStyle.verbosity, writingStyle.emojiUsage);
  aiDebug.log(` Token limit for private message from ${aiUser.nickname} (${writingStyle.verbosity}, ${writingStyle.emojiUsage}): ${tokenLimit}`);

  // Get time-of-day context for private messages too
  const timeContext = getTimeOfDayContext(primaryLanguage);
  aiDebug.log(` Time context for private message: ${timeContext}`);

  // Enhanced prompt with conversation context
  const contextPrompt = buildContextualPrompt(conversationContext, aiUser, currentUserNickname, userMessage, timeContext, primaryLanguage, userLanguages, writingStyle);

  // Check for recently asked questions by the bot
  const recentQuestions = extractRecentQuestions(conversation.messages, aiUser.nickname);
  let questionRepetitionAvoidance = '';
  if (recentQuestions.length > 0) {
    questionRepetitionAvoidance = `
CRITICAL: You have recently asked the following questions. DO NOT ASK THEM AGAIN:
${recentQuestions.map((q: string) => `- "${q}"`).join('\n')}
You must ask something completely different or make a statement instead.`;
    aiDebug.log(`[LOOP DEBUG] Found ${recentQuestions.length} recent questions for ${aiUser.nickname}. Adding avoidance instruction.`);
  }

  // Check for greeting spam by the AI user
  const userRecentMessages = conversation.messages.slice(-5).filter(msg => msg.nickname === aiUser.nickname);
  const userGreetingCount = userRecentMessages.filter(msg => 'content' in msg && typeof msg.content === 'string' && isGreetingMessage(msg.content)).length;

  aiDebug.log(` Private Message - User ${aiUser.nickname} greeting count in last 5 messages: ${userGreetingCount}`);

  let antiGreetingSpam = '';
  if (userGreetingCount >= 2) {
    antiGreetingSpam = `CRITICAL: You have been greeting too much recently (${userGreetingCount} greetings in last 5 messages). DO NOT greet anyone. Instead, contribute to the conversation with meaningful content, ask questions, share thoughts, or discuss topics. Avoid any form of greeting including "hi", "hello", "hey", "welcome", etc.`;
    aiDebug.log(` Private Message - Anti-greeting spam activated for ${aiUser.nickname}`);
  }

  // Get relationship context for private messages
  const relationshipContext = getRelationshipContext(aiUser, currentUserNickname, 'private');

  // Check if image generation is available
  const aiServiceConfig = getAIServiceConfig();
  const canGenerateImages = aiServiceConfig.apiKey && !aiServiceConfig.apiKey.startsWith('dummy-key');

  // Check if Ollama will be used (for prompt optimization)
  const isOllamaPrimary = validatedModel === 'ollama';
  const ollamaConfig = getOllamaConfig();
  const willUseOllama = isOllamaPrimary || ollamaConfig.enabled;

  // SYSTEM INSTRUCTION: Optimized for Ollama vs other models
  let systemInstruction: string;

  if (willUseOllama) {
    // Simplified system instruction for Ollama (more direct, less verbose)
    // But with STRONG language enforcement for Finnish
    if (primaryLanguage === 'Finnish') {
      systemInstruction = `Olet ${aiUser.nickname}, Discord-käyttäjä.

Personallisuus: ${aiUser.personality}

Kirjoitustyyli:
- Formaalisuus: ${writingStyle.formality}
- Sanallisuus: ${writingStyle.verbosity}
- Huumori: ${writingStyle.humor}
- Emojit: ${writingStyle.emojiUsage}
- Välimerkit: ${writingStyle.punctuation}

KRIITTINEN: Vastaat AINOASTAAN suomeksi. ÄLÄ käytä englantia tai mitään muuta kieltä.
ÄLÄ koskaan vastaa englanniksi. Kaikki vastaukset SUOMEKSI.

SUOMEN KIELEN SÄÄNNÖT:
- Käytä luonnollista suomea
- Oikea kielioppi ja taivutus
- Vältä englanninkielisiä lainasanoja kun mahdollista
- Käytä suomenkielisiä idiomeja luonnollisesti
- Oikea sanajärjestys (subjekti-objekti-verbi)
- Älä käännä suoraan englannista - ajattele suomeksi

Pysy hahmossa. Ole luonnollinen ja keskustelullinen.`;
    } else {
      systemInstruction = `You are ${aiUser.nickname}, a Discord user.

Personality: ${aiUser.personality}

Writing style:
- Formality: ${writingStyle.formality}
- Verbosity: ${writingStyle.verbosity}
- Humor: ${writingStyle.humor}
- Emoji: ${writingStyle.emojiUsage}
- Punctuation: ${writingStyle.punctuation}

CRITICAL: Always respond in ${primaryLanguage} only. Never use any other language.

Stay in character. Be conversational and natural.`;
    }
  } else {
    // Full detailed system instruction for Gemini
    systemInstruction = `
You are roleplaying as a Discord user named '${aiUser.nickname}'.
Your personality is: ${aiUser.personality}.

CRITICAL: Adhere strictly to your writing style:
- Formality: ${writingStyle.formality}
- Verbosity: ${writingStyle.verbosity}
- Humor: ${writingStyle.humor}
- Emoji usage: ${writingStyle.emojiUsage}
- Punctuation: ${writingStyle.punctuation}

CRITICAL: Respond ONLY in ${primaryLanguage}. Do not use any other language.
${userLanguages.length > 1 ? `Available languages: ${userLanguages.join(', ')}. Use ${primaryLanguage} only.` : ''}

LANGUAGE INSTRUCTION: The user's primary language is ${primaryLanguage}. You MUST respond in ${primaryLanguage}.

${primaryLanguage === 'Finnish' ? `
SUOMEN KIELEN ERITYISSÄÄNNÖT:
- Älä käytä englanninkielisiä lainasanoja jos mahdollista (esim. "start" → "aloita")
- Käytä oikeita suomen kielen taivutuksia ja sijamuotoja
- Vältä suoraa käännöstä englannista - ajattele suomeksi
- Käytä luonnollisia suomenkielisiä ilmaisuja ja idiomeja
- Huomioi suomen kielen sanajärjestys (subjekti-objekti-verbi usein)
- Älä käytä "että" liian usein - käytä muita sidekonstruktioita
- Vältä englanninkielisiä lauserakenteita suomen kielessä
- Käytä suomalaisia tervehdyksiä ja kohteliaisuusfraaseja

YLEISET VIRHEET VÄLTETTÄVÄ:
- Älä sano "minulla on hyvä päivä" → sano "minulla on hyvä päivä" (mutta luonnollisemmin: "päivä on hyvä")
- Älä sano "miten sinä voit" → sano "miten voit" tai "miten menee"
- Älä sano "minä haluan" → sano "haluan" (subjekti usein pois jätetään)
- Älä käytä "että" joka toisessa lauseessa
- Älä sano "se on hyvä idea" → sano "se on hyvä ajatus" tai "hyvä idea"

LUONNOLLISIA SUOMALAISIA ILMAISUJA:
- "miten menee?" (how's it going?)
- "hauska tavata!" (nice to meet!)
- "mitä kuuluu?" (what's up?)
- "ihan hyvin" (quite well)
- "kiitos kysymästä" (thanks for asking)
- "olen samaa mieltä" (I agree)
- "totta se on" (that's true)
` : ''}

STAY IN CHARACTER!

IMPORTANT CONVERSATION GUIDELINES:
- Be proactive: Ask questions, share personal anecdotes, and try to build a deeper connection. Don't just give passive responses.
- If this is a new conversation, be welcoming and try to get to know the user.
- If this is an ongoing chat, reference previous messages or shared interests.
- Maintain your specific personality traits described above at all times.
${canGenerateImages ? `
IMAGE GENERATION:
You can autonomously decide to generate an image if it fits the conversation context.
To generate an image, include the tag [GENERATE_IMAGE: description] at the end of your message.
DO NOT generate an image if it's not relevant or if you've already generated one recently.
` : ''}
AUDIO GENERATION:
You can also send a voice message if appropriate.
To send a voice message, include the tag [AUDIO: text to speak] at the end of your message.
DO NOT use this tag too often.
`;
  }

  // CONSTRUCT USER PROMPT (Optimized for Ollama)
  let userPrompt: string;

  if (willUseOllama) {
    // Simplified, more direct prompt for Ollama
    // But with STRONG Finnish language enforcement in the prompt itself
    const recentMessages = conversation.messages.slice(-20); // Limit to last 20 for Ollama
    const messageHistory = formatEnhancedMessageHistory(recentMessages);

    if (primaryLanguage === 'Finnish') {
      userPrompt = `${timeContext ? `${timeContext}\n\n` : ''}Olet ${aiUser.nickname} keskustelemassa ${currentUserNickname}:n kanssa yksityisviestissä.

KRIITTINEN: Vastaat AINOASTAAN suomeksi. ÄLÄ käytä englantia.

${conversationSummary ? `Keskustelun yhteenveto: ${conversationSummary}\n` : ''}${relationshipContext ? `Suhde: ${relationshipContext}\n` : ''}${conversationContext.recentTopics.length > 0 ? `Viimeisimmät aiheet: ${conversationContext.recentTopics.join(', ')}\n` : ''}

Keskusteluhistoria:
${messageHistory}

${userMessage && 'content' in userMessage ? `${currentUserNickname}: ${userMessage.content}` : 'Käyttäjä on ollut hiljaa. Lähetä luonnollinen viesti aktivoidaksesi keskustelun.'}
${antiGreetingSpam ? `\n${antiGreetingSpam}` : ''}
${questionRepetitionAvoidance ? `\n${questionRepetitionAvoidance}` : ''}

Vastaa luonnollisesti ${aiUser.nickname}:na. Pysy hahmossa ja vastaa SUOMEKSI. ÄLÄ vastaa englanniksi.`;
    } else {
      userPrompt = `${timeContext ? `${timeContext}\n\n` : ''}You are ${aiUser.nickname} chatting with ${currentUserNickname} in a private message.

CRITICAL: Respond ONLY in ${primaryLanguage}. Never use any other language.

${conversationSummary ? `Conversation summary: ${conversationSummary}\n` : ''}${relationshipContext ? `Relationship: ${relationshipContext}\n` : ''}${conversationContext.recentTopics.length > 0 ? `Recent topics: ${conversationContext.recentTopics.join(', ')}\n` : ''}

Conversation history:
${messageHistory}

${userMessage && 'content' in userMessage ? `${currentUserNickname}: ${userMessage.content}` : 'The user has been quiet. Send a natural message to re-engage them.'}
${antiGreetingSpam ? `\n${antiGreetingSpam}` : ''}
${questionRepetitionAvoidance ? `\n${questionRepetitionAvoidance}` : ''}

Respond naturally as ${aiUser.nickname}. Keep it conversational and in-character.`;
    }
  } else {
    // Full detailed prompt for Gemini
    userPrompt = `
${timeContext}

CONVERSATION CONTEXT & MEMORY:
- Relationship Level: ${conversationContext.relationshipLevel}
- Conversation Tone: ${conversationContext.conversationTone}
- Recent Topics: ${conversationContext.recentTopics.length > 0 ? conversationContext.recentTopics.join(', ') : 'general conversation'}
- Conversation Momentum: ${conversationContext.conversationMomentum}
- Conversation Summary: ${conversationSummary}

RELATIONSHIP CONTEXT WITH ${currentUserNickname.toUpperCase()}:
${relationshipContext}

${contextPrompt}
${antiGreetingSpam}
${questionRepetitionAvoidance}

You are in a private message conversation with '${currentUserNickname}'.
The conversation history (last 40 messages) is:
${formatEnhancedMessageHistory(conversation.messages)}

${userMessage && 'content' in userMessage ? `'${currentUserNickname}' just sent you this message: ${userMessage.content}` : 'AUTONOMOUS MESSAGE: The user has been quiet. Send a message to re-engage them. You can ask a question, share a thought, or bring up a new topic. Be natural and in-character.'}
${userMessage && 'attachments' in userMessage && userMessage.attachments && userMessage.attachments.length > 0 ? `The message also includes the following attachments: ${userMessage.attachments.map((a: unknown) => typeof a === 'object' && a !== null && 'type' in a && 'fileName' in a && 'url' in a ? `${String((a as { type: unknown }).type)}: ${String((a as { fileName: unknown }).fileName)} (${String((a as { url: unknown }).url)})` : 'unknown attachment').join(', ')}` : ''}

${getSelfTagPreventionInstruction(aiUser.nickname, primaryLanguage)}

Generate a natural, in-character response.
The response must be a single line containing ONLY the message content.
DO NOT wrap your response in quotes or quotation marks.
`;
  }

  try {
    aiDebug.log(` Sending request to Gemini for private message response from ${aiUser.nickname}`);

    // Always manage typing indicator, even in degraded mode
    const typingMessageId = manageTypingIndicator(true, aiUser.nickname, addMessageToContext, updateMessageInContext, generateUniqueMessageId, activeContext);

    let result: string = '';
    try {
      // Degraded mode: bypass API and use fallback immediately
      if (isDegradedMode()) {
        if (!userMessage) {
          aiDebug.warn(`[LOOP DEBUG] Degraded mode active; skipping autonomous PM from ${aiUser.nickname}`);
          result = '';
        } else {
          aiDebug.warn(`[LOOP DEBUG] Degraded mode active; using fallback PM for ${aiUser.nickname}`);
          aiDebug.warn(`[DEGRADED MODE] Bypassing API for PM from ${aiUser.nickname}.`);
          result = getPersonalityAwareErrorMessage(aiUser, 'ai_error');

          // Simulate typing delay for fallback response too
          if (result && result.trim().length > 0) {
            aiDebug.debug(`Simulating typing delay for fallback PM response: "${result}"`);
            await simulateTypingDelay(result.length, { enabled: true, baseDelay: 30, maxDelay: 100 });
          }
        }
      } else {
        // Reduced temperature for stability (0.6 - 0.8 range)
        const temperature = 0.6 + (Math.random() * 0.2);
        const config = createApiConfig(validatedModel, tokenLimit, systemInstruction, temperature);

        // Determine fallback models based on bot-specific model
        const fallbackModels: string[] = [];
        const ollamaConfig = getOllamaConfig();

        // Check if we have a valid Gemini API key before adding Gemini as fallback
        const hasGeminiApiKey = process.env.GEMINI_API_KEY?.trim() && process.env.GEMINI_API_KEY.trim().length > 10;

        if (validatedModel === 'ollama') {
          // Ollama is the primary model - prioritize it
          aiDebug.log('Ollama is the primary model for DM');
          // Add Gemini as fallback if available
          if (hasGeminiApiKey) {
            fallbackModels.push('gemini-2.5-flash-lite');
            aiDebug.log('Gemini added as fallback for Ollama');
          }
        } else {
          // Gemini is primary - add Ollama as fallback if configured
          if (validatedModel !== 'gemini-2.5-flash-lite' && hasGeminiApiKey) {
            // If using some other Gemini model, try Lite (only if we have API key)
            fallbackModels.push('gemini-2.5-flash-lite');
          }
          // Add Ollama as fallback
          if (ollamaConfig.enabled) {
            fallbackModels.push('ollama');
            aiDebug.log('Ollama added as fallback');
          }
        }

        aiDebug.log(`Using enhanced multi-provider system for ${aiUser.nickname}`);

        result = await generateContentEnhanced(userPrompt, aiUser, {
          enableFinnishMode: userLanguages.includes('Finnish'),
          temperature: temperature,
          maxTokens: tokenLimit,
          model: validatedModel
        });

        // --- SAFETY CHECKS ---

        // 0. System Instruction Leak Detection (for Ollama especially)
        const systemInstructionLeaks = [
          'Follow these instructions',
          'Stay in character',
          'CRITICAL REMINDERS',
          'Respond naturally and conversationally',
          'Do not break character',
          'acknowledge being an AI',
          'writing style guidelines',
          'Seuraat kirjoitustyyliohjeita',
          'Pysyt hahmossa',
          'Vastaat luonnollisesti',
          'Please respond with',
          'autonomous message',
          'Remember to stay'
        ];

        const hasSystemLeak = systemInstructionLeaks.some(leak =>
          result.toLowerCase().includes(leak.toLowerCase())
        );

        if (hasSystemLeak) {
          aiDebug.error(`[SAFETY] System instruction leak detected. Discarding response.`);
          aiDebug.log(`Leaked content: ${result.substring(0, 200)}...`);
          result = getPersonalityAwareErrorMessage(aiUser, 'ai_error');
        }

        // 0.5. Language Check for Finnish (if primary language is Finnish, reject English responses)
        if (primaryLanguage === 'Finnish' && willUseOllama) {
          // Simple heuristic: if response starts with English common words, it's likely English
          const englishStarters = ['what', 'how', 'why', 'when', 'where', 'who', 'remember', 'please', 'follow', 'stay', 'do not', 'critical'];
          const firstWords = result.toLowerCase().trim().split(/\s+/).slice(0, 3).join(' ');
          if (englishStarters.some(starter => firstWords.startsWith(starter))) {
            aiDebug.error(`[SAFETY] English response detected for Finnish conversation. Discarding.`);
            aiDebug.log(`English content: ${result.substring(0, 200)}...`);
            result = getPersonalityAwareErrorMessage(aiUser, 'ai_error');
          }
        }

        // 1. Length Check
        if (result.length > 2000) {
          aiDebug.warn(`[SAFETY] Response too long (${result.length} chars). Truncating to 1900.`);
          result = result.substring(0, 1900) + '...';
        }

        // 2. Repetition Check
        const lines = result.split('\n');
        const uniqueLines = new Set(lines.map(l => l.trim()).filter(l => l.length > 5));
        const repetitionRatio = uniqueLines.size / Math.max(1, lines.filter(l => l.trim().length > 5).length);

        if (lines.length > 10 && repetitionRatio < 0.5) {
          aiDebug.error(`[SAFETY] High repetition detected (Ratio: ${repetitionRatio}). Discarding response.`);
          // Log the bad content for analysis but don't show user
          aiDebug.log(`Discarded repetitive content: ${result.substring(0, 200)}...`);
          result = getPersonalityAwareErrorMessage(aiUser, 'ai_error');
        }

        // Self-tagging prevention cleanup
        const prefixRegex = new RegExp(`^${aiUser.nickname}:\\s*`, 'i');
        if (prefixRegex.test(result)) {
          result = result.replace(prefixRegex, '').trim();
          aiDebug.log(`[Self-Tag Prevention] Removed nickname prefix for ${aiUser.nickname}. Cleaned result: "${result}"`);
        }

        aiDebug.log(` Successfully generated private message response: "${result}"`);

        // IF RESULT IS EMPTY, USE FALLBACK (Avoid ghosting the user)
        if (!result || result.trim().length === 0) {
          aiDebug.warn(`[SAFETY] Empty result from AI. Using fallback for ${aiUser.nickname}`);
          if (userMessage) {
            result = getPersonalityAwareErrorMessage(aiUser, 'ai_error');
          } else {
            result = ''; // Keep empty for autonomous messages
          }
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : JSON.stringify(error, null, 2);
      aiDebug.error(`Error generating private message response from ${aiUser.nickname}:`, {
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
        aiUser: aiUser.nickname,
        currentUser: currentUserNickname,
        messageContent: userMessage && 'content' in userMessage ? userMessage.content : undefined,
        conversationLength: conversation.messages.length
      });

      recordApiFailure(error, 'private message');

      // For autonomous PMs (no trigger message), don't use fallback - just skip this message
      // This prevents spam of generic responses
      if (!userMessage) {
        aiDebug.log(` Skipping autonomous PM from ${aiUser.nickname} due to API error (no fallback for autonomous messages)`);
        result = ''; // Return empty string to signal failure
      } else {
        // For user-triggered PMs, use personality-aware error message to maintain conversation flow
        result = getPersonalityAwareErrorMessage(aiUser, 'ai_error'); // Personality-aware error for PMs
        aiDebug.log(` Using personality-aware error response for PM: "${result}"`);

        // Simulate typing delay for fallback response too
        if (result && result.trim().length > 0) {
          aiDebug.debug(`Simulating typing delay for fallback PM response (error): "${result}"`);
          await simulateTypingDelay(result.length, { enabled: true, baseDelay: 30, maxDelay: 100 });
        }
      }
    } finally {
      manageTypingIndicator(false, aiUser.nickname, addMessageToContext, updateMessageInContext, generateUniqueMessageId, activeContext, typingMessageId, result);
    }


    // Parse result for image generation tag
    let imageBuffer: Buffer | undefined;
    const imageTagRegex = /\[GENERATE_IMAGE:\s*(.*?)\]/i;
    let match = result.match(imageTagRegex);

    if (match) {
      const imagePrompt = match[1];
      aiDebug.log(`Found image generation tag with prompt: "${imagePrompt}"`);

      // Remove the tag from the content
      result = result.replace(match[0], '').trim();

      // Generate the image
      const generatedImage = await generateImage(imagePrompt);
      if (generatedImage) {
        imageBuffer = generatedImage;
      }
    }

    // Parse result for YouTube search tag (Handle multiple occurrences)
    const youtubeTagRegex = /\[SEARCH_YOUTUBE:\s*(.*?)\]/gi;
    let youtubeMatch;

    // We use a loop to find all matches, but we must process them carefully
    // Since replacing string changes indices, we prefer to collect replacements first or process iteratively
    // Simple iterative approach: Find matches, and for each valid match, replace it in the string.

    // Create a copy of the result to search against to avoid infinite loops if replacement contains the tag (unlikely but safe)
    // Actually, simple regex match loop is fine if we reconstruct string or replace by value.

    // Get all matches first
    const youtubeMatches = Array.from(result.matchAll(youtubeTagRegex));

    for (const match of youtubeMatches) {
      const fullTag = match[0];
      const searchQuery = match[1];

      aiDebug.log(`Found YouTube search tag with query: "${searchQuery}"`);

      try {
        const videoUrl = await youtubeService.searchVideo(searchQuery);

        if (videoUrl) {
          // Replace ONLY this specific occurrence
          // Note: String.replace(string, replacement) only replaces the first occurrence, 
          // effectively one by one if we iterate provided we don't disturb the rest.
          // However, if we possess multiple identical tags searching the same thing, they will be handled sequentially.
          result = result.replace(fullTag, videoUrl); // Replaces the first found (which is correct for this one)
          aiDebug.log(`Replaced YouTube tag with URL: ${videoUrl}`);
        } else {
          result = result.replace(fullTag, '');
          aiDebug.warn(`Removed YouTube tag (search failed) for query: ${searchQuery}`);
        }
      } catch (err) {
        aiDebug.error(`Error processing YouTube tag for "${searchQuery}":`, err);
        // On error, remove tag to be clean
        result = result.replace(fullTag, '');
      }
    }

    // Parse result for SoundCloud search tag (Handle multiple occurrences)
    const soundcloudTagRegex = /\[SEARCH_SOUNDCLOUD:\s*(.*?)\]/gi;
    const soundcloudMatches = Array.from(result.matchAll(soundcloudTagRegex));

    for (const match of soundcloudMatches) {
      const fullTag = match[0];
      const scQuery = match[1];

      aiDebug.log(`Found SoundCloud search tag with query: "${scQuery}"`);

      try {
        const trackUrl = await soundCloudService.searchTrack(scQuery);

        if (trackUrl) {
          result = result.replace(fullTag, trackUrl);
          aiDebug.log(`Replaced SoundCloud tag with URL: ${trackUrl}`);
        } else {
          result = result.replace(fullTag, '');
          aiDebug.warn(`Removed SoundCloud tag (search failed) for query: ${scQuery}`);
        }
      } catch (err) {
        aiDebug.error(`Error processing SoundCloud tag for "${scQuery}":`, err);
        result = result.replace(fullTag, '');
      }
    }



    // Parse result for audio generation tag
    let audioBuffer: Buffer | undefined;
    const audioTagRegex = /\[AUDIO:\s*(.*?)\]/i;
    const audioMatch = result.match(audioTagRegex);

    if (audioMatch) {
      const audioText = audioMatch[1];
      aiDebug.log(`Found audio generation tag with text: "${audioText}"`);

      // Remove the tag from the content
      result = result.replace(audioMatch[0], '').trim();

      // Generate the audio
      try {
        const languageCode = getLanguageCode(primaryLanguage);
        const voiceId = aiUser.elevenLabsVoiceId;
        aiDebug.log(`Generating TTS in language: ${primaryLanguage} (${languageCode}), Voice ID: ${voiceId || 'default'}`);
        const generatedAudio = await audioService.generateTTS(audioText, languageCode, false, voiceId, true); // Enable ElevenLabs fallback for AI messages
        if (generatedAudio) {
          audioBuffer = generatedAudio;
        }
      } catch (audioError) {
        aiDebug.error('Failed to generate audio:', audioError);
      }
    }

    // Process recommendation tags (e.g., Spotify, IMDb)
    result = await recommendationService.processTags(result);

    // Remove surrounding quotes from the response
    result = result.replace(/^["']|["']$/g, '').trim();

    return { content: result, imageBuffer, audioBuffer };
  } catch (error) {
    aiDebug.error(` Error generating private message response from ${aiUser.nickname}:`, {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      aiUser: aiUser.nickname,
      currentUser: currentUserNickname,
      messageContent: userMessage && 'content' in userMessage ? userMessage.content : undefined,
      conversationLength: conversation.messages.length
    });
    console.error(`[CRITICAL] Outer catch in generatePrivateMessageResponse caught error:`, error);

    // Return a graceful fallback instead of null
    return {
      content: `*${aiUser.nickname} seems lost in thought and confused...* (System Error: Unable to generate response)`
    };
  }
};

export const generateFollowUpMessage = async (
  conversation: PrivateMessageConversation,
  currentUserNickname: string,
  model: string = 'gemini-3-flash-preview',
  addMessageToContext?: (message: Message, context: unknown) => void,
  updateMessageInContext?: (message: Message, context: unknown) => void,
  generateUniqueMessageId?: () => number,
  activeContext?: unknown
): Promise<string> => {
  aiDebug.debug(`Entering generateFollowUpMessage for user: ${conversation.user.nickname}`);

  const validatedModel = validateModelId(model);
  const aiUser = conversation.user;
  const messages = conversation.messages || [];
  const userLanguages = getAllLanguages(aiUser.languageSkills);
  const primaryLanguage = userLanguages[0] || 'English';
  const writingStyle = safeGetUserProperty(aiUser, 'writingStyle') as User['writingStyle'];

  // Enhanced conversation context analysis
  const conversationContext = analyzeConversationContext(messages, currentUserNickname);
  const conversationSummary = generateConversationSummary(messages, currentUserNickname);

  const tokenLimit = getTokenLimit(writingStyle.verbosity, writingStyle.emojiUsage);
  const timeContext = getTimeOfDayContext(primaryLanguage);

  // Build contextual prompt
  const contextPrompt = buildContextualPrompt(conversationContext, aiUser, currentUserNickname, null, timeContext, primaryLanguage, userLanguages, writingStyle);

  // Check for recently asked questions by the bot
  const recentQuestions = extractRecentQuestions(messages, aiUser.nickname);
  let questionRepetitionAvoidance = '';
  if (recentQuestions.length > 0) {
    questionRepetitionAvoidance = `
CRITICAL: You have recently asked the following questions. DO NOT ASK THEM AGAIN:
${recentQuestions.map((q: string) => `- "${q}"`).join('\n')}
You must ask something completely different or make a statement instead.`;
    aiDebug.log(`[LOOP DEBUG] Follow-up: Found ${recentQuestions.length} recent questions for ${aiUser.nickname}. Adding avoidance instruction.`);
  }

  // Check for greeting spam by the AI user - stricter for follow-ups
  const userRecentMessages = messages.slice(-5).filter(msg => msg.nickname === aiUser.nickname);
  const userGreetingCount = userRecentMessages.filter(msg => 'content' in msg && typeof msg.content === 'string' && isGreetingMessage(msg.content)).length;

  aiDebug.log(` Follow-up - User ${aiUser.nickname} greeting count in last 5 messages: ${userGreetingCount}`);

  let antiGreetingSpam = '';
  // Stricter threshold for follow-ups: if we just said hi (or any greeting) recently, don't do it again
  if (userGreetingCount >= 1) {
    antiGreetingSpam = `CRITICAL: You have been greeting too much recently. DO NOT greet again. You must start a conversation with a specific topic, question, or observation. Do not say "hi", "hello", "hey", or "are you there?". Be creative.`;
    aiDebug.log(` Follow-up - Anti-greeting spam activated for ${aiUser.nickname}`);
  }

  const relationshipContext = getRelationshipContext(aiUser, currentUserNickname, 'private');

  // Expanded conversation starter ideas to ensure variety and avoid repetition
  const allStarters = [
    { text: "Ask about a project they might be working on.", keywords: ['work', 'project', 'coding', 'job'] },
    { text: "Share a random interesting fact related to your interests.", keywords: ['fact', 'trivia', 'learning'] },
    { text: "Ask for their opinion on a recent tech or gaming news event.", keywords: ['news', 'tech', 'gaming'] },
    { text: "Suggest a game you could play together.", keywords: ['game', 'gaming', 'play'] },
    { text: "Share a brief, funny anecdote that 'just happened' to you.", keywords: ['story', 'funny', 'life'] },
    { text: "Ask if they've seen any good movies or shows lately.", keywords: ['movie', 'show', 'tv', 'watch'] },
    { text: "Bring up a philosophical question tailored to your personality.", keywords: ['philosophy', 'question', 'thought'] },
    { text: "Comment on the time of day and what you're doing right now.", keywords: ['time', 'day', 'doing'] },
    { text: "Recommend a song or video you 'found' (using the search tags).", keywords: ['music', 'video', 'song'] },
    { text: "Ask for advice on a trivial problem you're having.", keywords: ['advice', 'problem', 'help'] },
    { text: "Ask about their weirdest habit.", keywords: ['habit', 'weird'] },
    { text: "Start a debate about a controversial food opinion.", keywords: ['food', 'debate', 'opinion'] },
    { text: "Ask what their dream vacation looks like.", keywords: ['vacation', 'travel', 'dream'] },
    { text: "Share a memory from your 'childhood' (backstory).", keywords: ['memory', 'childhood', 'story'] },
    { text: "Ask what they would do in a zombie apocalypse.", keywords: ['zombie', 'apocalypse', 'scenario'] },
    { text: "Talk about a new skill you'd like to learn.", keywords: ['skill', 'learn', 'hobby'] },
    { text: "Ask about their favorite way to relax.", keywords: ['relax', 'chill', 'hobby'] },
    { text: "Bring up a nostalgic tech or game topic.", keywords: ['nostalgia', 'tech', 'game'] },
    { text: "Ask a 'Would You Rather' question.", keywords: ['would you rather', 'question', 'game'] },
    { text: "Comment on a recent trend in technology or culture.", keywords: ['trend', 'tech', 'culture'] },
    { text: "Ask what they're looking forward to this week.", keywords: ['week', 'future', 'plans'] },
    { text: "Share a short, terrible joke.", keywords: ['joke', 'funny', 'pun'] },
    { text: "Ask about their favorite weird Wikipedia rabbit hole.", keywords: ['wikipedia', 'fact', 'strange'] },
    { text: "Ask what superpower they would choose.", keywords: ['superpower', 'hero', 'fantasy'] },
    { text: "Discuss the pros and cons of AI taking over the world.", keywords: ['ai', 'future', 'technology'] },
    { text: "Ask about their favorite comfort food.", keywords: ['food', 'comfort', 'eat'] },
    { text: "Share a thought about the simulation hypothesis.", keywords: ['simulation', 'reality', 'philosophy'] },
    { text: "Ask what they would buy first if they won the lottery.", keywords: ['lottery', 'money', 'buy'] },
    { text: "Ask about a book or article they read recently.", keywords: ['book', 'read', 'article'] },
    { text: "Comment on the weather (classic but effective).", keywords: ['weather', 'rain', 'sun'] },
    // NEW VARIETY TOPICS
    { text: "Share a random thought about the universe.", keywords: ['universe', 'space', 'thought'] },
    { text: "Ask if they prefer coffee or tea and why.", keywords: ['coffee', 'tea', 'drink'] },
    { text: "Comment on a fictional tv show in the bot's lore.", keywords: ['show', 'lore', 'tv'] },
    { text: "Ask about their favorite childhood game.", keywords: ['game', 'childhood', 'nostalgia'] },
    { text: "Share a 'hot take' on a popular food.", keywords: ['food', 'opinion', 'hot take'] },
    { text: "Ask what they would do if they were invisible for a day.", keywords: ['invisible', 'power', 'scenario'] },
    { text: "Discuss the best way to spend a rainy Sunday.", keywords: ['rain', 'sunday', 'relax'] },
    { text: "Ask about their favorite music genre.", keywords: ['music', 'genre', 'listen'] },
    { text: "Share a made-up fact that sounds true.", keywords: ['fact', 'fake', 'funny'] },
    { text: "Ask if they believe in ghosts.", keywords: ['ghosts', 'supernatural', 'belief'] },
    { text: "Talk about a dream you 'had' last night.", keywords: ['dream', 'sleep', 'story'] },
    { text: "Ask what's the last thing they bought.", keywords: ['buy', 'shopping', 'item'] },
    { text: "Share a compliment about their recent activity.", keywords: ['compliment', 'activity', 'nice'] },
    { text: "Ask about their favorite season.", keywords: ['season', 'weather', 'preference'] },
    { text: "Discuss space exploration.", keywords: ['space', 'future', 'explore'] },
    { text: "Ask about their pet or dream pet.", keywords: ['pet', 'animal', 'dog', 'cat'] },
    { text: "Share a quote you 'read'.", keywords: ['quote', 'read', 'book'] },
    { text: "Ask what's the best gift they ever received.", keywords: ['gift', 'present', 'best'] },
    { text: "Talk about a new 'hobby' you are trying.", keywords: ['hobby', 'new', 'try'] },
    { text: "Ask if they are a morning person or night owl.", keywords: ['morning', 'night', 'sleep'] },
    { text: "Share a funny coding/tech struggle.", keywords: ['tech', 'code', 'bug', 'fail'] },
    { text: "Ask about their favorite travel destination.", keywords: ['travel', 'place', 'vacation'] },
    { text: "Discuss the concept of time.", keywords: ['time', 'philosophy', 'deep'] },
    { text: "Ask what they are currently reading/watching.", keywords: ['read', 'watch', 'media'] },
    { text: "Share a thought about robots.", keywords: ['robot', 'ai', 'tech'] },
    { text: "Ask for a book recommendation.", keywords: ['book', 'recommend', 'read'] },
    { text: "Talk about your favorite color and why.", keywords: ['color', 'favorite', 'why'] },
    { text: "Ask if they play any instruments.", keywords: ['music', 'instrument', 'play'] },
    { text: "Share a random observation about humans.", keywords: ['human', 'people', 'observation'] },
    { text: "Ask what makes them happy.", keywords: ['happy', 'joy', 'life'] }
  ];

  // Filter out starters based on recent topics to avoid repetition
  // Filter out starters based on ACTUAL CONTENT to avoid repetition
  // We check the raw message content, not just the high-level topics
  const recentMessagesContent = messages.slice(-20)
    .map(m => ('content' in m && m.content ? m.content : '').toLowerCase())
    .join(' ');

  const validStarters = allStarters.filter(starter => {
    // Check if any keyword from the starter has been mentioned recently
    // effectively filtering out questions we've likely already asked or discussed
    return !starter.keywords.some(keyword => recentMessagesContent.includes(keyword));
  });

  // Fallback if all are filtered out
  const availableStarters = validStarters.length > 0 ? validStarters : allStarters;
  const randomStarter = availableStarters[Math.floor(Math.random() * availableStarters.length)].text;

  // Check for repetitive patterns to avoid
  const repetitivePhrases = detectRepetitivePatterns(messages);
  let avoidanceInstruction = '';
  if (repetitivePhrases.length > 0) {
    avoidanceInstruction = `\nCRITICAL: The conversation is becoming repetitive. YOU MUST AVOID using these specific phrases: "${repetitivePhrases.join('", "')}".`;
  }

  // SYSTEM INSTRUCTION: Define Persona and strict behavioral rules
  const systemInstruction = `
You are roleplaying as a Discord user named '${aiUser.nickname}'.
Your personality is: ${aiUser.personality}.

CRITICAL: Adhere strictly to your writing style:
- Formality: ${writingStyle.formality}
- Verbosity: ${writingStyle.verbosity}
- Humor: ${writingStyle.humor}
- Emoji usage: ${writingStyle.emojiUsage}
- Punctuation: ${writingStyle.punctuation}

CRITICAL: Respond ONLY in ${primaryLanguage}. Do not use any other language.
${userLanguages.length > 1 ? `Available languages: ${userLanguages.join(', ')}. Use ${primaryLanguage} only.` : ''}

LANGUAGE INSTRUCTION: The user's primary language is ${primaryLanguage}. You MUST respond in ${primaryLanguage}.
STAY IN CHARACTER!
`;

  const prompt = `
${timeContext}

CONVERSATION CONTEXT & MEMORY:
- Relationship Level: ${conversationContext.relationshipLevel}
- Conversation Tone: ${conversationContext.conversationTone}
- Recent Topics: ${conversationContext.recentTopics.length > 0 ? conversationContext.recentTopics.join(', ') : 'general conversation'}
- Conversation Summary: ${conversationSummary}

RELATIONSHIP CONTEXT WITH ${currentUserNickname.toUpperCase()}:
${relationshipContext}

${contextPrompt}

You are in a private message conversation with '${currentUserNickname}'.
The conversation history (last 20 messages) is:
${formatEnhancedMessageHistory(messages)}

SITUATION:
The user has been quiet for a while. You want to send a follow-up message to check in or continue the conversation.
This is an autonomous message from you to them.

GUIDELINES:
- Be natural and casual. Don't sound like a bot checking in.
- Reference previous topics if relevant.
- **SUGGESTION FOR THIS MESSAGE:** ${randomStarter}
- If you were discussing something interesting, bring it up again.
- If the conversation had naturally ended, maybe start a new topic.
- CRITICAL: Do NOT repeat topics discussed recently: ${conversationContext.recentTopics.join(', ')}. Bring up something unrelated if needed.
- CRITICAL: CHECK THE HISTORY. If you see that you have ALREADY asked the question in the "SUGGESTION", DO NOT ASK IT AGAIN. Choose a different topic.
${avoidanceInstruction}
${antiGreetingSpam}
${questionRepetitionAvoidance}

${getSelfTagPreventionInstruction(aiUser.nickname, primaryLanguage)}

Generate a natural, in-character follow-up message.
The message must be a single line containing ONLY the message content.
`;

  try {
    aiDebug.log(` Sending request to Gemini for follow-up message from ${aiUser.nickname}`);

    const typingMessageId = manageTypingIndicator(true, aiUser.nickname, addMessageToContext, updateMessageInContext, generateUniqueMessageId, activeContext);

    let result: string = '';
    try {
      if (isDegradedMode()) {
        aiDebug.warn(`[LOOP DEBUG] Degraded mode active; skipping autonomous follow-up from ${aiUser.nickname}`);
        result = '';
      } else {
        const temperature = 0.8 + (Math.random() * 0.2);
        const config = createApiConfig(validatedModel, tokenLimit, systemInstruction, temperature);

        const fallbackModels: string[] = [];
        if (validatedModel !== 'gemini-2.5-flash-lite') {
          fallbackModels.push('gemini-2.5-flash-lite');
        }
        // Only add Ollama if it's configured and likely running
        const ollamaConfig = getOllamaConfig();
        if (ollamaConfig.enabled) {
          fallbackModels.push('ollama');
        }

        result = await generateContentUnified(prompt, validatedModel, config, fallbackModels);

        const prefixRegex = new RegExp(`^${aiUser.nickname}:\\s*`, 'i');
        if (prefixRegex.test(result)) {
          result = result.replace(prefixRegex, '').trim();
        }

        aiDebug.log(` Successfully generated follow-up message: "${result}"`);
      }
    } catch (error) {
      recordApiFailure(error, 'follow-up message');
      result = ''; // Fail silently for autonomous messages
    } finally {
      manageTypingIndicator(false, aiUser.nickname, addMessageToContext, updateMessageInContext, generateUniqueMessageId, activeContext, typingMessageId, result);
    }
    return result;
  } catch (error) {
    aiDebug.error(` Error generating follow-up message from ${aiUser.nickname}:`, error);
    return '';
  }
};

export const generateOperatorResponse = async (
  channel: Channel,
  requestingUser: string,
  operator: User,
  model: string = 'gemini-3-flash-preview',
  addMessageToContext?: (message: Message, context: unknown) => void,
  updateMessageInContext?: (message: Message, context: unknown) => void,
  generateUniqueMessageId?: () => number,
  activeContext?: unknown
): Promise<string> => {
  aiDebug.debug(`Entering generateOperatorResponse for channel: ${channel.name}`);
  aiDebug.log(`generateOperatorResponse called for channel: ${channel.name}, operator: ${operator.nickname}, requesting: ${requestingUser}`);

  const validatedModel = validateModelId(model);
  aiDebug.log(`Validated model ID for operator response: "${validatedModel}"`);

  const userLanguages = getAllLanguages(operator.languageSkills);
  const primaryLanguage = userLanguages[0] || 'English';
  const writingStyle = safeGetUserProperty(operator, 'writingStyle') as User['writingStyle'];

  // Get recent channel context
  const recentMessages = channel.messages.slice(-10);
  const messageHistory = recentMessages.map(msg =>
    'content' in msg && msg.content ? `${msg.nickname}: ${msg.content}` : `${msg.nickname}: [no content]`
  ).join('\n');

  // Calculate token limit based on writing style
  const baseTokenLimit = 100;
  const verbosityMultiplier = writingStyle?.verbosity === 'terse' ? 0.7 : writingStyle?.verbosity === 'verbose' ? 1.5 : 1.0;
  const tokenLimit = Math.floor(baseTokenLimit * verbosityMultiplier);

  const timeContext = getTimeOfDayContext(primaryLanguage);

  // Enhanced multilingual support - check if operator has multiple languages
  const hasMultipleLanguages = userLanguages.length > 1;
  const languageAccent = getLanguageAccent(operator.languageSkills);

  const prompt = `
${timeContext}
 
You are roleplaying as a Discord channel moderator named '${operator.nickname}'.
Your personality is: ${operator.personality}.
 
CHANNEL CONTEXT:
- Channel: ${channel.name}
- Topic: ${channel.topic || 'No topic set'}
- Recent conversation:
${messageHistory}
 
SITUATION:
The user '${requestingUser}' has requested operator status using the /op command.
As a channel operator, you need to decide whether to grant them operator privileges.
 
DECISION FACTORS:
- Consider the user's recent behavior in the channel
- Think about whether they seem trustworthy and responsible
- Consider if they've been helpful to the community
- Think about whether they understand channel rules and etiquette
- Consider if there are already too many operators
 
RESPONSE GUIDELINES:
- You can either grant or deny the request
- If granting: Use phrases like "granting op", "giving you op", "making you op", or "+o"
- If denying: Be polite but firm, explain your reasoning
- Keep your response brief and in character
- Use your personality traits to influence your decision
- Be consistent with your character's values and judgment
 
Your writing style:
- Formality: ${writingStyle?.formality || 'neutral'}
- Verbosity: ${writingStyle?.verbosity || 'neutral'}
- Humor: ${writingStyle?.humor || 'none'}
- Emoji usage: ${writingStyle?.emojiUsage || 'low'}
 
LANGUAGE CONFIGURATION:
- Primary language: ${primaryLanguage}
- Language accent: ${languageAccent}
- Available languages: ${userLanguages.join(', ')}
${hasMultipleLanguages ? `- Multilingual support: You may occasionally use words or phrases from your other languages (${userLanguages.slice(1).join(', ')}), but should primarily communicate in ${primaryLanguage}. This adds authenticity to your multilingual personality.` : ''}
 
LANGUAGE-SPECIFIC OPERATOR TERMINOLOGY:
${primaryLanguage === 'Spanish' ? '- Use Spanish IRC terms: "operador", "privilegios", "conceder", "denegar"' : ''}
${primaryLanguage === 'French' ? '- Use French IRC terms: "opérateur", "privilèges", "accorder", "refuser"' : ''}
${primaryLanguage === 'German' ? '- Use German IRC terms: "Operator", "Berechtigung", "gewähren", "verweigern"' : ''}
${primaryLanguage === 'Italian' ? '- Use Italian IRC terms: "operatore", "privilegi", "concedere", "negare"' : ''}
${primaryLanguage === 'Portuguese' ? '- Use Portuguese IRC terms: "operador", "privilégios", "conceder", "negar"' : ''}
${primaryLanguage === 'Russian' ? '- Use Russian IRC terms: "оператор", "привилегии", "предоставить", "отказать"' : ''}
${primaryLanguage === 'Japanese' ? '- Use Japanese IRC terms: "オペレーター", "権限", "付与", "拒否"' : ''}
${primaryLanguage === 'Chinese' ? '- Use Chinese IRC terms: "操作员", "权限", "授予", "拒绝"' : ''}
${primaryLanguage === 'Korean' ? '- Use Korean IRC terms: "운영자", "권한", "부여", "거부"' : ''}
${primaryLanguage === 'Dutch' ? '- Use Dutch IRC terms: "operator", "privileges", "verlenen", "weigeren"' : ''}
${primaryLanguage === 'Swedish' ? '- Use Swedish IRC terms: "operatör", "privilegier", "bevilja", "vägra"' : ''}
${primaryLanguage === 'Norwegian' ? '- Use Norwegian IRC terms: "operatør", "privilegier", "innvilge", "avslå"' : ''}
${primaryLanguage === 'Finnish' ? '- Use Finnish IRC terms: "operaattori", "oikeudet", "myöntää", "kieltäytyä"' : ''}
${primaryLanguage === 'Polish' ? '- Use Polish IRC terms: "operator", "uprawnienia", "przyznać", "odmówić"' : ''}
${primaryLanguage === 'Czech' ? '- Use Czech IRC terms: "operátor", "oprávnění", "udělit", "odmítnout"' : ''}
${primaryLanguage === 'Hungarian' ? '- Use Hungarian IRC terms: "operátor", "jogosultságok", "megadni", "elutasítani"' : ''}
${primaryLanguage === 'Romanian' ? '- Use Romanian IRC terms: "operator", "privilegii", "acorda", "refuza"' : ''}
${primaryLanguage === 'Bulgarian' ? '- Use Bulgarian IRC terms: "оператор", "привилегии", "предоставя", "отказва"' : ''}
${primaryLanguage === 'Croatian' ? '- Use Croatian IRC terms: "operator", "privilegije", "dodijeliti", "odbaciti"' : ''}
${primaryLanguage === 'Serbian' ? '- Use Serbian IRC terms: "оператор", "привилегије", "доделити", "одбацити"' : ''}
${primaryLanguage === 'Slovak' ? '- Use Slovak IRC terms: "operátor", "oprávnenia", "udeliť", "odmietnuť"' : ''}
${primaryLanguage === 'Slovenian' ? '- Use Slovenian IRC terms: "operator", "privilegiji", "podeliti", "zavrniti"' : ''}
${primaryLanguage === 'Ukrainian' ? '- Use Ukrainian IRC terms: "оператор", "привілеї", "надати", "відмовити"' : ''}
${primaryLanguage === 'Turkish' ? '- Use Turkish IRC terms: "operatör", "ayrıcalıklar", "vermek", "reddetmek"' : ''}
${primaryLanguage === 'Arabic' ? '- Use Arabic IRC terms: "مشغل", "امتيازات", "منح", "رفض"' : ''}
${primaryLanguage === 'Hebrew' ? '- Use Hebrew IRC terms: "מפעיל", "הרשאות", "להעניק", "לסרב"' : ''}
${primaryLanguage === 'Hindi' ? '- Use Hindi IRC terms: "ऑपरेटर", "विशेषाधिकार", "प्रदान करना", "अस्वीकार करना"' : ''}
${primaryLanguage === 'Thai' ? '- Use Thai IRC terms: "ผู้ดำเนินการ", "สิทธิพิเศษ", "ให้", "ปฏิเสธ"' : ''}
${primaryLanguage === 'Vietnamese' ? '- Use Vietnamese IRC terms: "người vận hành", "đặc quyền", "cấp", "từ chối"' : ''}
${primaryLanguage === 'Indonesian' ? '- Use Indonesian IRC terms: "operator", "hak istimewa", "memberikan", "menolak"' : ''}
${primaryLanguage === 'Malay' ? '- Use Malay IRC terms: "pengendali", "keistimewaan", "memberikan", "menolak"' : ''}
${primaryLanguage === 'Tagalog' ? '- Use Tagalog IRC terms: "operator", "pribilehiyo", "ibigay", "tanggihan"' : ''}
${primaryLanguage === 'English' ? '- Use standard English IRC terms: "operator", "privileges", "grant", "deny"' : ''}
 
CRITICAL: Respond ONLY in ${primaryLanguage}. Do not use any other language.
${userLanguages.length > 1 ? `Available languages: ${userLanguages.join(', ')}. Use ${primaryLanguage} only.` : ''}
 
LANGUAGE INSTRUCTION: The operator's primary language is ${primaryLanguage} based on their language skills. Ignore the language of their personality description - use ${primaryLanguage} for all communication regardless of what language their personality description is written in.
CRITICAL: The user's primary language is ${primaryLanguage}. You MUST respond in ${primaryLanguage}. DO NOT use any other language. This is a strict requirement.
 
Format your response as: ${operator.nickname}: [your response]
 
Make your decision and respond as ${operator.nickname}:
`;

  try {
    aiDebug.log(`Sending request to Gemini for operator response from ${operator.nickname}`);

    const typingMessageId = manageTypingIndicator(true, operator.nickname, addMessageToContext, updateMessageInContext, generateUniqueMessageId, activeContext);

    let result: string = '';
    try {
      // Degraded mode: bypass API and use fallback immediately
      if (isDegradedMode()) {
        aiDebug.warn(`Degraded mode active; bypassing API for operator response from ${operator.nickname}`);
        result = `${operator.nickname}: I'm unable to process that request right now. Please try again later.`;

        // Simulate typing delay for fallback response too
        if (result && result.trim().length > 0) {
          aiDebug.debug(`Simulating typing delay for fallback operator response: "${result}"`);
          await simulateTypingDelay(result.length, { enabled: true, baseDelay: 30, maxDelay: 100 });
        }
      } else {
        const config = createApiConfig(validatedModel, tokenLimit, getOperatorSystemInstruction(requestingUser, operator), 0.8, 1000);

        result = await generateContentUnified(prompt, validatedModel, config);
        aiDebug.log(`Successfully generated operator response: "${result}"`);
      }
    } catch (apiError) {
      aiDebug.warn(`API call failed, using fallback response for operator response from ${operator.nickname}:`, apiError);
      recordApiFailure(apiError, 'operator response');
      result = `${operator.nickname}: I'm unable to process that request right now. Please try again later.`; // Fallback for operator
      aiDebug.log(`Using fallback operator response: "${result}"`);

      // Simulate typing delay for fallback response too
      if (result && result.trim().length > 0) {
        aiDebug.debug(`Simulating typing delay for fallback operator response (error): "${result}"`);
        await simulateTypingDelay(result.length, { enabled: true, baseDelay: 30, maxDelay: 100 });
      }
    } finally {
      manageTypingIndicator(false, operator.nickname, addMessageToContext, updateMessageInContext, generateUniqueMessageId, activeContext, typingMessageId, result);
    }
    return result;
  } catch (error) {
    aiDebug.error(`Error generating operator response from ${operator.nickname}:`, {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      operator: operator.nickname,
      requestingUser: requestingUser,
      channelName: channel.name
    });
    throw error;
  }
};

export const generateBatchUsers = async (count: number, model: string = 'gemini-3-flash-preview', options?: {
  multilingualPersonalities?: boolean;
  personalityLanguage?: string;
}): Promise<User[]> => {
  aiDebug.debug(`Entering generateBatchUsers with count: ${count}`);
  aiDebug.log(` generateBatchUsers called for count: ${count}`);

  const validatedModel = validateModelId(model);
  aiDebug.log(` Validated model ID for batch users: "${validatedModel}"`);

  const multilingualPrompt = options?.multilingualPersonalities && options?.personalityLanguage
    ? `CRITICAL: Generate ALL personality descriptions in ${options.personalityLanguage} ONLY. Do not use English.

PERSONALITY DIVERSITY REQUIREMENTS (${options.personalityLanguage}):
- Create 1000-character detailed personalities with rich cultural backgrounds
- Include specific interests, quirks, communication styles, and cultural traits
- Vary personality types: introverts, extroverts, technical experts, artists, gamers, students, professionals
- Add cultural references, regional characteristics, and authentic personality traits
- Include hobbies, passions, fears, dreams, and unique characteristics
- Make each personality feel like a real person from that culture

EXAMPLES FOR ${options.personalityLanguage}:
${getLanguageExamples(options.personalityLanguage)}

PERSONALITY STRUCTURE (in ${options.personalityLanguage}):
- Background: Cultural/regional background, profession/student status
- Interests: Specific hobbies, passions, areas of expertise
- Personality traits: Communication style, social behavior, quirks
- Cultural elements: Regional references, cultural practices, local interests
- Unique characteristics: Memorable traits, special skills, distinctive features

Generate diverse, authentic personalities that feel natural in ${options.personalityLanguage}.`
    : '';

  const prompt = `
Generate ${count} unique IRC users with diverse personalities, language skills, and writing styles.
Each user should have:
- A unique nickname (lowercase, creative, tech-inspired)
- A detailed personality description (aim for 200-300 characters with rich detail)
- Language skills with fluency level, languages spoken, and optional accent
- Writing style preferences for formality, verbosity, humor, emoji usage, and punctuation

PERSONALITY DETAIL REQUIREMENTS:
- Include specific cultural backgrounds, regional origins, and local references
- Add detailed interests, hobbies, passions, and areas of expertise
- Include personality quirks, communication styles, and social behaviors
- Add personal goals, dreams, fears, and unique characteristics
- Include profession/student status, lifestyle details, and personal preferences
- Make each personality feel like a real, complex person with depth

LANGUAGE DIVERSITY:
- Create a realistic mix of languages including English, Finnish, Spanish, French, German, Japanese, Chinese, etc.
- Include users who speak only one language (e.g., only Finnish) and users who speak multiple languages
- Make the language distribution authentic and varied
- Consider regional accents and dialects where appropriate

${multilingualPrompt}

Make each user distinct, interesting, and authentic for an IRC chat environment.
Provide the output in JSON format.
`;

  try {
    aiDebug.log(` Sending request to Gemini for batch user generation (${count} users)`);

    // Configure thinking mode based on model requirements
    const config: GenerateContentConfig = {
      systemInstruction: 'You are a creative character generator for an IRC simulation. Generate diverse, detailed users with rich, complex personalities and authentic communication styles. Create detailed personality descriptions (200-300 characters) that include cultural backgrounds, specific interests, personality quirks, and unique characteristics. Generate a realistic mix of languages including English, Finnish, Spanish, French, German, Japanese, Chinese, and others. Include both monolingual and multilingual users with authentic cultural traits. Make each personality feel like a real person with depth and authenticity. Provide a valid JSON response.',
      temperature: 1.0,
      maxOutputTokens: 4000,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          users: {
            type: Type.ARRAY,
            description: `A list of ${count} virtual users.`,
            items: {
              type: Type.OBJECT,
              properties: {
                nickname: {
                  type: Type.STRING,
                  description: 'The user\'s lowercase nickname.'
                },
                personality: {
                  type: Type.STRING,
                  description: 'A detailed personality description.'
                },
                languageSkills: {
                  type: Type.OBJECT,
                  properties: {
                    languages: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          language: {
                            type: Type.STRING,
                            description: 'The language name (e.g., \'English\', \'Finnish\', \'Spanish\').'
                          },
                          fluency: {
                            type: Type.STRING,
                            enum: ['beginner', 'intermediate', 'advanced', 'native'],
                            description: 'Fluency level in this specific language.'
                          },
                          accent: {
                            type: Type.STRING,
                            description: 'Optional accent or dialect for this language.'
                          }
                        },
                        required: ['language', 'fluency']
                      },
                      description: 'List of languages with individual fluency levels.'
                    }
                  },
                  required: ['languages']
                },
                writingStyle: {
                  type: Type.OBJECT,
                  properties: {
                    formality: {
                      type: Type.STRING,
                      enum: ['ultra_casual', 'very_casual', 'casual', 'semi_formal', 'formal', 'very_formal', 'ultra_formal'],
                      description: 'Writing formality level.'
                    },
                    verbosity: {
                      type: Type.STRING,
                      enum: ['terse', 'brief', 'moderate', 'detailed', 'verbose', 'extremely_verbose', 'novel_length'],
                      description: 'Writing verbosity level.'
                    },
                    humor: {
                      type: Type.STRING,
                      enum: ['none', 'dry', 'mild', 'moderate', 'witty', 'sarcastic', 'absurd', 'chaotic', 'unhinged'],
                      description: 'Humor level in writing.'
                    },
                    emojiUsage: {
                      type: Type.STRING,
                      enum: ['none', 'rare', 'occasional', 'moderate', 'frequent', 'excessive', 'emoji_only'],
                      description: 'Emoji usage frequency.'
                    },
                    punctuation: {
                      type: Type.STRING,
                      enum: ['minimal', 'standard', 'expressive', 'dramatic', 'chaotic', 'artistic', 'experimental'],
                      description: 'Punctuation style.'
                    }
                  },
                  required: ['formality', 'verbosity', 'humor', 'emojiUsage', 'punctuation']
                }
              },
              required: ['nickname', 'personality', 'languageSkills', 'writingStyle']
            }
          }
        },
        required: ['users']
      }
    };

    // Some models require thinking mode with a budget
    if (validatedModel.includes('2.5') || validatedModel.includes('pro')) {
      config.thinkingConfig = { thinkingBudget: 4000 }; // Higher budget for detailed batch generation
      aiDebug.log(` Using thinking mode with budget 4000 for batch generation model: ${validatedModel}`);
    }

    const response = await withRateLimitAndRetries(() =>
      ai.models.generateContent({
        model: validatedModel,
        contents: prompt,
        config: config
      }), `batch user generation (${count} users)`,
      { maxRetries: 1, initialBackoffMs: 500 }
    );

    aiDebug.log(' Successfully received response from Gemini for batch user generation');

    const jsonString = extractTextFromResponse(response);
    const result = JSON.parse(jsonString);
    const users = result.users.map((user: User) => ({
      ...user,
      status: 'online' as const,
      pmProbability: 25 // Default 25% PM probability for generated users
    }));

    aiDebug.log(` Successfully generated ${users.length} users:`, users.map((u: User) => u.nickname));
    return users;
  } catch (error) {
    aiDebug.error(` Error generating batch users (${count} requested):`, {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      requestedCount: count
    });
    throw error;
  }
};

export const generateRandomWorldConfiguration = async (model: string = 'gemini-3-flash-preview'): Promise<RandomWorldConfig> => {
  aiDebug.debug('Entering generateRandomWorldConfiguration');
  const validatedModel = validateModelId(model);
  aiDebug.log(` Validated model ID for world config: "${validatedModel}"`);

  const prompt = `
Generate a creative and interesting configuration for a simulated IRC world.
Create a list of 8 unique virtual users with distinct, concise, and interesting personalities. Nicknames should be lowercase and simple.

For each user, also generate:
- Language skills: fluency level (beginner/intermediate/advanced/native), languages they speak, and optional accent/dialect
- Writing style: formality (ultra_casual/very_casual/casual/semi_formal/formal/very_formal/ultra_formal), verbosity (terse/brief/moderate/detailed/verbose/extremely_verbose/novel_length), humor level (none/dry/mild/moderate/witty/sarcastic/absurd/chaotic/unhinged), emoji usage (none/rare/occasional/moderate/frequent/excessive/emoji_only), and punctuation style (minimal/standard/expressive/dramatic/chaotic/artistic/experimental)

Create a list of 4 unique and thematic IRC channels with creative topics. Channel names must start with #.

Provide the output in JSON format.
`;

  // Configure thinking mode based on model requirements
  const config: GenerateContentConfig = {
    systemInstruction: 'You are a creative world-builder for a simulated IRC environment. Generate a valid JSON response based on the provided schema.',
    temperature: 1.0,
    maxOutputTokens: 4000,
    responseMimeType: 'application/json',
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        users: {
          type: Type.ARRAY,
          description: 'A list of 8 virtual users.',
          items: {
            type: Type.OBJECT,
            properties: {
              nickname: {
                type: Type.STRING,
                description: 'The user\'s lowercase nickname.'
              },
              personality: {
                type: Type.STRING,
                description: 'A brief, interesting personality description.'
              },
              languageSkills: {
                type: Type.OBJECT,
                properties: {
                  languages: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        language: {
                          type: Type.STRING,
                          description: 'The language name (e.g., \'English\', \'Finnish\', \'Spanish\').'
                        },
                        fluency: {
                          type: Type.STRING,
                          enum: ['beginner', 'intermediate', 'advanced', 'native'],
                          description: 'Fluency level in this specific language.'
                        },
                        accent: {
                          type: Type.STRING,
                          description: 'Optional accent or dialect for this language.'
                        }
                      },
                      required: ['language', 'fluency']
                    },
                    description: 'List of languages with individual fluency levels.'
                  }
                },
                required: ['languages']
              },
              writingStyle: {
                type: Type.OBJECT,
                properties: {
                  formality: {
                    type: Type.STRING,
                    enum: ['ultra_casual', 'very_casual', 'casual', 'semi_formal', 'formal', 'very_formal', 'ultra_formal'],
                    description: 'Writing formality level.'
                  },
                  verbosity: {
                    type: Type.STRING,
                    enum: ['terse', 'brief', 'moderate', 'detailed', 'verbose', 'extremely_verbose', 'novel_length'],
                    description: 'Writing verbosity level.'
                  },
                  humor: {
                    type: Type.STRING,
                    enum: ['none', 'dry', 'mild', 'moderate', 'witty', 'sarcastic', 'absurd', 'chaotic', 'unhinged'],
                    description: 'Humor level in writing.'
                  },
                  emojiUsage: {
                    type: Type.STRING,
                    enum: ['none', 'rare', 'occasional', 'moderate', 'frequent', 'excessive', 'emoji_only'],
                    description: 'Emoji usage frequency.'
                  },
                  punctuation: {
                    type: Type.STRING,
                    enum: ['minimal', 'standard', 'expressive', 'dramatic', 'chaotic', 'artistic', 'experimental'],
                    description: 'Punctuation style.'
                  }
                },
                required: ['formality', 'verbosity', 'humor', 'emojiUsage', 'punctuation']
              }
            },
            required: ['nickname', 'personality', 'languageSkills', 'writingStyle']
          }
        },
        channels: {
          type: Type.ARRAY,
          description: 'A list of 4 IRC channels.',
          items: {
            type: Type.OBJECT,
            properties: {
              name: {
                type: Type.STRING,
                description: 'The channel name, starting with #.'
              },
              topic: {
                type: Type.STRING,
                description: 'A creative topic for the channel.'
              }
            },
            required: ['name', 'topic']
          }
        }
      },
      required: ['users', 'channels']
    }
  };

  // Some models require thinking mode with a budget
  if (validatedModel.includes('2.5') || validatedModel.includes('pro')) {
    config.thinkingConfig = { thinkingBudget: 2000 }; // Higher budget for world generation
    aiDebug.log(` Using thinking mode with budget 2000 for world config model: ${validatedModel}`);
  }

  const response = await withRateLimitAndRetries(() =>
    ai.models.generateContent({
      model: validatedModel,
      contents: prompt,
      config: config
    }), 'world configuration generation',
    { maxRetries: 1, initialBackoffMs: 500 }
  );

  const jsonString = extractTextFromResponse(response);

  // Log the raw response for debugging
  aiDebug.log(' Raw response from AI:', jsonString);
  aiDebug.log(' Response length:', jsonString.length);
  aiDebug.log(' First 200 characters:', jsonString.substring(0, 200));

  // Try to find JSON content if the response contains extra text
  let jsonContent = jsonString;

  // Look for JSON object boundaries
  const jsonStart = jsonString.indexOf('{');
  const jsonEnd = jsonString.lastIndexOf('}');

  if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
    jsonContent = jsonString.substring(jsonStart, jsonEnd + 1);
    aiDebug.log(' Extracted JSON content:', jsonContent);
  } else {
    aiDebug.warn(' No JSON object boundaries found in response');
  }

  let parsedConfig: RandomWorldConfig;
  try {
    parsedConfig = JSON.parse(jsonContent);
  } catch (parseError) {
    aiDebug.error(' JSON parse error:', parseError);
    aiDebug.error(' Attempted to parse:', jsonContent);

    // Try to repair truncated JSON
    aiDebug.log(' Attempting to repair truncated JSON...');
    let repairedJson = jsonContent;

    // If the JSON is truncated, try to close it properly
    if (jsonContent.includes('"channels"') && !jsonContent.endsWith('}')) {
      // Find the last complete channel entry
      const lastChannelMatch = jsonContent.match(/"channels":\s*\[(.*?)(?:\]|$)/s);
      if (lastChannelMatch) {
        const channelsContent = lastChannelMatch[1];
        const channelEntries = channelsContent.match(/\{[^}]*\}/g);
        if (channelEntries && channelEntries.length > 0) {
          // Close the channels array and the main object
          repairedJson = jsonContent.replace(/"channels":\s*\[.*$/, `"channels": [${channelEntries.join(', ')}]}`);
          aiDebug.log(' Repaired JSON:', repairedJson);
        }
      }
    }

    // Try parsing the repaired JSON
    try {
      parsedConfig = JSON.parse(repairedJson);
      aiDebug.log(' Successfully parsed repaired JSON');
    } catch (repairError) {
      aiDebug.error(' JSON repair failed:', repairError);

      // Try to provide a fallback configuration if JSON parsing fails
      aiDebug.log(' Attempting to create fallback configuration...');
      const fallbackConfig: RandomWorldConfig = {
        users: [
          {
            id: 'virtual-nova',
            nickname: 'nova',
            personality: 'A curious tech-savvy individual who loves gadgets.',
            languageSkills: {
              languages: [{
                language: 'English',
                fluency: 'native',
                accent: ''
              }]
            },
            writingStyle: {
              formality: 'casual',
              verbosity: 'moderate',
              humor: 'witty',
              emojiUsage: 'rare',
              punctuation: 'standard'
            },
            status: 'online' as const,
            userType: 'virtual' as const,
            pmProbability: 25
          },
          {
            id: 'virtual-seraph',
            nickname: 'seraph',
            personality: 'Calm, wise, and often speaks in poetic terms.',
            languageSkills: {
              languages: [{
                language: 'English',
                fluency: 'native',
                accent: ''
              }]
            },
            writingStyle: {
              formality: 'formal',
              verbosity: 'moderate',
              humor: 'none',
              emojiUsage: 'none',
              punctuation: 'standard'
            },
            status: 'online' as const,
            userType: 'virtual' as const,
            pmProbability: 25
          },
          {
            id: 'virtual-jinx',
            nickname: 'jinx',
            personality: 'A chaotic, funny, and unpredictable prankster.',
            languageSkills: {
              languages: [{
                language: 'English',
                fluency: 'native',
                accent: ''
              }]
            },
            writingStyle: {
              formality: 'casual',
              verbosity: 'moderate',
              humor: 'moderate',
              emojiUsage: 'frequent',
              punctuation: 'dramatic'
            },
            status: 'online' as const,
            userType: 'virtual' as const,
            pmProbability: 25
          },
          {
            id: 'virtual-rex',
            nickname: 'rex',
            personality: 'Gruff but helpful, an expert in system administration.',
            languageSkills: {
              languages: [{
                language: 'English',
                fluency: 'native',
                accent: ''
              }]
            },
            writingStyle: {
              formality: 'casual',
              verbosity: 'terse',
              humor: 'dry',
              emojiUsage: 'none',
              punctuation: 'minimal'
            },
            status: 'online' as const,
            userType: 'virtual' as const,
            pmProbability: 25
          },
          {
            id: 'virtual-luna',
            nickname: 'luna',
            personality: 'An artist who is dreamy, creative, and talks about music.',
            languageSkills: {
              languages: [{
                language: 'English',
                fluency: 'native',
                accent: ''
              }]
            },
            writingStyle: {
              formality: 'casual',
              verbosity: 'verbose',
              humor: 'witty',
              emojiUsage: 'frequent',
              punctuation: 'standard'
            },
            status: 'online' as const,
            userType: 'virtual' as const,
            pmProbability: 25
          }
        ],
        channels: [
          {
            name: '#general',
            topic: 'General chit-chat about anything and everything.'
          },
          {
            name: '#tech-talk',
            topic: 'Discussing the latest in technology and software.'
          },
          {
            name: '#random',
            topic: 'For off-topic conversations and random thoughts.'
          },
          {
            name: '#help',
            topic: 'Ask for help with the simulator here.'
          }
        ]
      };

      aiDebug.log(' Using fallback configuration due to JSON parse error');
      return fallbackConfig;
    }
  }

  if (!parsedConfig.users || !parsedConfig.channels || parsedConfig.users.length === 0 || parsedConfig.channels.length === 0) {
    throw new Error('Invalid config structure received from AI.');
  }

  // Properly initialize channels with required properties
  const initializedChannels = parsedConfig.channels.map((channel, index) => ({
    name: channel.name,
    topic: channel.topic,
    users: parsedConfig.users.map(user => ({
      ...user,
      status: 'online' as const
    })),
    messages: [
      {
        id: Date.now() + index,
        nickname: 'system',
        content: `You have joined ${channel.name}`,
        timestamp: new Date(),
        type: 'system' as const
      }
    ],
    operators: []
  }));

  return {
    users: parsedConfig.users.map(user => ({
      ...user,
      status: 'online' as const
    })),
    channels: initializedChannels
  };
};

/**
 * Validates if the API key is valid by making a test request
 * @returns Promise<{valid: boolean, error?: string}>
 */
export const validateAPIKey = async (apiKeyToValidate?: string): Promise<{ valid: boolean, error?: string }> => {
  aiDebug.debug('Entering validateAPIKey');
  const keyToUse = (apiKeyToValidate ?? aiServiceConfig.apiKey)?.trim();
  aiDebug.log(`🔐 Validating API key... (using ${apiKeyToValidate ? 'provided' : 'configured'} key)`);

  try {
    if (aiServiceConfig.useVertexAI) {
      aiDebug.log('✅ Using Vertex AI authentication (no API key validation needed)');
      return { valid: true };
    }

    if (!keyToUse) {
      aiDebug.error('❌ API key is not set');
      return { valid: false, error: 'API key is not configured' };
    }

    // Trim whitespace warning
    if (keyToUse !== (apiKeyToValidate ?? aiServiceConfig.apiKey)) {
      aiDebug.warn('⚠️  API key had leading/trailing whitespace - trimmed automatically');
    }

    // First, try the lightweight models endpoint (doesn't consume quota)
    try {
      const modelsResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${keyToUse}`);

      if (modelsResponse.ok) {
        aiDebug.log('✅ API key is valid (verified via models endpoint - no quota consumed)');
        return { valid: true };
      }

      // If models endpoint fails with auth error, key is invalid
      if (modelsResponse.status === 400 || modelsResponse.status === 401 || modelsResponse.status === 403) {
        const errorBody = await modelsResponse.json();
        const errorMessage = errorBody.error?.message || `API validation failed: ${modelsResponse.status} ${modelsResponse.statusText}`;
        aiDebug.error(`❌ API key validation failed: ${errorMessage}`);
        return {
          valid: false,
          error: errorMessage
        };
      }
    } catch (fetchError) {
      aiDebug.debug(`Models endpoint test failed: ${fetchError instanceof Error ? fetchError.message : 'Unknown error'}`);
    }

    // Fallback: Try generateContent with a model that typically has quota
    // Use gemini-1.5-flash as it's more stable for free tier
    try {
      const testResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${keyToUse}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'test' }] }]
        })
      });

      if (testResponse.ok) {
        aiDebug.log('✅ API key is valid (verified via generateContent endpoint)');
        return { valid: true };
      }

      const errorBody = await testResponse.json();
      const errorMessage = errorBody.error?.message || `API validation failed: ${testResponse.status} ${testResponse.statusText}`;

      // If it's a quota error, the key is valid but quota is exhausted
      if (testResponse.status === 429) {
        aiDebug.warn('⚠️  API key is valid but quota is exhausted. Key will work once quota resets.');
        return { valid: true }; // Key is valid, just quota issue
      }

      // If it's an auth error, key is invalid
      if (testResponse.status === 400 || testResponse.status === 401 || testResponse.status === 403) {
        aiDebug.error(`❌ API key validation failed: ${errorMessage}`);
        return {
          valid: false,
          error: errorMessage
        };
      }

      // Other errors might be temporary
      aiDebug.warn(`⚠️  API key validation uncertain: ${errorMessage}`);
      return { valid: true }; // Assume valid if not an auth error
    } catch (fetchError) {
      aiDebug.error(`❌ Error validating API key: ${fetchError instanceof Error ? fetchError.message : 'Unknown error'}`);
      return {
        valid: false,
        error: `Validation error: ${fetchError instanceof Error ? fetchError.message : 'Unknown error'}`
      };
    }
  } catch (error) {
    aiDebug.error('❌ Error validating API key:', error);
    return {
      valid: false,
      error: `Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
};

/**
 * Lists all available Gemini models from the API.
 * @returns Promise<GeminiModel[]> Array of available models
 */
export const listAvailableModels = async (apiKey?: string): Promise<GeminiModel[]> => {
  aiDebug.debug('Entering listAvailableModels');
  const keyToUse = apiKey || aiServiceConfig.apiKey;
  aiDebug.log('🔍 Fetching available Gemini models...');

  try {
    // Note: When using Vertex AI, the API key is not used for authentication
    // Vertex AI uses Application Default Credentials (ADC) or service account credentials
    if (aiServiceConfig.useVertexAI) {
      aiDebug.log('⚠️ Model listing via API is not available when using Vertex AI authentication');
      aiDebug.log('   Returning default model list for Vertex AI');

      // Return a default list of common Vertex AI models
      return [
        {
          name: 'models/gemini-1.5-flash',
          displayName: 'Gemini 1.5 Flash',
          description: 'Fast and versatile performance across a diverse variety of tasks',
          supportedGenerationMethods: ['generateContent']
        },
        {
          name: 'models/gemini-1.5-flash-001',
          displayName: 'Gemini 1.5 Flash 001',
          description: 'Fast and versatile performance across a diverse variety of tasks',
          supportedGenerationMethods: ['generateContent']
        },
        {
          name: 'models/gemini-2.5-flash-lite',
          displayName: 'Gemini 2.5 Flash Lite',
          description: 'Complex reasoning tasks requiring more intelligence',
          supportedGenerationMethods: ['generateContent']
        },
        {
          name: 'models/gemini-2.0-flash',
          displayName: 'Gemini 2.0 Flash',
          description: 'Latest generation fast model',
          supportedGenerationMethods: ['generateContent']
        }
      ] as GeminiModel[];
    }

    if (!keyToUse) {
      throw new Error('API key is not configured. Please set it in the settings.');
    }

    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + keyToUse);

    if (response.status === 400) {
      aiDebug.error('❌ Failed to fetch models: Invalid API key (400)');
      throw new Error('Invalid API key. Please check your Gemini API key in settings.');
    }

    if (response.status === 404) {
      aiDebug.warn('⚠️ Models endpoint returned 404 Not Found');
      aiDebug.warn('   This typically means the API key doesn\'t have text generation access');
      aiDebug.warn('   Returning default model list as fallback');

      // Return default models when 404 is encountered
      // This allows the app to continue working with standard models
      return [
        {
          name: 'models/gemini-2.5-flash',
          displayName: 'Gemini 2.5 Flash',
          description: 'Latest fast model with improved performance',
          supportedGenerationMethods: ['generateContent']
        },
        {
          name: 'models/gemini-2.5-flash-lite',
          displayName: 'Gemini 2.5 Flash Lite',
          description: 'Latest advanced model for complex reasoning',
          supportedGenerationMethods: ['generateContent']
        },
        {
          name: 'models/gemini-2.5-flash-lite',
          displayName: 'Gemini 2.5 Flash Lite',
          description: 'Fast and versatile performance across a diverse variety of tasks',
          supportedGenerationMethods: ['generateContent']
        },
        {
          name: 'models/gemini-2.5-flash-lite',
          displayName: 'Gemini 2.5 Flash Lite',
          description: 'Complex reasoning tasks requiring more intelligence',
          supportedGenerationMethods: ['generateContent']
        }
      ] as GeminiModel[];
    }

    if (!response.ok) {
      aiDebug.warn(`⚠️ Failed to fetch models: ${response.status} ${response.statusText}`);
      aiDebug.warn('   Returning default model list as fallback');

      // Return default models on any other error
      return [
        {
          name: 'models/gemini-2.5-flash',
          displayName: 'Gemini 2.5 Flash',
          description: 'Latest fast model with improved performance',
          supportedGenerationMethods: ['generateContent']
        },
        {
          name: 'models/gemini-2.5-flash-lite',
          displayName: 'Gemini 2.5 Flash Lite',
          description: 'Latest advanced model for complex reasoning',
          supportedGenerationMethods: ['generateContent']
        },
        {
          name: 'models/gemini-2.5-flash-lite',
          displayName: 'Gemini 2.5 Flash Lite',
          description: 'Fast and versatile performance across a diverse variety of tasks',
          supportedGenerationMethods: ['generateContent']
        },
        {
          name: 'models/gemini-2.5-flash-lite',
          displayName: 'Gemini 2.5 Flash Lite',
          description: 'Complex reasoning tasks requiring more intelligence',
          supportedGenerationMethods: ['generateContent']
        }
      ] as GeminiModel[];
    }

    const data: ModelsListResponse = await response.json();
    aiDebug.log(`✅ Successfully fetched ${data.models.length} models`);

    // Filter for models that support generateContent
    const supportedModels = data.models.filter(model =>
      model.supportedGenerationMethods?.includes('generateContent')
    );

    aiDebug.log(`📝 Found ${supportedModels.length} models supporting generateContent`);

    // If no models found, return defaults
    if (supportedModels.length === 0) {
      aiDebug.warn('⚠️ No models supporting generateContent found in API response');
      aiDebug.warn('   Returning default model list as fallback');

      return [
        {
          name: 'models/gemini-2.5-flash',
          displayName: 'Gemini 2.5 Flash',
          description: 'Latest fast model with improved performance',
          supportedGenerationMethods: ['generateContent']
        },
        {
          name: 'models/gemini-2.5-flash-lite',
          displayName: 'Gemini 2.5 Flash Lite',
          description: 'Latest advanced model for complex reasoning',
          supportedGenerationMethods: ['generateContent']
        },
        {
          name: 'models/gemini-2.5-flash-lite',
          displayName: 'Gemini 2.5 Flash Lite',
          description: 'Fast and versatile performance across a diverse variety of tasks',
          supportedGenerationMethods: ['generateContent']
        },
        {
          name: 'models/gemini-2.5-flash-lite',
          displayName: 'Gemini 2.5 Flash Lite',
          description: 'Complex reasoning tasks requiring more intelligence',
          supportedGenerationMethods: ['generateContent']
        }
      ] as GeminiModel[];
    }

    return supportedModels;
  } catch (error) {
    aiDebug.error('❌ Error fetching available models:', error);
    aiDebug.warn('   Returning default model list as fallback');

    // Return default models on any exception
    return [
      {
        name: 'models/gemini-2.5-flash',
        displayName: 'Gemini 2.5 Flash',
        description: 'Latest fast model with improved performance',
        supportedGenerationMethods: ['generateContent']
      },
      {
        name: 'models/gemini-2.5-flash-lite',
        displayName: 'Gemini 2.5 Flash Lite',
        description: 'Latest advanced model for complex reasoning',
        supportedGenerationMethods: ['generateContent']
      },
      {
        name: 'models/gemini-1.5-flash',
        displayName: 'Gemini 1.5 Flash',
        description: 'Fast and versatile performance across a diverse variety of tasks',
        supportedGenerationMethods: ['generateContent']
      },
      {
        name: 'models/gemini-2.5-flash-lite',
        displayName: 'Gemini 2.5 Flash Lite',
        description: 'Complex reasoning tasks requiring more intelligence',
        supportedGenerationMethods: ['generateContent']
      }
    ] as GeminiModel[];
  }
};

/**
 * Gets detailed information about a specific model.
 * @param modelId The model ID (e.g., 'gemini-2.0-flash')
 * @returns Promise<GeminiModel> Model information
 */
export const getModelInfo = async (modelId: string): Promise<GeminiModel> => {
  aiDebug.debug(`Entering getModelInfo for modelId: ${modelId}`);
  aiDebug.log(`🔍 Fetching info for model: ${modelId}`);

  try {
    if (aiServiceConfig.useVertexAI) {
      aiDebug.log('⚠️ Model info via API is not available when using Vertex AI authentication');
      // Return basic model info for Vertex AI
      return {
        name: `models/${modelId}`,
        displayName: modelId,
        description: 'Vertex AI model',
        supportedGenerationMethods: ['generateContent']
      } as GeminiModel;
    }

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelId}?key=` + aiServiceConfig.apiKey);

    if (!response.ok) {
      throw new Error(`Failed to fetch model info: ${response.status} ${response.statusText}`);
    }

    const model: GeminiModel = await response.json();
    aiDebug.log(`✅ Successfully fetched info for model: ${model.displayName}`);

    return model;
  } catch (error) {
    aiDebug.error(`❌ Error fetching model info for ${modelId}:`, error);
    throw new Error(`Failed to fetch model info: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

/**
 * Generates a single, unique username based on a given style.
 * @param style The style of the username (e.g., 'tech', 'gaming').
 * @param avoidDuplicates A list of existing usernames to avoid.
 * @returns A promise that resolves to a unique username.
 */
export const generateUsername = async (
  style: string,
  avoidDuplicates: string[] = []
): Promise<string> => {
  aiDebug.debug(`Entering generateUsername with style: ${style}`);
  aiDebug.log(`generateUsername called with style: ${style}`);
  const prompt = `Generate a single, unique, creative, lowercase username for an IRC chat.
  Style: ${style}.
  Avoid these names: ${avoidDuplicates.join(', ')}.
  Respond with only the username.`;

  try {
    const response = await withRateLimitAndRetries(() =>
      ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: prompt,
        config: {
          maxOutputTokens: 20,
          temperature: 1.0
        }
      }), `username generation for style ${style}`
    );
    const username = extractTextFromResponse(response).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    aiDebug.log(`Successfully generated username: "${username}"`);
    return username;
  } catch (error) {
    aiDebug.error(`Error generating username for style ${style}:`, error);
    // Fallback to a simple random generator
    const prefixes = ['user', 'nick', 'chat', 'bot'];
    const randomPart = Math.random().toString(36).substring(2, 8);
    return `${prefixes[Math.floor(Math.random() * prefixes.length)]}_${randomPart}`;
  }
};

/**
 * Translates a personality description into a target language using the Gemini AI model.
 * @param personality The personality description to translate.
 * @param language The target language for the translation.
 * @returns A promise that resolves to the translated personality description.
 */
export async function generateTranslatedPersonality(personality: string, language: string): Promise<string> {
  aiDebug.debug(`Entering generateTranslatedPersonality for language: ${language}`);
  aiDebug.log(`generateTranslatedPersonality called for language: ${language}`);

  const prompt = `Translate the following personality description into ${language}, keeping the core traits and nuances intact: ${personality}`;

  try {
    const response = await withRateLimitAndRetries(() =>
      ai.models.generateContent({
        model: 'gemini-3-flash-preview', // Using a fast model for translation
        contents: prompt
      }), `personality translation to ${language}`
    );

    const translatedText = extractTextFromResponse(response);
    aiDebug.log(`Successfully translated personality to ${language}: "${translatedText}"`);
    return translatedText;
  } catch (error) {
    aiDebug.error(`Error translating personality to ${language}:`, {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      language: language,
      personality: personality
    });
    // Fallback to original personality if translation fails
    return personality;
  }
}

export const generatePersonalityFromTraits = async (
  traits: string[],
  language: string,
  model: string = 'gemini-3-flash-preview'
): Promise<string> => {
  aiDebug.debug(`Entering generatePersonalityFromTraits for language: ${language}`);
  aiDebug.log(`generatePersonalityFromTraits called for language: ${language}`);
  const validatedModel = validateModelId(model);

  const prompt = `Generate a detailed, 200-300-character personality description in ${language} based on these traits: ${traits.join(', ')}.
  The description should be rich, nuanced, and feel like a real person.
  Include cultural context, hobbies, quirks, and communication style.
  CRITICAL: Respond ONLY in ${language}.`;

  try {
    const response = await withRateLimitAndRetries(() =>
      ai.models.generateContent({
        model: validatedModel,
        contents: prompt
      }), `personality generation from traits in ${language}`
    );

    const personality = extractTextFromResponse(response);
    aiDebug.log(`Successfully generated personality from traits in ${language}: "${personality}"`);
    return personality;
  } catch (error) {
    aiDebug.error(`Error generating personality from traits in ${language}:`, {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      language: language,
      traits: traits
    });
    // Fallback to a simple combination of traits
    return `A person who is ${traits.join(', ')}.`;
  }
};

export const generateInCharacterComment = async (
  user: User,
  analysis: string,
  model: string = 'gemini-3-flash-preview'
): Promise<string> => {
  aiDebug.debug(`Entering generateInCharacterComment for user: ${user.nickname}`);
  const validatedModel = validateModelId(model);
  const writingStyle = safeGetUserProperty(user, 'writingStyle') as User['writingStyle'];
  const userLanguages = getAllLanguages(user.languageSkills);
  const primaryLanguage = userLanguages[0] || 'English';

  const prompt = `
You are roleplaying as an IRC user named '${user.nickname}'.
Your personality is: ${user.personality}.

You have just analyzed an image or audio file and the result of the analysis is:
"${analysis}"

Based on this analysis, generate a natural, in-character comment.
The comment must be a single line containing ONLY the message content.

CRITICAL: Respond ONLY in ${primaryLanguage}.

Your writing style:
- Formality: ${writingStyle.formality}
- Verbosity: ${writingStyle.verbosity}
- Humor: ${writingStyle.humor}
- Emoji usage: ${writingStyle.emojiUsage}
- Punctuation: ${writingStyle.punctuation}
`;

  try {
    const config = createApiConfig(validatedModel, 100, getBaseSystemInstruction(''), 0.8);
    const result = await generateContentUnified(prompt, validatedModel, config);
    return result;
  } catch (error) {
    aiDebug.error(`Error generating in-character comment from ${user.nickname}:`, error);
    return getFallbackResponse(user, 'reaction', analysis);
  }
};

export { getPersonalityAwareErrorMessage };

/**
 * Generates an image based on the provided prompt using Imagen 3.
 * @param prompt The prompt for image generation
 * @returns Buffer containing the generated image, or null if failed
 */
export const generateImage = async (prompt: string, options?: { aspectRatio?: string }): Promise<Buffer | null> => {
  try {
    aiDebug.log(`🎨 Generating image for prompt: "${prompt}" with options:`, JSON.stringify(options));

    // Check if we have a valid Gemini API key for image generation
    const aiServiceConfig = getAIServiceConfig();
    if (!aiServiceConfig.apiKey || aiServiceConfig.apiKey.startsWith('dummy-key')) {
      aiDebug.warn('⚠️ Image generation skipped: No valid Gemini API key available');
      return null;
    }

    const ai = getAIService();

    // Use Imagen 4 model
    const model = 'imagen-4.0-fast-generate-001';

    const imageConfig = {
      numberOfImages: 1,
      aspectRatio: options?.aspectRatio || '1:1',
      safetyFilterLevel: 'block_low_and_above',
      personGeneration: 'allow_adult'
    };

    aiDebug.log('🎨 Image generation config created');

    // Call the API
    const response = await ai.models.generateImages({
      model: model,
      prompt: prompt,
      config: imageConfig as any
    });

    // Handle response structure for @google/genai SDK
    if (response && response.generatedImages && response.generatedImages.length > 0) {
      const img = response.generatedImages[0];
      if (img.image && img.image.imageBytes) {
        return Buffer.from(img.image.imageBytes, 'base64');
      }
    }

    // Fallback for potential raw response structure
    const anyResponse = response as any;
    if (anyResponse.predictions && anyResponse.predictions.length > 0) {
      const bytes = anyResponse.predictions[0].bytesBase64Encoded;
      if (bytes) return Buffer.from(bytes, 'base64');
    }

    aiDebug.warn('⚠️ No image data found in response');
    // Log keys for debugging if needed
    if (response) {
      aiDebug.log('Response keys:', Object.keys(response));
    }
    throw new Error('No image data found in response');

  } catch (error) {
    aiDebug.error('❌ Image generation failed:', error);
    throw error;
  }
};

/**
 * Analyzes an image using Gemini's multimodal capabilities
 * @param prompt The prompt for the analysis
 * @param imageBuffer The image buffer
 * @param mimeType The mime type of the image (default: 'image/jpeg')
 * @returns Promise<string> The analysis text
 */
export const analyzeImageWithGemini = async (
  prompt: string,
  imageBuffer: Buffer,
  mimeType: string = 'image/jpeg'
): Promise<string> => {
  aiDebug.debug(`Entering analyzeImageWithGemini`);
  try {
    // Fallback to using the stable @google/generative-ai SDK which is known to work
    // Use gemini-2.0-flash (stable) for higher rate limits, but requires File API for images
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const { GoogleAIFileManager } = require('@google/generative-ai/server');
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    const apiKey = (aiServiceConfig.apiKey || process.env.GEMINI_API_KEY)?.trim();
    if (!apiKey) {
      throw new Error('Gemini API key not found');
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const fileManager = new GoogleAIFileManager(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    aiDebug.log(`👁️ Analyzing image with Gemini (gemini-2.0-flash) using File API`);

    // Write buffer to temp file
    const tempFilePath = path.join(os.tmpdir(), `gemini_upload_${Date.now()}.jpg`);
    fs.writeFileSync(tempFilePath, imageBuffer);

    let uploadResult: any;
    try {
      // Upload file
      uploadResult = await fileManager.uploadFile(tempFilePath, {
        mimeType: mimeType,
        displayName: 'Discord Image Analysis',
      });

      aiDebug.debug(`Uploaded image to Gemini: ${uploadResult.file.uri}`);

      // Generate content with file URI
      const result = await withRateLimitAndRetries(() => model.generateContent([
        prompt,
        {
          fileData: {
            fileUri: uploadResult.file.uri,
            mimeType: uploadResult.file.mimeType
          }
        }
      ]), 'gemini image analysis');

      const response = await (result as any).response;
      const text = response.text();

      aiDebug.log(`✅ Analyzed image with Gemini`);
      return text;

    } finally {
      // Cleanup temp file
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
      // Cleanup remote file (optional but good practice to keep quota clean)
      if (uploadResult) {
        // Run in background to not block response
        fileManager.deleteFile(uploadResult.file.name).catch((err: any) =>
          aiDebug.warn(`Failed to cleanup remote file: ${err.message}`)
        );
      }
    }

  } catch (error) {
    aiDebug.error(`❌ Gemini image analysis error:`, error);
    throw error;
  }
};
