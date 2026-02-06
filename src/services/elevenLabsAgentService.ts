import { aiDebug } from '../utils/debugLogger';
import axios, { AxiosInstance } from 'axios';

export interface ElevenLabsAgent {
    id: string;
    name: string;
    systemPrompt: string;
    language?: string;
    voiceId?: string;
    personality?: string;
}

export interface AgentMessage {
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
}

export interface AgentConversation {
    agentId: string;
    messages: AgentMessage[];
    language: string;
}

/**
 * Service for interacting with ElevenLabs Agent Platform
 */
export class ElevenLabsAgentService {
    private client: AxiosInstance | null = null;
    private readonly baseURL = 'https://api.elevenlabs.io/v1';
    private conversations: Map<string, AgentConversation> = new Map();
    private agents: Map<string, ElevenLabsAgent> = new Map();

    constructor() {
        this.initializeClient();
    }

    /**
     * Initialize the ElevenLabs API client
     */
    private initializeClient(): void {
        const apiKey = process.env.ELEVENLABS_API_KEY;

        if (!apiKey) {
            aiDebug.warn('⚠️ ElevenLabs API key not found. Agent Platform features will be disabled.');
            return;
        }

        this.client = axios.create({
            baseURL: this.baseURL,
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'xi-api-key': apiKey.trim()
            },
            timeout: 30000
        });

