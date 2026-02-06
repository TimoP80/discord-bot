import { GoogleGenerativeAI, Part } from '@google/generative-ai';
import { Personality } from './personality';
import { Relationship } from './relationship-tracker';
import axios from 'axios';
import { debugLog } from './debug-logger';

const apiKey = process.env.GEMINI_API_KEY?.trim();
if (!apiKey) {
  throw new Error('Gemini API key is not configured in the .env file.');
}

const genAI = new GoogleGenerativeAI(apiKey);
const defaultModel = 'gemini-3-flash-preview';

function getModel(personality: Personality) {
  const modelName = personality.model || defaultModel;
  return genAI.getGenerativeModel({ model: modelName });
}

async function urlToGenerativePart(url: string, mimeType: string): Promise<Part> {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  const buffer = Buffer.from(response.data, 'binary');
  return {
    inlineData: {
      data: buffer.toString('base64'),
      mimeType
    }
  };
}

function sanitizeResponse(text: string): string {
  // General cleanup
  return text
    .replace(/\*.*?\*/g, '') // Remove model's "thinking" in asterisks
    .replace(/\n+/g, ' ')    // Collapse multiple newlines
    .trim();
}

export async function generateResponse(
  personality: Personality,
  prompt: string,
  isDM: boolean,
  conversationHistory?: string,
  imageUrl?: string,
  imageMimeType?: string,
  audioUrl?: string,
  audioMimeType?: string
): Promise<string> {
  const maxLength = 8000;
  let truncatedPrompt = prompt;
  if (prompt.length > maxLength) {
    truncatedPrompt = prompt.substring(0, maxLength) + '...';
  }

  const historyContext = conversationHistory ? `
    Here is the recent conversation history for context:
    ${conversationHistory}
  ` : '';

  let basePrompt;
  if (personality.promptTemplates && personality.promptTemplates.length > 0) {
    const template = personality.promptTemplates[Math.floor(Math.random() * personality.promptTemplates.length)];
    basePrompt = template.replace('{nickname}', personality.nickname).replace('{personality}', personality.personality);
  } else {
    basePrompt = `You are ${personality.nickname}. Your personality is: ${personality.personality}.`;
  }

  const currentTime = new Date().toLocaleString('en-US', { timeZone: 'Europe/Helsinki' });

  const fullPrompt = `
    ${basePrompt}
    The current time is ${currentTime}. Be mindful of the time of day in your response.
    Your writing style is: ${personality.writingStyle.formality}, ${personality.writingStyle.verbosity}, with ${personality.writingStyle.humor} humor.
    You use emoji ${personality.writingStyle.emojiUsage} and ${personality.writingStyle.punctuation} punctuation.

    You are in a ${isDM ? 'private message' : 'public channel'}. Adapt your response to this context.
    ${historyContext}
    Based on your personality and the provided context, respond to the following new message.
    If an image is included, comment on it.
    If an audio file is included, transcribe it and respond to the transcription.
    New Message: "${truncatedPrompt}"
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
    const model = getModel(personality);
    const result = await model.generateContent(content);
    const response = await result.response;
    let textToProcess = response.text();

    if (textToProcess.length > 2000 && audioUrl) {
      textToProcess = await condenseContent(textToProcess, personality);
    }

    const sanitizedText = sanitizeResponse(textToProcess);
    return sanitizedText;
  } catch (error) {
    console.error('Error communicating with Gemini API:', error);
    throw new Error('Failed to generate a response from Gemini.');
  }
}

export async function condenseContent(
  content: string,
  personality: Personality
): Promise<string> {
  const prompt = `
    The following text is a transcription and response that is too long for Discord (max 2000 characters).
    Condense it to under 1900 characters.
    Focus on retaining the key information from the transcription and the main points of the response.
    Maintain the original tone and style as much as possible.

    Original content:
    "${content}"
  `;

  try {
    debugLog('Condensing content that is too long...');
    const model = getModel(personality);
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text().trim();
    debugLog('Condensed content:', text);
    return text;
  } catch (error) {
    console.error('Error condensing content:', error);
    // Fallback to simple truncation if summarization fails
    return content.substring(0, 1950) + '... [content truncated]';
  }
}

export async function findInterestingMessage(
  messageHistory: { author: string, content: string }[],
  personality: Personality
): Promise<string | null> {
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
    const model = getModel(personality);
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

export async function analyzeAndTrackRelationships(
  conversationHistory: string,
  botPersonality: Personality,
  userName: string
): Promise<Partial<Relationship> | null> {
  const prompt = `
    You are an AI assistant specializing in social dynamics.
    Analyze the following conversation and determine if the relationship between ${botPersonality.nickname} and ${userName} has changed.
    Be creative with the relationship "type". It can be anything from "Friend" to "Nemesis" to "Secret Admirer".

    Current relationship:
    - Type: ${(botPersonality.relationships || []).find(r => r.name === userName)?.type || 'Not yet established'}
    - History: ${(botPersonality.relationships || []).find(r => r.name === userName)?.history || 'No history'}

    Conversation:
    ${conversationHistory}

    Has the relationship evolved? If so, describe the new status, history, and dynamics.
    Format your response as a JSON object with "type", "history", and "dynamics" fields.
    If no significant change occurred, return null.
  `;

  try {
    const model = getModel(botPersonality);
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text().trim();
    if (text.toLowerCase() === 'null') {
      return null;
    }
    // Strip markdown formatting
    const jsonText = text.replace(/```json\n|```/g, '');
    try {
      return JSON.parse(jsonText);
    } catch (parseError) {
      console.error('Failed to parse relationship JSON:', parseError);
      console.error('Invalid JSON string:', jsonText);
      return null;
    }
  } catch (error) {
    console.error('Error analyzing relationships:', error);
    return null;
  }
}
export async function generateFollowUp(
  personality: Personality,
  conversationHistory: string
): Promise<string | null> {
  const currentTime = new Date().toLocaleString('en-US', { timeZone: 'Europe/Helsinki' });
  const prompt = `
    You are ${personality.nickname}, and your personality is: ${personality.personality}.
    The current time is ${currentTime}. Be mindful of the time of day in your response.
    Based on the following conversation, generate a follow-up question or a thoughtful comment to keep the conversation going.
    Do not repeat what has already been said. Introduce a new, related topic or ask for more detail on something mentioned earlier.
    If the conversation seems to have reached a natural conclusion, return "null".

    Conversation History:
    ${conversationHistory}
  `;

  try {
    debugLog('Generating follow-up with prompt:', prompt);
    const model = getModel(personality);
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text().trim();
    debugLog('Follow-up generated:', text);
    return text.toLowerCase() === 'null' ? null : text;
  } catch (error) {
    console.error('Error generating follow-up:', error);
    return null;
  }
}
