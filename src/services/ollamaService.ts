/**
 * Ollama Service
 * Handles integration with local Ollama API for message generation
 * Ollama provides local LLM inference without requiring cloud API keys
 */

import { aiDebug } from '../utils/debugLogger';

export interface OllamaConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  temperature?: number;
  topP?: number;
  topK?: number;
}

export interface OllamaGenerateRequest {
  model: string;
  prompt: string;
  system?: string;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  num_predict?: number;
  num_ctx?: number;
}

export interface OllamaGenerateResponse {
  model: string;
  created_at: string;
  response: string;
  done: boolean;
  context?: number[];
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

/**
 * Gets Ollama configuration from environment variables
 * @returns Ollama configuration
 */
export const getOllamaConfig = (): OllamaConfig => {
  aiDebug.debug('Entering getOllamaConfig');
  const enabled = process.env.USE_OLLAMA === 'true';
  const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  // Default to enhanced Finnish model if available, otherwise use llama3.1:8b
  // Priority: finnish-llama3-comprehensive > finnish-llama3-v2 > finnish-llama3-enhanced > llama3.1:8b
  const model = process.env.OLLAMA_MODEL || 'finnish-llama3-comprehensive';

  // Optimized defaults for conversational quality (similar to Gemini's approach)
  let temperature = process.env.OLLAMA_TEMPERATURE ? parseFloat(process.env.OLLAMA_TEMPERATURE) : 0.65;
  let topP = process.env.OLLAMA_TOP_P ? parseFloat(process.env.OLLAMA_TOP_P) : 0.85;
  let topK = process.env.OLLAMA_TOP_K ? parseInt(process.env.OLLAMA_TOP_K, 10) : 35;

  // Model-specific optimizations
  if (model.includes('llama3.1')) {
    // Llama 3.1 performs best with slightly higher temperature for personality
    temperature = Math.max(temperature, 0.6);
    topP = 0.9;  // More diverse responses
    topK = 40;   // Allow more options
    aiDebug.log('🔧 Optimized parameters for Llama 3.1 conversational quality');
  } else if (model.includes('llama3')) {
    // Standard Llama 3 optimizations
    temperature = Math.max(temperature, 0.55);
    topP = 0.85;
    topK = 35;
    aiDebug.log('🔧 Optimized parameters for Llama 3 conversational quality');
  } else if (model.includes('mistral')) {
    // Mistral needs higher temperature to overcome stiffness
    temperature = Math.max(temperature, 0.7);
    topP = 0.9;
    topK = 50;
    aiDebug.log('🔧 Optimized parameters for Mistral conversational quality');
  } else if (model.includes('OpenEuroLLM-Finnish') || model.includes('openeurollm-finnish')) {
    aiDebug.log('🔧 Applying performance optimizations for Finnish model');
    temperature = 0.4; // Lower temperature for more deterministic responses
    topP = 0.75;       // Slightly more focused responses
    topK = 25;         // Reduce options for faster generation
  } else if (model.includes('phi3')) {
    // Phi-3 can be creative but needs consistency controls
    temperature = 0.5;
    topP = 0.8;
    topK = 30;
    aiDebug.log('🔧 Optimized parameters for Phi-3 consistency');
  }

  if (enabled && !baseUrl) {
    throw new Error('OLLAMA_BASE_URL environment variable is required when USE_OLLAMA is true');
  }

  return {
    enabled,
    baseUrl,
    model,
    temperature,
    topP,
    topK
  };
};

/**
 * Tests connection to Ollama server
 * @param config Ollama configuration
 * @returns Promise<boolean> True if connection successful
 */
export const testOllamaConnection = async (config: OllamaConfig): Promise<boolean> => {
  aiDebug.debug(`Entering testOllamaConnection with baseUrl: ${config.baseUrl}`);
  try {
    aiDebug.log(`🔧 Testing Ollama connection to ${config.baseUrl}...`);
    const response = await fetch(`${config.baseUrl}/api/tags`);
    
    if (!response.ok) {
      aiDebug.error(`❌ Ollama connection failed: ${response.status} ${response.statusText}`);
      return false;
    }

    const data = await response.json();
    aiDebug.log(`✅ Ollama connection successful. Available models: ${data.models?.length || 0}`);
    return true;
  } catch (error) {
    aiDebug.error(`❌ Ollama connection error: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
};

/**
 * Generates content using Ollama API
 * @param prompt The prompt to send to Ollama
 * @param config Ollama configuration
 * @param systemInstruction Optional system instruction to include
 * @returns Promise<string> The generated text response
 */
/**
 * Enhances system instructions for better Ollama model compliance
 * Ollama models need clearer, more direct instructions than Gemini
 */
const enhanceSystemInstructionForOllama = (systemInstruction: string, model: string): string => {
  if (!systemInstruction) return '';

  // Add Ollama-specific enhancements for better instruction following
  let enhanced = systemInstruction;

  // For Llama models, add explicit instruction following guidance
  if (model.includes('llama')) {
    // Special handling for Finnish models - add STRONG language enforcement
    if (model.includes('finnish') || systemInstruction.includes('SUOMEKSI') || systemInstruction.includes('Finnish')) {
      enhanced = `KRIITTINEN: Vastaat AINOASTAAN suomeksi. ÄLÄ käytä englantia tai mitään muuta kieltä.\n\n${enhanced}\n\nKRIITTISET MUISTUTUKSET:\n- Vastaat AINOASTAAN suomeksi\n- Pysyt hahmossa kuten yllä kuvattu\n- Seuraat kirjoitustyyliohjeita tarkasti\n- Vastaat luonnollisesti ja keskustelullisesti\n- ÄLÄ riko hahmoa tai myönnä olevasi AI\n- ÄLÄ koskaan vastaa englanniksi`;
    } else {
    enhanced = `IMPORTANT: Follow these instructions exactly and stay in character at all times.\n\n${enhanced}\n\nCRITICAL REMINDERS:\n- Stay in character as described above\n- Follow the writing style guidelines precisely\n- Respond naturally and conversationally\n- Do not break character or acknowledge being an AI`;
    }
  }

  // For Mistral, add structure guidance
  else if (model.includes('mistral')) {
    enhanced = `SYSTEM INSTRUCTIONS - FOLLOW THESE EXACTLY:\n${enhanced}\n\nRESPONSE GUIDELINES:\n- Stay completely in character\n- Follow all writing style rules\n- Be conversational and natural\n- Do not mention being an AI`;
  }

  // For Phi-3, add consistency reminders
  else if (model.includes('phi3')) {
    enhanced = `CHARACTER CONSISTENCY REQUIRED:\n${enhanced}\n\nABSOLUTELY CRITICAL:\n- Maintain the exact personality described\n- Use the specified writing style without variation\n- Stay in character throughout the entire response\n- No meta-commentary or breaking character`;
  }

  return enhanced;
};

export const generateWithOllama = async (
  prompt: string,
  config: OllamaConfig,
  systemInstruction?: string
): Promise<string> => {
  aiDebug.debug(`Entering generateWithOllama with model: ${config.model}`);
  try {
    aiDebug.log(`📝 Generating content with Ollama model: ${config.model}`);

    // Enhance system instructions for better Ollama compliance
    const enhancedSystemInstruction = systemInstruction
      ? enhanceSystemInstructionForOllama(systemInstruction, config.model)
      : undefined;

    // Optimize parameters based on model and use case (conversational)
    let numPredict = 800; // Shorter responses for conversational quality
    let numCtx = 4096;    // Good context window for conversation history

    // Model-specific optimizations
    if (config.model.includes('llama3.1')) {
      numPredict = 1000; // Llama 3.1 can handle longer responses well
      numCtx = 8192;     // Larger context for better conversation understanding
      aiDebug.log('🔧 Using conversational optimization for Llama 3.1');
    } else if (config.model.includes('mistral')) {
      numPredict = 600;  // Mistral works well with moderate length
      numCtx = 4096;
      aiDebug.log('🔧 Using conversational optimization for Mistral');
    } else if (config.model.includes('phi3')) {
      numPredict = 500;  // Phi-3 can be wordy, limit it
      numCtx = 2048;
      aiDebug.log('🔧 Using conversational optimization for Phi-3');
    } else if (config.model.includes('OpenEuroLLM-Finnish') || config.model.includes('openeurollm-finnish')) {
      aiDebug.log('🔧 Applying response length optimization for Finnish model');
      numPredict = 200; // Shorter responses for speed
      numCtx = 2048;    // Reasonable context for Finnish conversations
    } else if (config.model.includes('finnish-llama3') || config.model.includes('llama3') && config.model.includes('finnish')) {
      aiDebug.log('🔧 Applying enhanced Finnish Llama3 optimizations');
      numPredict = 900; // Good length for conversational Finnish
      numCtx = 8192;    // Full context for better conversation understanding
      // These models are already optimized in the Modelfile, but we can still adjust here
    }

    const requestBody: OllamaGenerateRequest = {
      model: config.model,
      prompt: prompt,
      stream: false,
      temperature: config.temperature,
      top_p: config.topP,
      top_k: config.topK,
      num_predict: numPredict,
      ...(numCtx && { num_ctx: numCtx }),
      ...(enhancedSystemInstruction && { system: enhancedSystemInstruction })
    };

    const response = await fetch(`${config.baseUrl}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }

    const data: OllamaGenerateResponse = await response.json();
    
    if (!data.response) {
      throw new Error('Empty response from Ollama');
    }

    aiDebug.log(`✅ Generated content from Ollama (${data.eval_count} tokens)`);
    return data.response.trim();
  } catch (error) {
    aiDebug.error(`❌ Ollama generation error: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
};

/**
 * Lists available models from Ollama
 * @param config Ollama configuration
 * @returns Promise<string[]> Array of available model names
 */
export const listOllamaModels = async (config: OllamaConfig): Promise<string[]> => {
  aiDebug.debug(`Entering listOllamaModels with baseUrl: ${config.baseUrl}`);
  try {
    const response = await fetch(`${config.baseUrl}/api/tags`);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status}`);
    }

    const data = await response.json();
    return data.models?.map((m: unknown) => (m as any).name) || [];
  } catch (error) {
    aiDebug.error(`❌ Error listing Ollama models: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
};

/**
 * Validates that the configured model exists in Ollama
 * @param config Ollama configuration
 * @returns Promise<boolean> True if model is available
 */
export const validateOllamaModel = async (config: OllamaConfig): Promise<boolean> => {
  aiDebug.debug(`Entering validateOllamaModel with model: ${config.model}`);
  try {
    const models = await listOllamaModels(config);
    const modelExists = models.some(m => m.includes(config.model));
    
    if (!modelExists) {
      aiDebug.warn(`⚠️ Model ${config.model} not found in Ollama. Available models: ${models.join(', ')}`);
      
      // If the requested model is a Finnish model and not found, try to find an alternative
      if (config.model.includes('finnish')) {
        const alternativeModels = [
          'finnish-llama3-comprehensive',
          'finnish-llama3-v2',
          'finnish-llama3-enhanced',
          'finnish-llama3',
          'finnish-llama3-simple'
        ];
        
        for (const altModel of alternativeModels) {
          const found = models.find(m => m.includes(altModel));
          if (found) {
            aiDebug.log(`🔄 Falling back to available Finnish model: ${found}`);
            config.model = found;
            return true;
          }
        }
      }
      
      return false;
    }

    aiDebug.log(`✅ Ollama model ${config.model} is available`);
    return true;
  } catch (error) {
    aiDebug.error(`❌ Error validating Ollama model: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
};
