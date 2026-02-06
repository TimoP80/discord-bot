import { Client, Message, TextChannel } from 'discord.js';
import axios from 'axios';
import { aiDebug } from '../utils/debugLogger';

import { analyzeImageWithGemini, getBaseSystemInstruction } from '../geminiService';

/**
 * Service to watch a specific channel for gameplay screenshots and provide commentary
 */
class GameWatcherService {
    private watchChannelId: string | null = null;
    private isProcessing: boolean = false;
    private lastProcessedTime: number = 0;
    private readonly COOLDOWN_MS = 5000; // 5 seconds cooldown between comments

    /**
     * Initialize the service with the channel ID to watch
     * @param channelId The ID of the channel to watch
     */
    public initialize(channelId?: string) {
        // channelId passed from env or config
        this.watchChannelId = channelId || process.env.WATCH_CHANNEL_ID || null;

        if (this.watchChannelId) {
            aiDebug.log(`👀 GameWatcherService initialized. Watching channel ID: ${this.watchChannelId}`);
        } else {
            aiDebug.warn('⚠️ GameWatcherService initialized but no WATCH_CHANNEL_ID configured.');
        }
    }

    /**
     * Handle new messages in the watched channel
     * @param message The Discord message
     * @param botConfig The configuration of the bot instance handling this message
     */
    public async handleMessage(message: Message, botConfig?: any): Promise<void> {
        // Basic checks
        if (!this.watchChannelId || message.channel.id !== this.watchChannelId) return;
        if (message.author.bot && message.webhookId === null) return; // Ignore other bots, but ALLOW webhooks
        if (this.isProcessing) return;

        // Check for images
        const imageAttachment = message.attachments.find(att =>
            att.contentType?.startsWith('image/')
        );

        if (!imageAttachment) return;

        // Rate limit check
        const now = Date.now();
        if (now - this.lastProcessedTime < this.COOLDOWN_MS) {
            aiDebug.debug('⏳ GameWatcher cooldown active, skipping image.');
            return;
        }

        try {
            this.isProcessing = true;
            this.lastProcessedTime = now;
            if ('sendTyping' in message.channel) {
                await (message.channel as any).sendTyping();
            }

            aiDebug.log(`🎮 GameWatcher detected image in watched channel from ${message.author.username}`);

            // Download image
            const response = await axios.get(imageAttachment.url, { responseType: 'arraybuffer' });
            const imageBuffer = Buffer.from(response.data, 'binary');

            // Generate Prompt based on specific personality from config
            let systemInstruction = '';
            let primaryLanguage = 'English';

            if (botConfig && botConfig.personality) {
                systemInstruction = `You are roleplaying as ${botConfig.nickname || botConfig.name || 'a bot'}.\nPersonality: ${botConfig.personality}\n`;

                // Extract language from config if available
                if (botConfig.languageSkills && Array.isArray(botConfig.languageSkills) && botConfig.languageSkills.length > 0) {
                    // Parse language skills if they are in the "Language (Fluency)" format or just "Language"
                    const firstLang = botConfig.languageSkills[0];
                    primaryLanguage = firstLang.split('(')[0].trim();
                }
            } else {
                systemInstruction = getBaseSystemInstruction(message.author.username);
            }

            const prompt = `
${systemInstruction}

CONTEXT:
You are watching a live gameplay stream (via screenshots) of your friend playing a game.
You should act like a "backseat gamer" or a supportive co-op partner, depending on your personality.
Comment on what you see in the screenshot.
Keep it relatively short (1-2 sentences) and reactive.
React to the UI, the environment, enemies, or the score.
If it looks like a menu, ask what they are going to play or tweak.

CRITICAL: Respond ONLY in ${primaryLanguage}.

Analyze the image and provide your commentary.
`;

            // Analyze with Gemini (Multimodal)
            const mimeType = imageAttachment.contentType || 'image/jpeg';
            const commentary = await analyzeImageWithGemini(prompt, imageBuffer, mimeType);

            // Reply to the message
            await message.reply(commentary);
            aiDebug.log(`✅ GameWatcher commented: "${commentary.substring(0, 50)}..."`);

        } catch (error) {
            aiDebug.error(`❌ GameWatcher error: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            this.isProcessing = false;
        }
    }
}

export const gameWatcherService = new GameWatcherService();
