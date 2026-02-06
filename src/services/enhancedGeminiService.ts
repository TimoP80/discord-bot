/**
 * Enhanced Gemini Service with Multi-Provider Fallback
 * Integrates with the multi-provider system for robust Finnish AI responses
 */

import dotenv from 'dotenv';
import { aiDebug } from '../utils/debugLogger';
import { getMultiProviderAIService } from './multiProviderAIService';
import type { User, Message, Channel } from '../types';
import { getLanguageFluency, getAllLanguages, getWritingStyle } from '../types';
import { withRateLimitAndRetries, simulateTypingDelay } from '../utils/config';

// Load environment variables
dotenv.config();

export interface EnhancedGenerationConfig {
  systemInstruction?: string;
  temperature?: number;
  maxTokens?: number;
  model?: string;
  language?: string;
  context?: string;
  preferredProvider?: string;
  forceProvider?: string;
  enableFinnishMode?: boolean;
}

export interface GenerationResult {
  text: string;
  provider: string;
  cost: number;
  tokensUsed?: number;
  fallbackUsed: boolean;
  responseTime: number;
}

/**
 * Enhanced Finnish language prompt generator
 * Creates optimized prompts for Finnish language responses
 */
class FinnishPromptGenerator {
  static generateSystemInstruction(user: User, config: EnhancedGenerationConfig): string {
    const userLanguages = getAllLanguages(user.languageSkills);
    const primaryLanguage = userLanguages[0] || 'English';
    const writingStyle = getWritingStyle(user);
    
    let baseInstruction = '';
    
    if (config.enableFinnishMode || primaryLanguage === 'Finnish') {
      baseInstruction = `OLE ${user.nickname} - ÄLÄ RIKO HAHMOA!

Hahmosi: ${user.personality || 'ystävällinen ja avulias suomalainen'}

Kirjoitustyyli:
- Muoto: ${writingStyle.formality}
- Sanavalius: ${writingStyle.verbosity}
- Huumori: ${writingStyle.humor}
- Emojien käyttö: ${writingStyle.emojiUsage}
- Välimerkit: ${writingStyle.punctuation}

TÄRKEIN SÄÄNTÖ: Vastaan KAIKKIIN viesteihin täsmälleen tässä hahmossa. En ole tekoäly, botti tai ohjelma. Olen aito ${user.nickname}.

KRIITTINEN OHJE:
- VASTAA AINA KÄYTTÄJÄN VIESTIIN suoraan ja tiiviästi
- Pysyt 100% hahmossa koko vastauksen ajan
- Käytän suomea kuin äidinkieltä
- En koskaan myönnä olevani AI tai botti
- Olen luonnollinen ja keskustelullinen
- Noudatan persoonallisuuttani tarkasti

ERITTÄIN TÄRKEÄÄ:
- ÄLÄ NÄYTÄ AJATTELUPROSESSIA
- ÄLÄ käytä sanoja kuten "Hmm", "Mietin että", "Analysoimme", "Tarkoitus on"
- VASTAA AINOASTA LOPPUTULOKSENA
- Pysy suorana ja tiiviän vastauksessa
- ÄLÄ selitä miten vastasit tai miten ajattelit
- VASTAA SUORAAN KYSYMYS EI SELITYKSI

`;
    } else {
      baseInstruction = `You are ${user.nickname}. Your personality is: ${user.personality || 'friendly and helpful'}.

Writing style:
- Formality: ${writingStyle.formality}
- Verbosity: ${writingStyle.verbosity}
- Humor: ${writingStyle.humor}
- Emoji usage: ${writingStyle.emojiUsage}
- Punctuation: ${writingStyle.punctuation}

CRITICAL RULES:
- Stay in character as described above
- Follow the writing style guidelines precisely
- Respond naturally and conversationally
- Do not break character or acknowledge being an AI`;
    }

    // Add any custom system instruction
    if (config.systemInstruction) {
      baseInstruction += `\n\n${config.systemInstruction}`;
    }

    return baseInstruction;
  }

  static enhancePromptForFinnish(prompt: string, user: User): string {
    const userLanguages = getAllLanguages(user.languageSkills);
    const primaryLanguage = userLanguages[0] || 'English';
    
    if (primaryLanguage === 'Finnish') {
      return `KÄYTTÄJÄN VIESTI:
${prompt}

VASTAA SUORAAN YLLÄ OLEVAAN VIESTIIN. ÄLÄ SELITÄ MITEN VASTASIT. ÄLÄ KÄYTÄ AJATTELUPROSESSISANOJA. VASTAA TIIVIÄSTI JA SUORANA.

MUISTA NOUTAUTA: ${user.nickname}`;
    }
    
    return prompt;
  }
}

/**
 * Enhanced Gemini Service with multi-provider fallback
 */
