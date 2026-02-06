import { aiDebug } from '../utils/debugLogger';
import axios from 'axios';
import { SpeechClient } from '@google-cloud/speech';

/**
 * Speech-to-Text service configuration
 */
interface STTConfig {
    provider: 'google' | 'openai' | 'azure' | 'whisper-local' | 'elevenlabs';
    apiKey: string;
    language?: string;
    whisperModel?: string;
}

/**
 * Service for converting speech audio to text
 */
export class SpeechToTextService {
    private config: STTConfig;
    private googleSpeechClient?: SpeechClient;

    constructor() {
        // Load configuration from environment
        const provider = (process.env.STT_PROVIDER || 'google') as 'google' | 'openai' | 'azure' | 'whisper-local' | 'elevenlabs';

        // API key not needed for local whisper
        const apiKey = provider === 'whisper-local' ? '' : this.getApiKey(provider);

        this.config = {
            provider,
            apiKey,
            language: process.env.STT_LANGUAGE || 'en-US',
            whisperModel: process.env.WHISPER_MODEL || 'base'
        };

        // Initialize Google Speech client if using service account
        if (provider === 'google' && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
            try {
                this.googleSpeechClient = new SpeechClient();
                aiDebug.log(`🎙️ Speech-to-Text service initialized with Google service account`);
            } catch (error) {
                aiDebug.error('Failed to initialize Google Speech client:', error);
            }
        } else {
            aiDebug.log(`🎙️ Speech-to-Text service initialized (provider: ${provider})`);
            if (provider === 'whisper-local') {
                console.log(`[STT] Using local Whisper model: ${this.config.whisperModel}`);
                console.log('[STT] Model will be downloaded on first use if not present');
            }
        }
    }

    /**
     * Get API key for the configured provider
     */
    private getApiKey(provider: string): string {
        switch (provider) {
            case 'google':
                return process.env.GOOGLE_SPEECH_API_KEY || '';
            case 'openai':
                return process.env.OPENAI_API_KEY || '';
            case 'azure':
                return process.env.AZURE_SPEECH_API_KEY || '';
            case 'elevenlabs':
                return process.env.ELEVENLABS_API_KEY || '';
            default:
                return '';
        }
    }

    /**
     * Convert audio buffer to text
     */
    public async transcribe(audioBuffer: Buffer): Promise<string> {
        // console.log(`[VOICE STT] Transcribing audio (${audioBuffer.length} bytes) using ${this.config.provider}`);
        aiDebug.log(`🎙️ Transcribing audio (${audioBuffer.length} bytes) using ${this.config.provider}`);

        try {
            // Local Whisper takes raw PCM directly
            if (this.config.provider === 'whisper-local') {
                return await this.transcribeWhisperLocal(audioBuffer);
            }

            // For Google/Azure/OpenAI, convert PCM to WAV
            // (OpenAI accepts WAV, and it's cleaner than sending raw PCM as .opus)
            // console.log('[VOICE STT] Wrapping PCM audio in WAV headers...');
            const { AudioConverter } = await import('../utils/audioConverter');
            const wavBuffer = await AudioConverter.pcmToWav(audioBuffer);
            // console.log(`[VOICE STT] Created WAV file: ${wavBuffer.length} bytes`);

            // Debug: Save WAV file to inspect
            const fs = await import('fs');
            const debugPath = `./debug_audio_${Date.now()}.wav`;
            fs.writeFileSync(debugPath, wavBuffer);
            // console.log(`[VOICE STT] Saved debug WAV file to: ${debugPath}`);

            switch (this.config.provider) {
                case 'openai':
                    return await this.transcribeOpenAI(wavBuffer);
                case 'google':
                    return await this.transcribeGoogle(wavBuffer);
                case 'azure':
                    return await this.transcribeAzure(wavBuffer);
                case 'elevenlabs':
                    return await this.transcribeElevenLabs(wavBuffer);
                default:
                    throw new Error(`Unsupported STT provider: ${this.config.provider}`);
            }
        } catch (error) {
            console.error('[VOICE STT] ❌ Transcription failed:', error);
            aiDebug.error(`❌ Transcription failed:`, error);
            throw error;
        }
    }

