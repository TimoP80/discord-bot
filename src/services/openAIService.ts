/**
 * OpenAI Service
 * Handles integration with OpenAI API for message generation as a fallback
 */

import OpenAI from 'openai';
import { aiDebug } from '../utils/debugLogger';

export interface OpenAIConfig {
    enabled: boolean;
    apiKey: string;
    model: string;
    temperature?: number;
    maxTokens?: number;
}

/**
 * Gets OpenAI configuration from environment variables
 * @returns OpenAI configuration
 */
export const getOpenAIConfig = (): OpenAIConfig => {
    aiDebug.debug('Entering getOpenAIConfig');
    const enabled = process.env.USE_OPENAI === 'true' || !!process.env.OPENAI_API_KEY;
    const apiKey = process.env.OPENAI_API_KEY || '';
    if (apiKey) {
        aiDebug.log(`[Config] OPENAI_API_KEY found (length: ${apiKey.length}, starts with: ${apiKey.substring(0, 7)}...)`);
    } else {
        aiDebug.error('[Config] OPENAI_API_KEY NOT found in environment variables!');
        aiDebug.log('Environment keys available:', Object.keys(process.env).filter(k => k.includes('API')));
    }
    const model = process.env.OPENAI_MODEL || 'gpt-4-turbo';
    const temperature = process.env.OPENAI_TEMPERATURE ? parseFloat(process.env.OPENAI_TEMPERATURE) : 0.85;

    return {
        enabled,
        apiKey,
        model,
        temperature
    };
};

/**
 * Generates content using OpenAI API
 * @param prompt The prompt to send to OpenAI
 * @param config OpenAI configuration
 * @returns Promise<string> The generated text response
 */