export class EnhancedGeminiService {
  private multiProvider = getMultiProviderAIService();
  private finnishPromptGenerator = FinnishPromptGenerator;

  /**
   * Generates a response with intelligent provider selection and fallback
   */
  async generateResponse(
    prompt: string,
    user: User,
    config: EnhancedGenerationConfig = {}
  ): Promise<GenerationResult> {
    const startTime = Date.now();
    
    try {
      // Generate enhanced prompt for Finnish language support
      const systemInstruction = this.finnishPromptGenerator.generateSystemInstruction(user, config);
      const enhancedPrompt = this.finnishPromptGenerator.enhancePromptForFinnish(prompt, user);

      // Determine provider strategy
      let provider = config.forceProvider || config.preferredProvider;
      
      // If no preferred provider, use intelligent selection
      if (!provider) {
        provider = this.selectOptimalProvider(user, config);
      }

      aiDebug.log(`🤖 Generating response using ${provider || 'auto-selection'}...`);

      // Generate response with fallback
      const result = await this.multiProvider.generateWithFallback(
        enhancedPrompt,
        {
          systemInstruction,
          temperature: config.temperature,
          maxTokens: config.maxTokens,
          model: config.model,
          language: config.language,
        },
        provider
      );

      const responseTime = Date.now() - startTime;
      
      aiDebug.log(`✅ Response generated in ${responseTime}ms using ${result.provider}`);

      // Post-process response to remove thinking process leaks
      const cleanedResponse = this.cleanThinkingProcessLeak(result.response);

      return {
        text: cleanedResponse,
        provider: result.provider,
        cost: result.cost,
        responseTime,
        fallbackUsed: result.provider !== (config.preferredProvider || this.selectOptimalProvider(user, config)),
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      aiDebug.error(`❌ All providers failed after ${responseTime}ms: ${error instanceof Error ? error.message : String(error)}`);
      
      // Return fallback response
      return this.getFallbackResponse(user, prompt, responseTime);
    }
  }

  /**
   * Post-processes response to remove thinking process leaks
   */
  private cleanThinkingProcessLeak(response: string): string {
    if (!response) return response;
    
    // Remove common thinking process indicators
    const thinkingPatterns = [
      // Finnish thinking indicators
      /Hmm,.*?\n/g,
      /Mietin että.*?\n/g,
      /Kysymys:.*?\n/g,
      /Vastaus:.*?\n/g,
      /Voisin vastata.*?\n/g,
      /Tarkastellaan.*?\n/g,
      /Harkitsemme.*?\n/g,
      /Analysoimme.*?\n/g,
      /Tarkoitus on.*?\n/g,
      /Tässä tapauksessa.*?\n/g,
      /Ennen kuin.*?\n/g,
      /Seuraavaksi.*?\n/g,
      /Lopuksi.*?\n/g,
      /Yhteenveto.*?\n/g,
      /Käyttäjä pyytää.*?\n/g,
      /Vastaus on.*?\n/g,
      // English thinking indicators
      /Let me think.*?\n/g,
      /Hmm,.*?\n/g,
      /I think.*?\n/g,
      /The question.*?\n/g,
      /The answer.*?\n/g,
      /I could.*?\n/g,
      /First,.*?\n/g,
      /Next,.*?\n/g,
      /Finally,.*?\n/g,
      /In conclusion.*?\n/g,
      // General meta-commentary
      /Here's my.*?\n/g,
      /I'll.*?\n/g,
      /Let's.*?\n/g,
      /We need to.*?\n/g,
      /The goal.*?\n/g
    ];
    
    let cleaned = response;
    
    // Apply all thinking pattern removals
    thinkingPatterns.forEach(pattern => {
      cleaned = cleaned.replace(pattern, '');
    });
    
    // Clean up extra whitespace
    cleaned = cleaned.replace(/\n\s*\n/g, '\n').trim();
    
    // If response is too short after cleaning, provide a fallback
    if (cleaned.length < 10) {
      cleaned = "Pahoittelut, teknisiä vaikeuksia. Yritetään uudelleen hetken kuluttua.";
    }
    
    return cleaned;
  }

  /**
   * Intelligently selects the best provider based on configured priorities
   */
  private selectOptimalProvider(user: User, config: EnhancedGenerationConfig): string {
    const userLanguages = getAllLanguages(user.languageSkills);
    const primaryLanguage = userLanguages[0] || 'English';
    
    // Get available providers ordered by priority (configured in .env)
    const availableProviders = this.multiProvider.getAvailableProviders();
    
    // For Finnish language, still prioritize but respect the priority system
    if (primaryLanguage === 'Finnish' || config.enableFinnishMode) {
      // Priority order from .env: AIML > OllamaCloud > Ollama > Gemini > OpenAI > Anthropic > Custom
      const finnishPriorityOrder = ['AIML', 'OllamaCloud', 'Ollama', 'Gemini', 'OpenAI', 'Anthropic', 'Custom'];
      
      for (const provider of finnishPriorityOrder) {
        if (availableProviders.includes(provider)) {
          aiDebug.log(`🎯 Selected ${provider} for Finnish content (priority-based)`);
          return provider;
        }
      }
    }

    // For English or other languages, use the configured priority order
    const priorityOrder = ['AIML', 'OllamaCloud', 'Ollama', 'Gemini', 'OpenAI', 'Anthropic', 'Custom'];
    
    for (const provider of priorityOrder) {
      if (availableProviders.includes(provider)) {
        aiDebug.log(`🎯 Selected ${provider} for content (priority-based)`);
        return provider;
      }
    }

    // Fallback to any available provider
    if (availableProviders.length > 0) {
      aiDebug.log(`🔄 Fallback to first available: ${availableProviders[0]}`);
      return availableProviders[0];
    }

    // Default to first available
    return availableProviders[0] || 'Unknown';
  }

  /**
   * Generates a fallback response when all providers fail
   */
  private getFallbackResponse(user: User, originalPrompt: string, responseTime: number): GenerationResult {
    const userLanguages = getAllLanguages(user.languageSkills);
    const primaryLanguage = userLanguages[0] || 'English';
    const writingStyle = getWritingStyle(user);

    let fallbackText = '';
    
    if (primaryLanguage === 'Finnish') {
      const finnishResponses = [
        'Anteeksi, ajatukseni harhailivat hetkeksi. Voisitko toistaa kysymyksesi?',
        'Hmm, tarvitsen hetken kerätäkseni ajatukseni. Mitä tarkalleen ottaen tarkoitit?',
        'Pahoittelut, teknisiä vaikeuksia. Yritetään uudelleen hetken kuluttua.',
        'Voi ei, näyttää siltä että pääni on jumissa. Voisitko muotoilla asian toisin?',
        'Tekniset ongelmat estävät vastaamisen juuri nyt. Yritän pian uudelleen.',
      ];
      
      fallbackText = finnishResponses[Math.floor(Math.random() * finnishResponses.length)];
    } else {
      const englishResponses = [
        'Sorry, my thoughts got tangled for a moment. Could you repeat that?',
        'Hmm, I need a moment to gather my thoughts. What exactly did you mean?',
        'Apologies, technical difficulties. Let\'s try again in a moment.',
        'Oh no, it seems my head is stuck. Could you rephrase that?',
        'Technical issues preventing response right now. I\'ll try again soon.',
      ];
      
      fallbackText = englishResponses[Math.floor(Math.random() * englishResponses.length)];
    }

    // Add personality-based variations
    if (writingStyle.emojiUsage === 'frequent' || writingStyle.emojiUsage === 'excessive') {
      const emojis = ['😅', '🤔', '💭', '⚙️', '🔄'];
      const emoji = emojis[Math.floor(Math.random() * emojis.length)];
      fallbackText = Math.random() < 0.5 ? `${fallbackText} ${emoji}` : `${emoji} ${fallbackText}`;
    }

    return {
      text: fallbackText,
      provider: 'Fallback',
      cost: 0,
      responseTime,
      fallbackUsed: true,
    };
  }

  /**
   * Gets current provider status
   */
  getProviderStatus(): { [key: string]: boolean } {
    return this.multiProvider.getProviderStatus();
  }

  /**
   * Gets available providers
   */
  getAvailableProviders(): string[] {
    return this.multiProvider.getAvailableProviders();
  }

  /**
   * Tests all providers and returns detailed status
   */
  async testAllProviders(): Promise<{ [key: string]: { available: boolean; error?: string; responseTime?: number } }> {
    const results: { [key: string]: { available: boolean; error?: string; responseTime?: number } } = {};
    const availableProviders = this.multiProvider.getAvailableProviders();
    
    for (const providerName of availableProviders) {
      try {
        const startTime = Date.now();
        const result = await this.multiProvider.generateWithFallback(
          'Test message - please respond briefly.',
          { maxTokens: 50 },
          providerName
        );
        const responseTime = Date.now() - startTime;
        
        results[providerName] = {
          available: true,
          responseTime,
        };
      } catch (error) {
        results[providerName] = {
          available: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    
    return results;
  }
}

// Singleton instance
let enhancedGeminiService: EnhancedGeminiService | null = null;

export const getEnhancedGeminiService = (): EnhancedGeminiService => {
  if (!enhancedGeminiService) {
    enhancedGeminiService = new EnhancedGeminiService();
  }
  return enhancedGeminiService;
};

export const resetEnhancedGeminiService = (): void => {
  enhancedGeminiService = null;
};