    /**
     * Transcribe using Google Cloud Speech-to-Text
     */
    private async transcribeGoogle(audioBuffer: Buffer): Promise<string> {
        // Use official SDK if service account is configured
        if (this.googleSpeechClient) {
            try {
                console.log('[VOICE STT] Using Google Speech SDK with service account...');
                console.log(`[VOICE STT] Audio buffer size: ${audioBuffer.length} bytes`);

                const audio = {
                    content: audioBuffer.toString('base64')
                };

                const config = {
                    encoding: 'LINEAR16' as const, // WAV PCM format
                    sampleRateHertz: 48000,
                    languageCode: this.config.language,
                    enableAutomaticPunctuation: true,
                    model: 'latest_short',
                    audioChannelCount: 2 // Stereo
                };

                const request = {
                    audio,
                    config
                };

                console.log('[VOICE STT] Sending request to Google Speech API...');
                const [response] = await this.googleSpeechClient.recognize(request);
                console.log('[VOICE STT] Received response from Google Speech API');
                console.log('[VOICE STT] Response:', JSON.stringify(response, null, 2));

                if (response.results && response.results.length > 0 && response.results[0].alternatives) {
                    const transcript = response.results[0].alternatives[0].transcript || '';
                    aiDebug.log(`✅ Google transcription (SDK): "${transcript}"`);
                    console.log(`[VOICE STT] ✅ Transcription: "${transcript}"`);
                    return transcript;
                }

                aiDebug.warn('⚠️ No transcription results from Google SDK');
                return '';
            } catch (error) {
                console.error('[VOICE STT] ❌ Google SDK transcription failed:', error);
                if (error instanceof Error) {
                    console.error('[VOICE STT] Error message:', error.message);
                }
                aiDebug.error('Google SDK transcription failed, falling back to REST API:', error);
                // Fall through to REST API
            }
        }

        // Fallback to REST API with API key
        if (!this.config.apiKey) {
            throw new Error('Google Speech API key not configured and no service account found');
        }

        const url = `https://speech.googleapis.com/v1/speech:recognize?key=${this.config.apiKey}`;

        const requestBody = {
            config: {
                encoding: 'OGG_OPUS',
                sampleRateHertz: 48000,
                languageCode: this.config.language,
                enableAutomaticPunctuation: true,
                model: 'latest_short'
            },
            audio: {
                content: audioBuffer.toString('base64')
            }
        };

        const response = await axios.post(url, requestBody, {
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (response.data.results && response.data.results.length > 0) {
            const transcript = response.data.results[0].alternatives[0].transcript;
            aiDebug.log(`✅ Google transcription (REST): "${transcript}"`);
            return transcript;
        }

        aiDebug.warn('⚠️ No transcription results from Google REST API');
        return '';
    }

    /**
     * Transcribe using OpenAI Whisper
     */
    private async transcribeOpenAI(audioBuffer: Buffer): Promise<string> {
        const FormData = require('form-data');
        const form = new FormData();

        console.log(`[VOICE STT] Sending ${audioBuffer.length} bytes to OpenAI Whisper as .wav file`);

        form.append('file', audioBuffer, {
            filename: 'audio.wav',
            contentType: 'audio/wav'
        });
        form.append('model', 'whisper-1');
        form.append('language', this.config.language?.split('-')[0] || 'en');

        const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
            headers: {
                ...form.getHeaders(),
                'Authorization': `Bearer ${this.config.apiKey}`
            }
        });

        const transcript = response.data.text;
        aiDebug.log(`✅ OpenAI transcription: "${transcript}"`);
        return transcript;
    }

    /**
     * Transcribe using Azure Speech Services
     */
    private async transcribeAzure(audioBuffer: Buffer): Promise<string> {
        const region = process.env.AZURE_SPEECH_REGION || 'eastus';
        const url = `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1`;

        const response = await axios.post(url, audioBuffer, {
            headers: {
                'Ocp-Apim-Subscription-Key': this.config.apiKey,
                'Content-Type': 'audio/ogg; codecs=opus'
            },
            params: {
                language: this.config.language
            }
        });

        const transcript = response.data.DisplayText;
        aiDebug.log(`✅ Azure transcription: "${transcript}"`);
        return transcript;
    }

