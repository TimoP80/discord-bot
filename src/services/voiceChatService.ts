import { aiDebug } from '../utils/debugLogger';
import { voiceService } from './voiceService';
import { speechToTextService } from './speechToTextService';
import { audioService } from './audioService';
import type { User, Channel, Message, UserContentMessage } from '../types';
import { generateChannelActivity } from '../geminiService';

/**
 * Voice chat session for a guild
 */
interface VoiceSession {
    guildId: string;
    channelId: string;
    channelName: string;
    activeBotPersonality: User | null;
    conversationHistory: Array<{ speaker: string; text: string; timestamp: Date }>;
    isListening: boolean;
    isProcessing: boolean;
    currentContext?: string;
}

/**
 * Service for orchestrating voice chat interactions
 */
export class VoiceChatService {
    private sessions: Map<string, VoiceSession> = new Map();
    private readonly MAX_HISTORY = 10; // Keep last 10 voice messages in context
    private readonly VOICE_MODEL = process.env.VOICE_AI_MODEL || 'gemini-2.0-flash';

    /**
     * Start a voice chat session
     */
    public async startSession(
        guildId: string,
        channelId: string,
        channelName: string,
        botPersonality: User | null = null
    ): Promise<void> {
        aiDebug.log(`🎤 Starting voice chat session in guild ${guildId}, channel ${channelName}`);

        const session: VoiceSession = {
            guildId,
            channelId,
            channelName,
            activeBotPersonality: botPersonality,
            conversationHistory: [],
            isListening: true,
            isProcessing: false,
            currentContext: undefined
        };

        this.sessions.set(guildId, session);

        // Start listening for audio
        voiceService.startReceiving(guildId, async (audioBuffer, userId) => {
            await this.handleUserSpeech(guildId, audioBuffer, userId);
        });

        aiDebug.log(`✅ Voice chat session started for guild ${guildId}`);
    }

    /**
     * Stop a voice chat session
     */
    public stopSession(guildId: string): void {
        aiDebug.log(`🛑 Stopping voice chat session for guild ${guildId}`);

        voiceService.stopReceiving(guildId);
        this.sessions.delete(guildId);

        aiDebug.log(`✅ Voice chat session stopped for guild ${guildId}`);
    }

    /**
     * Handle user speech input
     */
    private async handleUserSpeech(guildId: string, audioBuffer: Buffer, userId: string): Promise<void> {
        const session = this.sessions.get(guildId);
        if (!session || !session.isListening) {
            return;
        }

        // Prevent concurrent processing
        if (session.isProcessing) {
            aiDebug.log(`🔒 Ignored speech from ${userId}: already processing another request`);
            return;
        }

        session.isProcessing = true;

        console.log(`[VOICE] 🎙️ Processing speech from user ${userId} in guild ${guildId}`);
        aiDebug.log(`🎙️ Processing speech from user ${userId} in guild ${guildId}`);

        try {
            // Step 1: Convert speech to text
            console.log(`[VOICE] 📡 Sending ${audioBuffer.length} bytes to STT service...`);
            const transcript = await speechToTextService.transcribe(audioBuffer);

            if (!transcript || transcript.trim().length === 0) {
                aiDebug.warn(`⚠️ Empty transcription for user ${userId}`);
                return;
            }

            aiDebug.log(`📝 Transcribed: "${transcript}" from user ${userId}`);
            console.log(`[VOICE] 📝 Transcribed: "${transcript}" from user ${userId}`);

            // Add to conversation history
            session.conversationHistory.push({
                speaker: userId,
                text: transcript,
                timestamp: new Date()
            });

            // Trim history to max length
            if (session.conversationHistory.length > this.MAX_HISTORY) {
                session.conversationHistory = session.conversationHistory.slice(-this.MAX_HISTORY);
            }

            // Step 2: Generate AI response
            const aiResponse = await this.generateVoiceResponse(session, transcript);

            if (!aiResponse || aiResponse.trim().length === 0) {
                aiDebug.warn(`⚠️ Empty AI response for guild ${guildId}`);
                return;
            }

            aiDebug.log(`🤖 AI response: "${aiResponse}"`);
            console.log(`[VOICE] 🤖 AI response: "${aiResponse}"`);

            // Add AI response to history
            session.conversationHistory.push({
                speaker: session.activeBotPersonality?.nickname || 'Bot',
                text: aiResponse,
                timestamp: new Date()
            });

            // Step 3: Convert response to speech
            const voiceId = this.getVoiceIdForBot(session.activeBotPersonality);
            const audioResponseBuffer = await audioService.generateTTS(aiResponse, 'en', false, voiceId, true); // Enable ElevenLabs fallback for AI messages

            // Step 4: Play audio response
            // The playAudio function now waits for playback to finish
            await voiceService.playAudio(guildId, audioResponseBuffer);

            aiDebug.log(`✅ Voice response delivered for guild ${guildId}`);

        } catch (error) {
            console.error(`[VOICE] ❌ Error handling user speech in guild ${guildId}:`, error);
            aiDebug.error(`❌ Error handling user speech in guild ${guildId}:`, error);

            // Log specific error details
            if (error instanceof Error) {
                console.error(`[VOICE] Error message: ${error.message}`);
                console.error(`[VOICE] Error stack: ${error.stack}`);
            }
        } finally {
            // Release lock
            session.isProcessing = false;
        }
    }

