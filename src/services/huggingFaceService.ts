/**
 * Hugging Face Inference API Service
 * Provides free text generation using Hugging Face models
 * Free tier: 30,000 requests/month, 1 request/second
 */

import axios from 'axios';
import { aiDebug } from '../utils/debugLogger';

export interface HuggingFaceConfig {
  enabled: boolean;
  apiKey?: string; // Optional - free tier works without API key, but rate limited
  model: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
}

export interface HuggingFaceTextGenerationRequest {
  inputs: string;
  parameters?: {
    max_new_tokens?: number;
    temperature?: number;
    top_p?: number;
    top_k?: number;
    do_sample?: boolean;
    return_full_text?: boolean;
  };
  options?: {
    wait_for_model?: boolean;
    use_cache?: boolean;
  };
  stream?: boolean;
}

export interface HuggingFaceTextGenerationResponse {
  generated_text: string;
  details?: {
    finish_reason: string;
    generated_tokens: number;
    seed: number;
    prefill: any[];
    tokens: any[];
  };
}

/**
 * Gets Hugging Face configuration from environment variables
 */
export const getHuggingFaceConfig = (): HuggingFaceConfig => {
  aiDebug.debug('Entering getHuggingFaceConfig');

  const enabled = process.env.USE_HUGGINGFACE === 'true' && false; // Temporarily disabled due to API changes
  const apiKey = process.env.HUGGINGFACE_API_KEY || undefined; // Optional for free tier
  const model = process.env.HUGGINGFACE_MODEL || 'gpt2'; // Reliable and popular model
  const temperature = process.env.HUGGINGFACE_TEMPERATURE ? parseFloat(process.env.HUGGINGFACE_TEMPERATURE) : 0.7;
  const maxTokens = process.env.HUGGINGFACE_MAX_TOKENS ? parseInt(process.env.HUGGINGFACE_MAX_TOKENS) : 150;
  const topP = process.env.HUGGINGFACE_TOP_P ? parseFloat(process.env.HUGGINGFACE_TOP_P) : 0.9;
  const topK = process.env.HUGGINGFACE_TOP_K ? parseInt(process.env.HUGGINGFACE_TOP_K) : 50;

  if (enabled) {
    aiDebug.log(`🤗 Hugging Face service enabled`);
    aiDebug.log(`   Model: ${model}`);
    aiDebug.log(`   API Key: ${apiKey ? 'configured' : 'not configured (free tier)'}`);
    aiDebug.log(`   Temperature: ${temperature}`);
    aiDebug.log(`   Max Tokens: ${maxTokens}`);
  }

  return {
    enabled,
    apiKey,
    model,
    temperature,
    maxTokens,
    topP,
    topK
  };
};

/**
 * Tests Hugging Face API connection
 */
export const testHuggingFaceConnection = async (config: HuggingFaceConfig): Promise<boolean> => {
  try {
    aiDebug.log('🧪 Testing Hugging Face API connection...');

    const testPrompt = "Hello, this is a test.";
    await generateWithHuggingFace(testPrompt, config);

    aiDebug.log('✅ Hugging Face API connection successful');
    return true;
  } catch (error) {
    aiDebug.error('❌ Hugging Face API connection failed:', error);
    return false;
  }
};

/**
 * Generates text using Hugging Face Inference API
 */
export const generateWithHuggingFace = async (
  prompt: string,
  config: HuggingFaceConfig,
  systemInstruction?: string
): Promise<string> => {
  aiDebug.debug(`Entering generateWithHuggingFace with model: ${config.model}`);

  if (!config.enabled) {
    throw new Error('Hugging Face service is not enabled');
  }

  try {
    aiDebug.log(`🤗 Generating content with Hugging Face model: ${config.model}`);

    // Prepare the full prompt
    const fullPrompt = systemInstruction ? `${systemInstruction}\n\n${prompt}` : prompt;

    const requestBody: HuggingFaceTextGenerationRequest = {
      inputs: fullPrompt,
      parameters: {
        max_new_tokens: config.maxTokens || 150,
        temperature: config.temperature || 0.7,
        top_p: config.topP || 0.9,
        top_k: config.topK || 50,
        do_sample: true,
        return_full_text: false
      },
      options: {
        wait_for_model: true,
        use_cache: true
      },
      // Add stream parameter for router.huggingface.co
      stream: false
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    // Add API key if available (improves rate limits and access to more models)
    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    const url = `https://router.huggingface.co/hf-inference/models/${config.model}`;

    aiDebug.log(`Making request to: ${url}`);

    const response = await axios.post(url, requestBody, {
      headers,
      timeout: 30000 // 30 second timeout
    });

    if (response.data) {
      let generatedText = '';

      // Handle different response formats from router.huggingface.co
      if (Array.isArray(response.data)) {
        // Array format: [{ generated_text: "..." }]
        const result = response.data[0];
        if (typeof result === 'object' && result.generated_text) {
          generatedText = result.generated_text.trim();
        } else if (typeof result === 'string') {
          generatedText = result.trim();
        }
      } else if (typeof response.data === 'object' && response.data.generated_text) {
        // Object format: { generated_text: "..." }
        generatedText = response.data.generated_text.trim();
      } else if (typeof response.data === 'string') {
        // String format
        generatedText = response.data.trim();
      }

      if (generatedText) {
        // Remove the original prompt from the response if it's included
        const cleanText = generatedText.startsWith(fullPrompt)
          ? generatedText.substring(fullPrompt.length).trim()
          : generatedText;

        aiDebug.log(`✅ Generated content from Hugging Face (${cleanText.length} chars)`);
        return cleanText;
      }
    }

    throw new Error('Empty or invalid response from Hugging Face API');

  } catch (error: any) {
    aiDebug.error(`❌ Hugging Face generation error: ${error instanceof Error ? error.message : String(error)}`);

    // Provide helpful error messages
    if (error.response) {
      const status = error.response.status;
      const data = error.response.data;

      if (status === 429) {
        aiDebug.error('❌ Rate limit exceeded. Consider adding HUGGINGFACE_API_KEY for higher limits');
      } else if (status === 503) {
        aiDebug.error('❌ Model is loading. Please try again in a few moments');
      } else if (status === 403) {
        aiDebug.error('❌ Access denied. Check your API key or model permissions');
      } else {
        aiDebug.error(`❌ HTTP ${status} error:`, data);
      }
    }

    throw error;
  }
};

/**
 * Lists available models (requires API key for full access)
 */
export const listHuggingFaceModels = async (config: HuggingFaceConfig): Promise<any[]> => {
  try {
    aiDebug.log('📋 Fetching available Hugging Face models...');

    const headers: Record<string, string> = {};
    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    const response = await axios.get('https://api-inference.huggingface.co/models', {
      headers,
      params: {
        limit: 100,
        sort: 'downloads',
        direction: -1,
        filter: 'text-generation'
      }
    });

    aiDebug.log(`✅ Found ${response.data.length} text generation models`);
    return response.data;

  } catch (error: any) {
    aiDebug.error('❌ Failed to list Hugging Face models:', error);
    return [];
  }
};