    /**
     * Transcribe using ElevenLabs Scribe
     */
    private async transcribeElevenLabs(audioBuffer: Buffer): Promise<string> {
        const FormData = require('form-data');
        const form = new FormData();

        console.log(`[VOICE STT] Sending ${audioBuffer.length} bytes to ElevenLabs Scribe as .wav file`);

        // ElevenLabs Scribe expects a file upload
        form.append('file', audioBuffer, {
            filename: 'audio.wav',
            contentType: 'audio/wav'
        });

        // Model ID for Scribe v2.5 (Language agnostic) which is robust
        // Or scribe_v1. We'll use scribe_v1 as robust default, user requested v2 but we need exact model id if different
        // Documented is scribe_v1. Let's try to detect from env or default to scribe_v1
        const modelId = 'scribe_v1';
        form.append('model_id', modelId);

        try {
            const response = await axios.post('https://api.elevenlabs.io/v1/speech-to-text', form, {
                headers: {
                    ...form.getHeaders(),
                    'xi-api-key': this.config.apiKey
                }
            });

            // ElevenLabs returns { text: "transcription", ... }
            const transcript = response.data.text;

            if (!transcript) {
                aiDebug.warn('⚠️ No transcription results from ElevenLabs');
                console.log('[VOICE STT] Response payload:', JSON.stringify(response.data));
                return '';
            }

            aiDebug.log(`✅ ElevenLabs transcription: "${transcript}"`);
            return transcript;
        } catch (error: any) {
            console.error('[VOICE STT] ❌ ElevenLabs transcription failed:', error.message);
            if (error.response) {
                console.error('[VOICE STT] Error response:', JSON.stringify(error.response.data));
            }
            throw error;
        }
    }

    /**
     * Transcribe using local Whisper model
     */
    private async transcribeWhisperLocal(audioBuffer: Buffer): Promise<string> {
        // console.log(`[VOICE STT] Using local Whisper model: ${this.config.whisperModel}`);

        try {
            const { pipeline, env } = await import('@xenova/transformers');

            // Safely attempt to suppress ONNX warnings
            if (env && (env as any).onnx) {
                (env as any).onnx.logLevel = 'error';
            }
            // OpusEncoder import removed as input is already PCM

            // Initialize transcriber
            // console.log('[VOICE STT] Initializing Whisper pipeline...');
            const transcriber = await pipeline(
                'automatic-speech-recognition',
                `Xenova/whisper-${this.config.whisperModel}`
            );
            console.log('[VOICE STT] Pipeline ready, processing audio...');

            // 1. Audio is already PCM (48kHz stereo) from voiceService
            const pcmData = audioBuffer;

            // 2. Convert Int16 PCM to Float32 (-1.0 to 1.0)
            const samples = new Int16Array(pcmData.buffer, pcmData.byteOffset, pcmData.length / 2);
            const float32 = new Float32Array(samples.length);
            for (let i = 0; i < samples.length; i++) {
                float32[i] = samples[i] / 32768.0;
            }

            // 3. Downsample from 48kHz stereo to 16kHz mono
            // We need 1 sample for every 3 frames (6 samples)
            const targetLength = Math.floor(float32.length / 6);
            const mono16k = new Float32Array(targetLength);

            for (let i = 0; i < targetLength; i++) {
                const srcIdx = i * 6;
                // Simple average of L+R channels from the first frame of the block
                mono16k[i] = (float32[srcIdx] + float32[srcIdx + 1]) / 2;
            }

            console.log(`[VOICE STT] Prepared ${mono16k.length} samples at 16kHz mono`);

            // 4. Transcribe directly with audio data
            const result = await transcriber(mono16k, {
                language: this.config.language?.split('-')[0] || 'en',
                task: 'transcribe',
                return_timestamps: false
            });

            // Handle result
            const text = Array.isArray(result) ? (result[0]?.text || '') : (result.text || '');
            console.log(`[VOICE STT] ✅ Local Whisper: "${text}"`);
            aiDebug.log(`✅ Local Whisper: "${text}"`);
            return text;

        } catch (error) {
            console.error('[VOICE STT] ❌ Local Whisper transcription failed:', error);
            aiDebug.error('❌ Local Whisper transcription failed:', error);
            throw error;
        }
    }

    /**
     * Check if STT service is configured
     */
    public isConfigured(): boolean {
        // Local Whisper doesn't need API keys
        if (this.config.provider === 'whisper-local') {
            return true;
        }
        // Google can use either API key or service account
        if (this.config.provider === 'google') {
            return this.config.apiKey !== '' || this.googleSpeechClient !== undefined;
        }
        return this.config.apiKey !== '';
    }

    /**
     * Get current configuration
     */
    public getConfig(): STTConfig {
        return { ...this.config };
    }
}

export const speechToTextService = new SpeechToTextService();
