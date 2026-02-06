import * as googleTTS from 'google-tts-api';
import { aiDebug } from '../utils/debugLogger';
import axios from 'axios';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { getOpenAIConfig, generateSpeechWithOpenAI } from './openAIService';

export class AudioService {
    private elevenLabsClient: ElevenLabsClient | null = null;

    constructor() {
        const apiKey = process.env.ELEVENLABS_API_KEY;
        aiDebug.log('🔧 Initializing ElevenLabs client...');

        if (apiKey) {
            const trimmedKey = apiKey.trim();
            aiDebug.log(`✅ ElevenLabs API key found (length: ${trimmedKey.length}, starts with: ${trimmedKey.substring(0, 8)}...)`);

            try {
                this.elevenLabsClient = new ElevenLabsClient({
                    apiKey: trimmedKey
                });
                aiDebug.log('✅ ElevenLabs client initialized successfully');
            } catch (error) {
                aiDebug.error('❌ Failed to initialize ElevenLabs client:', error);
                this.elevenLabsClient = null;
            }
        } else {
            aiDebug.warn('⚠️ ElevenLabs API key not found in environment variables (ELEVENLABS_API_KEY)');
            aiDebug.warn('   Audio generation will fall back to Google TTS');
        }
    }

    /**
     * Generates a TTS audio buffer from the provided text.
     * @param text The text to convert to speech.
     * @param lang The language code (default: 'en').
     * @param slow Whether to speak slowly (default: false).
     * @param voiceId Optional ElevenLabs voice ID.
     * @param useElevenLabsFallback Whether to use ElevenLabs as fallback for AI messages (default: false).
     * @returns A Promise resolving to a Buffer containing the audio data.
     */
    public async generateTTS(text: string, lang: string = 'en', slow: boolean = false, voiceId?: string, useElevenLabsFallback: boolean = false): Promise<Buffer> {
        try {
            aiDebug.log(`Generating TTS for text: "${text.substring(0, 50)}..." (lang: ${lang}, voiceId: ${voiceId || 'none'})`);

            // Check for ElevenLabs configuration
            if (voiceId && this.elevenLabsClient) {
                try {
                    aiDebug.log(`Using ElevenLabs TTS with voice ID: ${voiceId}`);

                    // Use configured model or default to turbo v2.5
                    const modelId = process.env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2_5';
                    aiDebug.log(`Using ElevenLabs model: ${modelId}`);

                    const audioStream = await this.elevenLabsClient.textToSpeech.convert(voiceId, {
                        text: text,
                        modelId: modelId,
                        voiceSettings: {
                            stability: 0.5,
                            similarityBoost: 0.75
                        }
                    });

                    // Convert stream to buffer
                    const chunks: Buffer[] = [];
                    for await (const chunk of audioStream) {
                        chunks.push(Buffer.from(chunk));
                    }
                    return Buffer.concat(chunks);

                } catch (elevenLabsError: any) {
                    aiDebug.error('ElevenLabs TTS failed, falling back to Google TTS:', elevenLabsError);
                    if (elevenLabsError.body) {
                        aiDebug.error('ElevenLabs error body:', elevenLabsError.body);
                    }
                    // Fallback to Google TTS proceeds below
                }
            }

            // google-tts-api returns a URL to the audio file
            const url = googleTTS.getAudioUrl(text, {
                lang: lang,
                slow: slow,
                host: 'https://translate.google.com',
            });

            aiDebug.log(`TTS URL generated: ${url}`);

            // Fetch the audio data from the URL
            const response = await axios.get(url, {
                responseType: 'arraybuffer',
            });

            return Buffer.from(response.data);
        } catch (googleTtsError) {
            aiDebug.error('Google TTS failed:', googleTtsError);

            // Try ElevenLabs as fallback for AI messages if enabled
            if (useElevenLabsFallback && this.elevenLabsClient) {
                try {
                    aiDebug.log('🔄 Attempting ElevenLabs fallback for AI message TTS');

                    // Use default voice or a fallback voice ID
                    const fallbackVoiceId = voiceId || process.env.ELEVENLABS_DEFAULT_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // Default ElevenLabs voice

                    aiDebug.log(`Using ElevenLabs fallback with voice ID: ${fallbackVoiceId}`);

                    const modelId = process.env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2_5';
                    aiDebug.log(`Using ElevenLabs model: ${modelId}`);

                    const audioStream = await this.elevenLabsClient.textToSpeech.convert(fallbackVoiceId, {
                        text: text,
                        modelId: modelId,
                        voiceSettings: {
                            stability: 0.5,
                            similarityBoost: 0.75
                        }
                    });

                    // Convert stream to buffer
                    const chunks: Buffer[] = [];
                    for await (const chunk of audioStream) {
                        chunks.push(Buffer.from(chunk));
                    }

                    aiDebug.log('✅ ElevenLabs fallback successful');
                    return Buffer.concat(chunks);

                } catch (elevenLabsError: any) {
                    aiDebug.error('ElevenLabs fallback also failed:', elevenLabsError);
                    // Continue to throw the original error
                }
            }

            // Try OpenAI TTS as final fallback if enabled
            try {
                aiDebug.log('🔄 Attempting OpenAI TTS as final fallback');

                const openaiConfig = getOpenAIConfig();
                if (openaiConfig.enabled && openaiConfig.apiKey) {
                    // Map language codes to OpenAI voice preferences
                    const voice = lang.startsWith('en') ? 'alloy' : 'nova'; // alloy for English, nova for others
                    const model = 'tts-1'; // Use standard quality model

                    const audioBuffer = await generateSpeechWithOpenAI(text, openaiConfig, voice, model);
                    aiDebug.log('✅ OpenAI TTS fallback successful');
                    return audioBuffer;
                } else {
                    aiDebug.warn('⚠️ OpenAI TTS not available (API key not configured)');
                }
            } catch (openaiError: any) {
                aiDebug.error('OpenAI TTS fallback also failed:', openaiError);
                // Continue to throw the original error
            }

            throw new Error('Failed to generate TTS audio.');
        }
    }

    /**
     * Retrieves the list of available voices from ElevenLabs.
     * @returns A Promise resolving to an array of voice objects.
     */
    public async getElevenLabsVoices(): Promise<any[]> {
        if (!this.elevenLabsClient) {
            aiDebug.warn('ElevenLabs client not initialized (missing API key).');
            return [];
        }

        try {
            const response = await this.elevenLabsClient.voices.getAll();
            return response.voices;
        } catch (error: any) {
            aiDebug.error('Error retrieving ElevenLabs voices:', error);
            return [];
        }
    }
}

export const audioService = new AudioService();
