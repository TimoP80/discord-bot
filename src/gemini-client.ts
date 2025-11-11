import { GoogleGenerativeAI, Part } from '@google/generative-ai';
import { getPersonality } from './personality';
import axios from 'axios';
import { debugLog } from './debug-logger';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  throw new Error('Gemini API key is not configured in the .env file.');
}

const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro"});

async function urlToGenerativePart(url: string, mimeType: string): Promise<Part> {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  const buffer = Buffer.from(response.data, 'binary');
  return {
    inlineData: {
      data: buffer.toString('base64'),
      mimeType,
    },
  };
}

function sanitizeResponse(text: string): string {
  // Remove the model's "thinking" process, often enclosed in asterisks.
  // Collapse multiple newlines into a single paragraph break for better formatting.
  return text.replace(/\*.*?\*/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

export async function generateResponse(
  prompt: string,
  imageUrl?: string,
  imageMimeType?: string,
  audioUrl?: string,
  audioMimeType?: string
): Promise<string> {
  const personality = getPersonality();

  const fullPrompt = `
    You are ${personality.nickname}.
    Your personality is: ${personality.personality}.
    Your writing style is: ${personality.writingStyle.formality}, ${personality.writingStyle.verbosity}, with ${personality.writingStyle.humor} humor.
    You use emoji ${personality.writingStyle.emojiUsage} and ${personality.writingStyle.punctuation} punctuation.

    Based on this personality, respond to the following message.
    If an image is included, comment on it.
    If an audio file is included, transcribe it and respond to the transcription.
    ${prompt}
  `;

  try {
    const content: (string | Part)[] = [fullPrompt];
    if (imageUrl && imageMimeType) {
      debugLog('Adding image to prompt...');
      const imagePart = await urlToGenerativePart(imageUrl, imageMimeType);
      content.push(imagePart);
    }
    if (audioUrl && audioMimeType) {
      debugLog('Adding audio to prompt...');
      const audioPart = await urlToGenerativePart(audioUrl, audioMimeType);
      content.push(audioPart);
    }

    debugLog('Sending prompt to Gemini:', fullPrompt);
    const result = await model.generateContent(content);
    const response = await result.response;
    const rawText = response.text();
    const sanitizedText = sanitizeResponse(rawText);
    return sanitizedText;
  } catch (error) {
    console.error('Error communicating with Gemini API:', error);
    throw new Error('Failed to generate a response from Gemini.');
  }
}

export async function findInterestingMessage(messageHistory: { author: string, content: string }[]): Promise<string | null> {
  if (messageHistory.length < 5) {
    return null;
  }

  const historyText = messageHistory.map(m => `${m.author}: ${m.content}`).join('\n');

  const prompt = `
    You are an AI assistant tasked with identifying interesting, unanswered messages in a chat history.
    Analyze the following conversation and identify a message that was not directly answered or that could spark further discussion.
    Do not select the most recent messages. Look for something a bit older that was missed.
    If you find an interesting message, return its exact content. Otherwise, return "null".

    Chat History:
    ${historyText}
  `;

  try {
    debugLog('Finding interesting message with prompt:', prompt);
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text().trim();
    debugLog('Interesting message found:', text);
    return text.toLowerCase() === 'null' ? null : text;
  } catch (error) {
    console.error('Error finding interesting message:', error);
    return null;
  }
}