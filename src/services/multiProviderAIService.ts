/**
 * Multi-Provider AI Service
 * Provides unified interface for multiple AI providers with intelligent fallback
 * Supports: OpenAI, Anthropic, Gemini, Ollama (local), Cloud models (Ollama Cloud, AI/ML API), and custom endpoints
 */

import dotenv from 'dotenv';
import { aiDebug } from '../utils/debugLogger';
import { getAIServiceConfig } from './vertexAIService';
import { generateWithOllama, getOllamaConfig, testOllamaConnection } from './ollamaService';

// Load environment variables
dotenv.config();

// Provider interfaces
export interface AIProvider {
  name: string;
  isAvailable(): Promise<boolean>;
  generateResponse(prompt: string, options?: GenerationOptions): Promise<string>;
  getEstimatedCost(tokens: number): number;
}

export interface GenerationOptions {
  systemInstruction?: string;
  temperature?: number;
  maxTokens?: number;
  model?: string;
  language?: string;
  context?: string;
}

export interface ProviderConfig {
  enabled: boolean;
  priority: number;
  fallbackOnly?: boolean;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

// OpenAI Provider
class OpenAIProvider implements AIProvider {
  name = 'OpenAI';
  private client: any = null;
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async isAvailable(): Promise<boolean> {
    try {
      if (!this.config.apiKey || !this.config.enabled) return false;
      
      // Lazy import to avoid issues if OpenAI is not installed
      const { OpenAI } = await import('openai');
      this.client = new OpenAI({ apiKey: this.config.apiKey });
      
      // Test with a lightweight API call
      await this.client.models.list();
      return true;
    } catch (error) {
      aiDebug.warn(`OpenAI provider unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async generateResponse(prompt: string, options?: GenerationOptions): Promise<string> {
    if (!this.client) {
      throw new Error('OpenAI client not initialized');
    }

    try {
      const response = await this.client.chat.completions.create({
        model: this.config.model || 'gpt-3.5-turbo',
        messages: [
          ...(options?.systemInstruction ? [{ role: 'system', content: options.systemInstruction }] : []),
          { role: 'user', content: prompt }
        ],
        temperature: options?.temperature ?? this.config.temperature ?? 0.7,
        max_tokens: options?.maxTokens ?? this.config.maxTokens ?? 1000,
      });

      return response.choices[0]?.message?.content || '';
    } catch (error) {
      aiDebug.error(`OpenAI generation error: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  getEstimatedCost(tokens: number): number {
    // OpenAI GPT-3.5-turbo pricing (approximate)
    return (tokens / 1000) * 0.002;
  }
}

// Anthropic Provider
class AnthropicProvider implements AIProvider {
  name = 'Anthropic';
  private client: any = null;
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async isAvailable(): Promise<boolean> {
    try {
      if (!this.config.apiKey || !this.config.enabled) return false;
      
      // Lazy import
      const Anthropic = await import('@anthropic-ai/sdk').then(m => m.default);
      this.client = new Anthropic({ apiKey: this.config.apiKey });
      
      // Test with a simple message
      await this.client.messages.create({
        model: 'claude-3-haiku-20240307',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'test' }]
      });
      return true;
    } catch (error) {
      aiDebug.warn(`Anthropic provider unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async generateResponse(prompt: string, options?: GenerationOptions): Promise<string> {
    if (!this.client) {
      throw new Error('Anthropic client not initialized');
    }

    try {
      const response = await this.client.messages.create({
        model: this.config.model || 'claude-3-haiku-20240307',
        max_tokens: options?.maxTokens ?? this.config.maxTokens ?? 1000,
        temperature: options?.temperature ?? this.config.temperature ?? 0.7,
        system: options?.systemInstruction,
        messages: [{ role: 'user', content: prompt }]
      });

      return response.content[0]?.text || '';
    } catch (error) {
      aiDebug.error(`Anthropic generation error: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  getEstimatedCost(tokens: number): number {
    // Anthropic Claude Haiku pricing (approximate)
    return (tokens / 1000) * 0.00025;
  }
}

// Enhanced Gemini Provider
class GeminiProvider implements AIProvider {
  name = 'Gemini';
  private client: any = null;
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async isAvailable(): Promise<boolean> {
    try {
      if (!this.config.apiKey || !this.config.enabled) return false;
      
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      this.client = new GoogleGenerativeAI(this.config.apiKey);
      
      // Test with model list
      const model = this.client.getGenerativeModel({ model: this.config.model || 'gemini-3-flash-preview' });
      return true;
    } catch (error) {
      aiDebug.warn(`Gemini provider unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async generateResponse(prompt: string, options?: GenerationOptions): Promise<string> {
    if (!this.client) {
      throw new Error('Gemini client not initialized');
    }

    try {
      const model = this.client.getGenerativeModel({ model: this.config.model || 'gemini-3-flash-preview' });
      
      let fullPrompt = prompt;
      if (options?.systemInstruction) {
        fullPrompt = `${options.systemInstruction}\n\n${prompt}`;
      }

      const result = await model.generateContent(fullPrompt);
      const response = await result.response;
      return response.text();
    } catch (error) {
      aiDebug.error(`Gemini generation error: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  getEstimatedCost(tokens: number): number {
    // Gemini Flash pricing (approximate, free tier limited)
    return 0; // Free tier, but limited
  }
}

// Enhanced Ollama Provider
class OllamaProvider implements AIProvider {
  name = 'Ollama';
  private config: ProviderConfig;
  private ollamaConfig: any = null;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async isAvailable(): Promise<boolean> {
    try {
      if (!this.config.enabled) return false;
      
      this.ollamaConfig = getOllamaConfig();
      if (!this.ollamaConfig.enabled) return false;
      
      return await testOllamaConnection(this.ollamaConfig);
    } catch (error) {
      aiDebug.warn(`Ollama provider unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async generateResponse(prompt: string, options?: GenerationOptions): Promise<string> {
    if (!this.ollamaConfig) {
      throw new Error('Ollama not configured');
    }

    try {
      return await generateWithOllama(prompt, this.ollamaConfig, options?.systemInstruction);
    } catch (error) {
      aiDebug.error(`Ollama generation error: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  getEstimatedCost(tokens: number): number {
    // Local inference - no direct cost, but electricity/hardware
    return 0;
  }
}

// Custom API Provider (for services like Groq, Mistral API, etc.)
class CustomAPIProvider implements AIProvider {
  name = 'Custom API';
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async isAvailable(): Promise<boolean> {
    try {
      if (!this.config.baseUrl || !this.config.apiKey || !this.config.enabled) return false;
      
      // Test with a simple health check or models endpoint
      const response = await fetch(`${this.config.baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${this.config.apiKey}` }
      });
      return response.ok;
    } catch (error) {
      aiDebug.warn(`Custom API provider unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async generateResponse(prompt: string, options?: GenerationOptions): Promise<string> {
    try {
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify({
          model: this.config.model || 'default',
          messages: [
            ...(options?.systemInstruction ? [{ role: 'system', content: options.systemInstruction }] : []),
            { role: 'user', content: prompt }
          ],
          temperature: options?.temperature ?? this.config.temperature ?? 0.7,
          max_tokens: options?.maxTokens ?? this.config.maxTokens ?? 1000,
        })
      });

      if (!response.ok) {
        throw new Error(`Custom API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return data.choices[0]?.message?.content || '';
    } catch (error) {
      aiDebug.error(`Custom API generation error: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  getEstimatedCost(tokens: number): number {
    // Unknown pricing - estimate
    return (tokens / 1000) * 0.001;
  }
}

// Ollama Cloud Provider
class OllamaCloudProvider implements AIProvider {
  name = 'OllamaCloud';
  private client: any = null;
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async isAvailable(): Promise<boolean> {
    try {
      if (!this.config.apiKey) {
        aiDebug.warn('Ollama Cloud: No API key provided');
        return false;
      }

      // Test with a simple request (disable streaming for availability check)
      const response = await fetch('https://ollama.com/api/chat', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model || 'minimax-m2',
          messages: [{ role: 'user', content: 'test' }],
          stream: false, // Disable streaming for availability check
        }),
      });

      // Use status property (fetch API) instead of response.ok
      return response.status >= 200 && response.status < 300;
    } catch (error) {
      aiDebug.error(`Ollama Cloud availability check failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async generateResponse(prompt: string, options?: GenerationOptions): Promise<string> {
    if (!this.config.apiKey) {
      throw new Error('Ollama Cloud API key not configured');
    }

    try {
      const messages = [];
      
      // Add system instruction if provided
      if (options?.systemInstruction) {
        messages.push({
          role: 'system',
          content: options.systemInstruction
        });
      }
      
      // Add user prompt
      messages.push({
        role: 'user',
        content: prompt
      });

      const response = await fetch('https://ollama.com/api/chat', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model || 'minimax-m2',
          messages,
          stream: false, // Disable streaming for now to get single response
          options: {
            temperature: options?.temperature || this.config.temperature || 0.7,
            num_predict: options?.maxTokens || this.config.maxTokens || 800,
          }
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama Cloud API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return data.message?.content || '';
    } catch (error) {
      aiDebug.error(`Ollama Cloud generation error: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  getEstimatedCost(tokens: number): number {
    // Ollama Cloud pricing (estimate)
    return (tokens / 1000) * 0.005;
  }
}

// AI/ML API Provider (for Minimax M2 and other models)
class AIMLProvider implements AIProvider {
  name = 'AIML';
  private client: any = null;
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async isAvailable(): Promise<boolean> {
    try {
      if (!this.config.apiKey) {
        aiDebug.warn('AI/ML API: No API key provided');
        return false;
      }

      // Test with a simple request
      const response = await fetch('https://api.aimlapi.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model || 'minimax/m2',
          messages: [{ role: 'user', content: 'test' }],
        }),
      });

      return response.ok;
    } catch (error) {
      aiDebug.error(`AI/ML API availability check failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async generateResponse(prompt: string, options?: GenerationOptions): Promise<string> {
    if (!this.config.apiKey) {
      throw new Error('AI/ML API key not configured');
    }

    try {
      const messages = [];
      
      // Add system instruction if provided
      if (options?.systemInstruction) {
        messages.push({
          role: 'system',
          content: options.systemInstruction
        });
      }
      
      // Add user prompt
      messages.push({
        role: 'user',
        content: prompt
      });

      const response = await fetch('https://api.aimlapi.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model || 'minimax/m2',
          messages,
          temperature: options?.temperature || this.config.temperature || 0.7,
          max_tokens: options?.maxTokens || this.config.maxTokens || 800,
        }),
      });

      if (!response.ok) {
        throw new Error(`AI/ML API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return data.choices[0]?.message?.content || '';
    } catch (error) {
      aiDebug.error(`AI/ML API generation error: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  getEstimatedCost(tokens: number): number {
    // AI/ML API pricing (estimate)
    return (tokens / 1000) * 0.003;
  }
}

// Main Multi-Provider Service
export class MultiProviderAIService {
  private providers: AIProvider[] = [];
  private providerStatus: Map<string, boolean> = new Map();
  private lastProviderCheck: number = 0;
  private checkInterval: number = 60000; // Check provider availability every minute

  constructor() {
    this.initializeProviders();
  }

  private async initializeProviders() {
    const configs = this.getProviderConfigs();
    
    // Store configs for use in filtering
    const providerConfigs = configs;
    
    this.providers = [
      new OpenAIProvider(providerConfigs.openai),
      new AnthropicProvider(providerConfigs.anthropic),
      new GeminiProvider(providerConfigs.gemini),
      new OllamaProvider(providerConfigs.ollama),
      new OllamaCloudProvider(providerConfigs.ollamaCloud),
      new AIMLProvider(providerConfigs.aiml),
      new CustomAPIProvider(providerConfigs.custom),
    ].filter(provider => {
      // Fix property name case: OllamaCloud -> ollamaCloud, Custom API -> custom
      const providerKey = provider.name.toLowerCase() === 'ollamacloud' ? 'ollamaCloud' : 
                        provider.name.toLowerCase() === 'custom api' ? 'custom' :
                        provider.name.toLowerCase() as keyof typeof providerConfigs;
      
      const config = providerConfigs[providerKey];
      const wouldBeIncluded = config && config.enabled;
      return wouldBeIncluded;
    });

    // Sort by priority
    this.providers.sort((a, b) => {
      const providerKeyA = a.name.toLowerCase() === 'ollamacloud' ? 'ollamaCloud' : 
                          a.name.toLowerCase() === 'custom api' ? 'custom' :
                          a.name.toLowerCase() as keyof typeof providerConfigs;
      const providerKeyB = b.name.toLowerCase() === 'ollamacloud' ? 'ollamaCloud' : 
                          b.name.toLowerCase() === 'custom api' ? 'custom' :
                          b.name.toLowerCase() as keyof typeof providerConfigs;
      
      const configA = providerConfigs[providerKeyA];
      const configB = providerConfigs[providerKeyB];
      return (configA?.priority || 999) - (configB?.priority || 999);
    });

    await this.checkProviderAvailability();
  }

  private getProviderConfigs() {
    // Ensure environment variables are loaded (fix for TypeScript context)
    dotenv.config();
    
    const ollamaCloudEnabled = process.env.OLLAMA_CLOUD_ENABLED === 'true';
    
    return {
      openai: {
        enabled: process.env.OPENAI_ENABLED === 'true',
        priority: parseInt(process.env.OPENAI_PRIORITY || '3'),
        apiKey: process.env.OPENAI_API_KEY,
        model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
        temperature: parseFloat(process.env.OPENAI_TEMPERATURE || '0.7'),
        maxTokens: parseInt(process.env.OPENAI_MAX_TOKENS || '1000'),
      },
      anthropic: {
        enabled: process.env.ANTHROPIC_ENABLED === 'true',
        priority: parseInt(process.env.ANTHROPIC_PRIORITY || '2'),
        apiKey: process.env.ANTHROPIC_API_KEY,
        model: process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307',
        temperature: parseFloat(process.env.ANTHROPIC_TEMPERATURE || '0.7'),
        maxTokens: parseInt(process.env.ANTHROPIC_MAX_TOKENS || '1000'),
      },
      gemini: {
        enabled: process.env.GEMINI_ENABLED !== 'false', // Enable by default if key exists
        priority: parseInt(process.env.GEMINI_PRIORITY || '4'),
        apiKey: process.env.GEMINI_API_KEY,
        model: process.env.GEMINI_MODEL || 'gemini-3-flash-preview',
        temperature: parseFloat(process.env.GEMINI_TEMPERATURE || '0.7'),
        maxTokens: parseInt(process.env.GEMINI_MAX_TOKENS || '1000'),
      },
      ollama: {
        enabled: process.env.USE_OLLAMA === 'true',
        priority: parseInt(process.env.OLLAMA_PRIORITY || '1'), // Highest priority by default
        baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
        model: process.env.OLLAMA_MODEL || 'finnish-llama3-comprehensive',
        temperature: parseFloat(process.env.OLLAMA_TEMPERATURE || '0.65'),
        topP: process.env.OLLAMA_TOP_P ? parseFloat(process.env.OLLAMA_TOP_P) : 0.9,
        topK: process.env.OLLAMA_TOP_K ? parseInt(process.env.OLLAMA_TOP_K, 10) : 40,
      },
      custom: {
        enabled: process.env.CUSTOM_API_ENABLED === 'true',
        priority: parseInt(process.env.CUSTOM_API_PRIORITY || '5'),
        apiKey: process.env.CUSTOM_API_KEY,
        baseUrl: process.env.CUSTOM_API_BASE_URL,
        model: process.env.CUSTOM_API_MODEL || 'default',
        temperature: parseFloat(process.env.CUSTOM_API_TEMPERATURE || '0.7'),
        maxTokens: parseInt(process.env.CUSTOM_API_MAX_TOKENS || '1000'),
      },
      ollamaCloud: {
        enabled: ollamaCloudEnabled,
        priority: parseInt(process.env.OLLAMA_CLOUD_PRIORITY || '2'),
        apiKey: process.env.OLLAMA_API_KEY,
        model: process.env.OLLAMA_CLOUD_MODEL || 'minimax-m2',
        temperature: parseFloat(process.env.OLLAMA_CLOUD_TEMPERATURE || '0.7'),
        maxTokens: parseInt(process.env.OLLAMA_CLOUD_MAX_TOKENS || '800'),
      },
      aiml: {
        enabled: process.env.AIML_API_ENABLED === 'true',
        priority: parseInt(process.env.AIML_API_PRIORITY || '2'),
        apiKey: process.env.AIML_API_KEY,
        model: process.env.AIML_API_MODEL || 'minimax/m2',
        temperature: parseFloat(process.env.AIML_API_TEMPERATURE || '0.7'),
        maxTokens: parseInt(process.env.AIML_API_MAX_TOKENS || '800'),
      },
    };
  }

  private async checkProviderAvailability() {
    const now = Date.now();
    if (now - this.lastProviderCheck < this.checkInterval) {
      return;
    }

    aiDebug.log('🔍 Checking AI provider availability...');
    
    const checks = this.providers.map(async provider => {
      try {
        const available = await provider.isAvailable();
        this.providerStatus.set(provider.name, available);
        aiDebug.log(`${available ? '✅' : '❌'} ${provider.name}: ${available ? 'Available' : 'Unavailable'}`);
        return available;
      } catch (error) {
        this.providerStatus.set(provider.name, false);
        aiDebug.warn(`❌ ${provider.name}: Error checking availability`);
        return false;
      }
    });

    await Promise.allSettled(checks);
    this.lastProviderCheck = now;
  }

  async generateResponse(prompt: string, options?: GenerationOptions): Promise<string> {
    await this.checkProviderAvailability();

    const availableProviders = this.providers.filter(provider => 
      this.providerStatus.get(provider.name) === true
    );

    if (availableProviders.length === 0) {
      throw new Error('No AI providers are currently available');
    }

    aiDebug.log(`🤖 Attempting generation with ${availableProviders.length} available providers`);

    // Try each available provider in order of priority
    for (const provider of availableProviders) {
      try {
        aiDebug.log(`📝 Trying ${provider.name}...`);
        const response = await provider.generateResponse(prompt, options);
        aiDebug.log(`✅ Success with ${provider.name}`);
        return response;
      } catch (error) {
        aiDebug.warn(`❌ ${provider.name} failed: ${error instanceof Error ? error.message : String(error)}`);
        
        // Mark provider as unavailable for this session
        this.providerStatus.set(provider.name, false);
        
        // Continue to next provider
        continue;
      }
    }

    throw new Error('All available AI providers failed to generate a response');
  }

  async generateWithFallback(prompt: string, options?: GenerationOptions, preferredProvider?: string): Promise<{ response: string; provider: string; cost: number }> {
    await this.checkProviderAvailability();

    let providers = this.providers.filter(provider => 
      this.providerStatus.get(provider.name) === true
    );

    // If preferred provider is specified and available, try it first
    if (preferredProvider) {
      const preferred = providers.find(p => p.name === preferredProvider);
      if (preferred) {
        providers = [preferred, ...providers.filter(p => p.name !== preferredProvider)];
      }
    }

    if (providers.length === 0) {
      throw new Error('No AI providers are currently available');
    }

    for (const provider of providers) {
      try {
        const response = await provider.generateResponse(prompt, options);
        const cost = provider.getEstimatedCost(prompt.length + response.length);
        
        return {
          response,
          provider: provider.name,
          cost
        };
      } catch (error) {
        aiDebug.warn(`Provider ${provider.name} failed, trying next...`);
        this.providerStatus.set(provider.name, false);
      }
    }

    throw new Error('All AI providers failed');
  }

  getAvailableProviders(): string[] {
    return this.providers
      .filter(provider => this.providerStatus.get(provider.name) === true)
      .map(provider => provider.name);
  }

  getProviderStatus(): { [key: string]: boolean } {
    const status: { [key: string]: boolean } = {};
    this.providers.forEach(provider => {
      status[provider.name] = this.providerStatus.get(provider.name) || false;
    });
    return status;
  }
}

// Singleton instance
let multiProviderService: MultiProviderAIService | null = null;

export const getMultiProviderAIService = (): MultiProviderAIService => {
  if (!multiProviderService) {
    multiProviderService = new MultiProviderAIService();
  }
  return multiProviderService;
};

export const resetMultiProviderService = (): void => {
  multiProviderService = null;
};