    /**
     * Generate AI response for voice chat
     */
    private async generateVoiceResponse(session: VoiceSession, userMessage: string): Promise<string> {
        const botPersonality = session.activeBotPersonality;

        // Build conversation context
        const conversationContext = session.conversationHistory
            .map(msg => `${msg.speaker}: ${msg.text}`)
            .join('\n');

        // Get configured language
        const sttConfig = speechToTextService.getConfig();
        const language = sttConfig.language || 'en-US';

        // Create voice-optimized prompt
        const prompt = `You are in a voice conversation in Discord channel "${session.channelName}".
${botPersonality ? `You are roleplaying as ${botPersonality.nickname}, whose personality is: ${botPersonality.personality}` : 'You are a helpful AI assistant.'}
${session.currentContext ? `\nCURRENT STATUS/ACTIVITY: ${session.currentContext}\nAct as if you are participating in this activity with the user.` : ''}

Recent conversation:
${conversationContext}

User just said: "${userMessage}"

CRITICAL VOICE CHAT INSTRUCTIONS:
- You MUST reply in the language: ${language}
- Keep your response SHORT and CONVERSATIONAL (1-3 sentences max)
- Speak naturally as if talking, not writing
- Avoid complex formatting, lists, or long explanations
- Be engaging and responsive
- Match the casual tone of voice chat
${botPersonality ? `- Stay in character as ${botPersonality.nickname}` : ''}

Generate a brief, natural spoken response:`;

        try {
            const response = await this.generateSimpleResponse(prompt, session);

            // Clean up response for voice (remove markdown, etc.)
            const cleanedResponse = this.cleanResponseForVoice(response);

            return cleanedResponse;
        } catch (error) {
            aiDebug.error('❌ Error generating voice response:', error);
            return 'Sorry, I had trouble processing that.';
        }
    }

    /**
     * Generate AI response via Gemini service using the main channel activity generator
     */
    private async generateSimpleResponse(prompt: string, session?: VoiceSession): Promise<string> {
        // If session is provided, use it to construct proper context for generateChannelActivity
        if (session && session.activeBotPersonality) {
            try {
                console.log('[VOICE] 🤖 Generating AI response with main Gemini service...');

                // Map conversation history to Message format expected by geminiService
                const mappedMessages: Message[] = session.conversationHistory.map((msg, index) => {
                    const isBot = msg.speaker === session.activeBotPersonality?.nickname;

                    return {
                        id: index, // Simple index-based ID
                        type: isBot ? 'ai' : 'user',
                        nickname: msg.speaker,
                        content: msg.text,
                        timestamp: msg.timestamp,
                        isTyping: false
                    } as UserContentMessage;
                });

                // Construct a mock channel object
                const mockChannel: Channel = {
                    name: session.channelName,
                    topic: 'Voice Chat',
                    users: [session.activeBotPersonality], // Add the bot so it can be selected!
                    messages: mappedMessages,
                    operators: []
                };

                // Use the centralized AI service to generate a response
                // We pass "User" as the "currentUserNickname" so the bot is NOT filtered out
                // (generateChannelActivity excludes the currentUserNickname from potential speakers)
                const response = await generateChannelActivity(
                    mockChannel,
                    'User',
                    this.VOICE_MODEL
                );

                if (!response) {
                    throw new Error('Empty response from AI service');
                }

                console.log(`[VOICE] ✅ Gemini response generated (${response.length} chars)`);
                return response;

            } catch (error) {
                console.error('[VOICE] ❌ Error with Gemini service:', error);
                aiDebug.error('Error with Gemini service:', error);
                return "That's interesting! Tell me more.";
            }
        }

        // Fallback for when session is not passed (legacy/testing)
        try {
            console.log('[VOICE] ⚠️ Generating response with simplified logic (no session context)...');

            // Use the centralized AI service (supports Vertex AI & API Key)
            const { getAIService } = await import('./vertexAIService');
            const ai = getAIService();

            // Using the new @google/genai SDK syntax
            const response = await ai.models.generateContent({
                model: this.VOICE_MODEL,
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                config: {
                    temperature: 0.7,
                }
            });

            // Handle response format from @google/genai
            const responseAny = response as any;
            let responseText = '';

            if (typeof responseAny.text === 'function') {
                responseText = responseAny.text();
            } else if (typeof responseAny.text === 'string') {
                responseText = responseAny.text;
            } else {
                responseText = responseAny.candidates?.[0]?.content?.parts?.[0]?.text || '';
            }

            if (!responseText) {
                throw new Error('Empty response from AI service');
            }

            console.log(`[VOICE] ✅ Gemini response generated (${responseText.length} chars)`);
            return responseText;
        } catch (error) {
            console.error('[VOICE] ❌ Error with Gemini:', error);
            aiDebug.error('Error with Gemini:', error);
            return "That's interesting! Tell me more.";
        }
    }