        aiDebug.log('✅ ElevenLabs Agent Platform client initialized');
    }

    /**
     * Check if the service is configured and ready
     */
    public isConfigured(): boolean {
        return this.client !== null;
    }

    /**
     * Create a new conversational agent
     */
    public async createAgent(config: {
        name: string;
        systemPrompt: string;
        language?: string;
        voiceId?: string;
        personality?: string;
    }): Promise<ElevenLabsAgent | null> {
        // Allow creating agents even without API key for testing/demo purposes
        // In production, this would require API key for full functionality

        try {
            aiDebug.log(`🤖 Creating ElevenLabs agent: ${config.name}`);

            // For now, create a local agent configuration
            // In a real implementation, this would call the ElevenLabs API to create an agent
            const agent: ElevenLabsAgent = {
                id: `agent_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                name: config.name,
                systemPrompt: config.systemPrompt,
                language: config.language || 'en',
                voiceId: config.voiceId,
                personality: config.personality
            };

            aiDebug.log(`   Agent ID: ${agent.id}`);
            this.agents.set(agent.id, agent);
            aiDebug.log(`   Agent stored, total agents: ${this.agents.size}`);

            // Initialize conversation history
            this.conversations.set(agent.id, {
                agentId: agent.id,
                messages: [],
                language: agent.language || 'en'
            });

            aiDebug.log(`✅ Created agent: ${agent.name} (${agent.id})`);
            return agent;

        } catch (error) {
            aiDebug.error('❌ Failed to create ElevenLabs agent:', error);
            return null;
        }
    }

    /**
     * Get an agent by ID
     */
    public getAgent(agentId: string): ElevenLabsAgent | null {
        return this.agents.get(agentId) || null;
    }

    /**
     * List all agents
     */
    public getAllAgents(): ElevenLabsAgent[] {
        return Array.from(this.agents.values());
    }

    /**
     * Send a message to an agent and get response
     */
    public async converseWithAgent(
        agentId: string,
        userMessage: string,
        userId?: string,
        language?: string
    ): Promise<string | null> {
        // Allow conversations even without API key for testing/demo purposes
        // In production, this would require API key for full functionality

        const agent = this.getAgent(agentId);
        if (!agent) {
            aiDebug.error(`❌ Agent not found: ${agentId}`);
            return null;
        }

        const conversation = this.conversations.get(agentId);
        if (!conversation) {
            aiDebug.error(`❌ Conversation not found for agent: ${agentId}`);
            return null;
        }

        try {
            aiDebug.log(`💬 Sending message to agent ${agent.name}: "${userMessage.substring(0, 50)}..."`);

            // Add user message to conversation history
            conversation.messages.push({
                role: 'user',
                content: userMessage,
                timestamp: new Date()
            });

            // For now, we'll simulate agent response using a simple approach
            // In a real implementation, this would call the ElevenLabs Agent Platform API
            const response = await this.generateAgentResponse(agent, conversation, userMessage, language);

            if (response) {
                // Add agent response to conversation history
                conversation.messages.push({
                    role: 'assistant',
                    content: response,
                    timestamp: new Date()
                });

                // Limit conversation history to prevent memory issues
                if (conversation.messages.length > 50) {
                    conversation.messages = conversation.messages.slice(-50);
                }

                aiDebug.log(`✅ Agent ${agent.name} responded: "${response.substring(0, 50)}..."`);
                return response;
            }

            return null;

        } catch (error) {
            aiDebug.error('❌ Failed to converse with ElevenLabs agent:', error);
            return null;
        }
    }

    /**
     * Generate a response from the agent (simplified implementation)
     * In a real implementation, this would call the ElevenLabs Agent Platform API
     */
    private async generateAgentResponse(
        agent: ElevenLabsAgent,
        conversation: AgentConversation,
        userMessage: string,
        language?: string
    ): Promise<string | null> {
        try {
            // Build conversation context
            const contextMessages = conversation.messages.slice(-10); // Last 10 messages for context
            const conversationText = contextMessages
                .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
                .join('\n');

            // Create a prompt for the agent
            const prompt = `${agent.systemPrompt}

Language: ${language || agent.language || 'en'}
Personality: ${agent.personality || 'friendly and helpful'}

Conversation History:
${conversationText}

User: ${userMessage}

Assistant:`;

            // For now, we'll use a fallback response since we don't have direct access to the Agent Platform API
            // In production, this would make an API call to ElevenLabs Agent Platform

            // Simple response generation based on the agent's personality
            const responses = this.generateFallbackResponse(agent, userMessage, language);
            return responses[Math.floor(Math.random() * responses.length)];

        } catch (error) {
            aiDebug.error('❌ Failed to generate agent response:', error);
            return null;
        }
    }

    /**
     * Generate fallback responses when Agent Platform API is not available
     */
    private generateFallbackResponse(agent: ElevenLabsAgent, userMessage: string, language?: string): string[] {
        const lang = language || agent.language || 'en';
        const personality = agent.personality?.toLowerCase() || 'friendly';

        // Language-specific responses
        if (lang === 'fi' || lang.startsWith('fi')) {
            return [
                "Hei! Kuinka voin auttaa sinua tänään?",
                "Mitä mieltä olet tästä aiheesta?",
                "Kiinnostavaa! Kerro lisää.",
                "Ymmärrän. Miten voin olla avuksi?",
                "Hauska keskustelu! Jatka ihmeessä."
            ];
        }

        // Personality-based responses
        if (personality.includes('professional')) {
            return [
                "I understand your point. How can I assist you further?",
                "That's an interesting perspective. Let me help you with that.",
                "Thank you for sharing. I'd be happy to provide more information.",
                "I appreciate your question. Here's what I can tell you:",
                "Let me address your concern directly."
            ];
        } else if (personality.includes('funny') || personality.includes('humorous')) {
            return [
                "Haha, that's a good one! What else is on your mind?",
                "You know, that's actually pretty hilarious. Tell me more!",
                "I love this conversation! You're keeping me on my toes.",
                "That's interesting! I haven't heard that one before.",
                "You're making me think here. That's a good thing!"
            ];
        } else {
            // Default friendly responses
            return [
                "That's interesting! Tell me more about that.",
                "I understand. How can I help you with this?",
                "Thanks for sharing! What are your thoughts on this?",
                "I appreciate you bringing this up. Let me see how I can assist.",
                "Great question! I'd be happy to discuss this further."
            ];
        }
    }

    /**
     * Clear conversation history for an agent
     */
    public clearConversation(agentId: string): void {
        const conversation = this.conversations.get(agentId);
        if (conversation) {
            conversation.messages = [];
            aiDebug.log(`🧹 Cleared conversation history for agent: ${agentId}`);
        }
    }

    /**
     * Delete an agent
     */
    public deleteAgent(agentId: string): void {
        this.agents.delete(agentId);
        this.conversations.delete(agentId);
        aiDebug.log(`🗑️ Deleted agent: ${agentId}`);
    }

    /**
     * Get conversation history for an agent
     */
    public getConversationHistory(agentId: string): AgentMessage[] {
        const conversation = this.conversations.get(agentId);
        return conversation ? [...conversation.messages] : [];
    }

    /**
     * Check if an agent supports a specific language
     */
    public agentSupportsLanguage(agentId: string, language: string): boolean {
        const agent = this.getAgent(agentId);
        if (!agent) return false;

        // For now, assume agents support common languages
        const supportedLanguages = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'ja', 'ko', 'zh', 'fi', 'sv', 'no', 'da'];
        return supportedLanguages.includes(language) || agent.language === language;
    }
}

// Export singleton instance
export const elevenLabsAgentService = new ElevenLabsAgentService();