export const generateWithOpenAI = async (
    prompt: string,
    config: OpenAIConfig,
    systemInstruction?: string
): Promise<string> => {
    aiDebug.debug(`Entering generateWithOpenAI with model: ${config.model}`);

    if (!config.apiKey) {
        throw new Error('OpenAI API key is missing');
    }

    try {
        aiDebug.log(`📝 Generating content with OpenAI model: ${config.model}`);

        const openai = new OpenAI({
            apiKey: config.apiKey,
        });

        const messages: any[] = [];
        if (systemInstruction) {
            messages.push({ role: 'system', content: systemInstruction });
        }
        messages.push({ role: 'user', content: prompt });

        const response = await openai.chat.completions.create({
            model: config.model,
            messages: messages,
            temperature: config.temperature,
            max_tokens: config.maxTokens || 1000,
        });

        const content = response.choices[0]?.message?.content;

        if (!content) {
            throw new Error('Empty response from OpenAI');
        }

        aiDebug.log(`✅ Generated content from OpenAI (${response.usage?.total_tokens} tokens)`);
        aiDebug.debug(`OpenAI response content length: ${content.length} characters`);
        return content.trim();
    } catch (error) {
        aiDebug.error(`❌ OpenAI generation error: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
    }
};

/**
 * Generates an image using OpenAI's DALL-E API
 * @param prompt The prompt for image generation
 * @param prompt The prompt for image generation
 * @param config OpenAI configuration
 * @param size Image size (supported: 1024x1024, 1024x1792, 1792x1024)
 * @returns Promise<Buffer> The generated image buffer
 */
export const generateImageWithOpenAI = async (
    prompt: string,
    config: OpenAIConfig,
    size: "1024x1024" | "1024x1792" | "1792x1024" = "1024x1024"
): Promise<Buffer> => {
    aiDebug.debug(`Entering generateImageWithOpenAI`);

    if (!config.apiKey) {
        throw new Error('OpenAI API key is missing');
    }

    try {
        aiDebug.log(`🎨 Generating image with OpenAI (DALL-E 3) for prompt: "${prompt}" size: ${size}`);

        try {
            const openai = new OpenAI({
                apiKey: config.apiKey,
            });

            const response = await openai.images.generate({
                model: "dall-e-3",
                prompt: prompt,
                n: 1,
                size: size,
                response_format: "b64_json",
            });

            const imageData = response.data && response.data[0] ? response.data[0].b64_json : undefined;
            if (imageData) {
                aiDebug.log(`✅ Generated image from OpenAI (DALL-E 3)`);
                return Buffer.from(imageData, 'base64');
            }
        } catch (dalle3Error: any) {
            // Check if error is related to model access (404/403) or billing
            if (dalle3Error.status === 403 || dalle3Error.status === 404 || (dalle3Error.code === 'model_not_found')) {
                aiDebug.warn(`⚠️ DALL-E 3 access denied or not found. Falling back to DALL-E 2... (${dalle3Error.message})`);

                const openai = new OpenAI({
                    apiKey: config.apiKey,
                });

                // Fallback to DALL-E 2
                // Note: DALL-E 2 only supports 1024x1024
                const response = await openai.images.generate({
                    model: "dall-e-2",
                    prompt: prompt,
                    n: 1,
                    size: "1024x1024",
                    response_format: "b64_json",
                });

                const imageData = response.data && response.data[0] ? response.data[0].b64_json : undefined;
                if (imageData) {
                    aiDebug.log(`✅ Generated image from OpenAI (DALL-E 2 Fallback)`);
                    return Buffer.from(imageData, 'base64');
                }
            } else {
                throw dalle3Error; // Rethrow other errors (billing, safety, etc)
            }
        }

        throw new Error('Empty image response from OpenAI');

    } catch (error) {
        aiDebug.error(`❌ OpenAI image generation error: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
    }
};

/**
 * Analyzes an image using OpenAI's Vision API
 * @param prompt The prompt for the analysis
 * @param imageBuffer The image buffer
 * @param config OpenAI configuration
 * @returns Promise<string> The analysis text
 */
export const analyzeImageWithOpenAI = async (
    prompt: string,
    imageBuffer: Buffer,
    config: OpenAIConfig
): Promise<string> => {
    aiDebug.debug(`Entering analyzeImageWithOpenAI`);

    if (!config.apiKey) {
        throw new Error('OpenAI API key is missing');
    }

    try {
        aiDebug.log(`👁️ Analyzing image with OpenAI (Vision)`);

        const openai = new OpenAI({
            apiKey: config.apiKey,
        });

        const base64Image = imageBuffer.toString('base64');
        const dataUrl = `data:image/jpeg;base64,${base64Image}`;

        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini", // Using mini for speed/efficiency
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: prompt },
                        {
                            type: "image_url",
                            image_url: {
                                "url": dataUrl,
                            },
                        },
                    ],
                },
            ],
            max_tokens: 500,
        });

        const content = response.choices[0]?.message?.content;

        if (!content) {
            throw new Error('Empty response from OpenAI Vision');
        }

        aiDebug.log(`✅ Analyzed image with OpenAI`);
        return content.trim();
    } catch (error) {
        aiDebug.error(`❌ OpenAI vision error: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
    }
};

/**
 * Generates speech audio using OpenAI's TTS API
 * @param text The text to convert to speech
 * @param config OpenAI configuration
 * @param voice The voice to use (alloy, echo, fable, onyx, nova, shimmer)
 * @param model The TTS model to use (tts-1 or tts-1-hd)
 * @returns Promise<Buffer> The generated audio buffer
 */
export const generateSpeechWithOpenAI = async (
    text: string,
    config: OpenAIConfig,
    voice: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer" = "alloy",
    model: "tts-1" | "tts-1-hd" = "tts-1"
): Promise<Buffer> => {
    aiDebug.debug(`Entering generateSpeechWithOpenAI`);

    if (!config.apiKey) {
        throw new Error('OpenAI API key is missing');
    }

    try {
        aiDebug.log(`🎵 Generating speech with OpenAI TTS (voice: ${voice}, model: ${model})`);

        const openai = new OpenAI({
            apiKey: config.apiKey,
        });

        const mp3 = await openai.audio.speech.create({
            model: model,
            voice: voice,
            input: text,
            response_format: "mp3",
        });

        const buffer = Buffer.from(await mp3.arrayBuffer());
        aiDebug.log(`✅ Generated speech from OpenAI TTS (${buffer.length} bytes)`);
        return buffer;

    } catch (error) {
        aiDebug.error(`❌ OpenAI TTS error: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
    }
};