    /**
     * Clean AI response for voice output
     */
    private cleanResponseForVoice(text: string): string {
        return text
            .replace(/\*\*/g, '') // Remove bold markdown
            .replace(/\*/g, '')   // Remove italic markdown
            .replace(/`/g, '')    // Remove code markers
            .replace(/\n+/g, ' ') // Replace newlines with spaces
            .replace(/\s+/g, ' ') // Normalize whitespace
            .trim();
    }

    /**
     * Get ElevenLabs voice ID for a bot personality
     */
    private getVoiceIdForBot(botPersonality: User | null): string | undefined {
        if (!botPersonality) {
            return undefined;
        }

        // First, check if the user has a voice ID configured directly
        if (botPersonality.elevenLabsVoiceId) {
            aiDebug.log(`🎤 Using ElevenLabs voice ID for ${botPersonality.nickname}: ${botPersonality.elevenLabsVoiceId.substring(0, 8)}...`);
            return botPersonality.elevenLabsVoiceId;
        }

        // Fallback: Check environment variable mapping (legacy support)
        const voiceMapping = process.env.BOT_VOICE_MAPPING;
        if (voiceMapping) {
            try {
                const mapping = JSON.parse(voiceMapping);
                const voiceId = mapping[botPersonality.nickname];
                if (voiceId) {
                    aiDebug.log(`🎤 Using ElevenLabs voice ID from env mapping for ${botPersonality.nickname}`);
                    return voiceId;
                }
            } catch (error) {
                aiDebug.warn('⚠️ Failed to parse BOT_VOICE_MAPPING:', error);
            }
        }

        aiDebug.warn(`⚠️ No ElevenLabs voice ID configured for ${botPersonality.nickname}, using default voice`);
        return undefined;
    }

    /**
     * Set the active bot personality for a session
     */
    public setBotPersonality(guildId: string, botPersonality: User): void {
        const session = this.sessions.get(guildId);
        if (session) {
            session.activeBotPersonality = botPersonality;
            aiDebug.log(`🤖 Set bot personality to ${botPersonality.nickname} for guild ${guildId}`);
        }
    }

    /**
     * Toggle listening state
     */
    public toggleListening(guildId: string): boolean {
        const session = this.sessions.get(guildId);
        if (session) {
            session.isListening = !session.isListening;
            aiDebug.log(`🎧 Listening ${session.isListening ? 'enabled' : 'disabled'} for guild ${guildId}`);
            return session.isListening;
        }
        return false;
    }

    /**
     * Get session info
     */
    public getSession(guildId: string): VoiceSession | undefined {
        return this.sessions.get(guildId);
    }

    /**
     * Set the current context/activity for the session
     */
    public setContext(guildId: string, context: string): void {
        const session = this.sessions.get(guildId);
        if (session) {
            session.currentContext = context;
            aiDebug.log(`📝 Set voice chat context for guild ${guildId} to: "${context}"`);
        }
    }

    /**
     * Check if session exists
     */
    public hasSession(guildId: string): boolean {
        return this.sessions.has(guildId);
    }
}

export const voiceChatService = new VoiceChatService();
