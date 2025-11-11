import * as dotenv from 'dotenv';
dotenv.config();

import { Client, GatewayIntentBits, Message, TextChannel, ChannelType, Partials, DMChannel } from 'discord.js';
import { loadPersonality } from './personality';
import { generateResponse, findInterestingMessage } from './gemini-client';
import { debugLog } from './debug-logger';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

const targetChannelId = process.env.TARGET_CHANNEL_ID;
const responseProbability = parseFloat(process.env.RESPONSE_PROBABILITY || '0.15');
const dmResponseProbability = parseFloat(process.env.DM_RESPONSE_PROBABILITY || '0.50');
const idleChatterEnabled = process.env.IDLE_CHATTER_ENABLED === 'true';
const idleChatterIntervalMinutes = parseFloat(process.env.IDLE_CHATTER_INTERVAL_MINUTES || '60');
const idleChatterPrompt = process.env.IDLE_CHATTER_PROMPT || 'The channel has been quiet for a while. Say something to start a conversation.';

const delayedReactionEnabled = process.env.DELAYED_REACTION_ENABLED === 'true';
const delayedReactionProbability = parseFloat(process.env.DELAYED_REACTION_PROBABILITY || '0.10');
const delayedReactionMinDelay = parseInt(process.env.DELAYED_REACTION_MIN_DELAY_SECONDS || '5', 10) * 1000;
const delayedReactionMaxDelay = parseInt(process.env.DELAYED_REACTION_MAX_DELAY_SECONDS || '15', 10) * 1000;

let lastMessageTimestamp = Date.now();

if (!targetChannelId) {
  console.error('TARGET_CHANNEL_ID is not set in the .env file.');
  process.exit(1);
}

async function sendIdleChatter() {
  if (!idleChatterEnabled || !targetChannelId) {
    return;
  }

  const now = Date.now();
  const minutesSinceLastMessage = (now - lastMessageTimestamp) / (1000 * 60);

  if (minutesSinceLastMessage > idleChatterIntervalMinutes) {
    debugLog('Channel has been idle. Sending a message...');
    try {
      const channel = await client.channels.fetch(targetChannelId);
      if (channel instanceof TextChannel) {
        const response = await generateResponse(idleChatterPrompt);
        channel.send(response);
        lastMessageTimestamp = now;
      }
    } catch (error) {
      console.error('Failed to send idle chatter:', error);
    }
  }
}

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user?.tag}!`);
  console.log(`Monitoring channel ID: ${targetChannelId}`);
  console.log(`Response probability: ${responseProbability * 100}%`);
  if (idleChatterEnabled) {
    console.log(`Idle chatter enabled. Interval: ${idleChatterIntervalMinutes} minutes.`);
    setInterval(sendIdleChatter, 60 * 1000);
  }

  try {
    loadPersonality(process.env.PERSONALITY_FILE_PATH || '');
  } catch (error) {
    console.error('Failed to initialize personality:', error);
    process.exit(1);
  }
});

async function handleDelayedReaction(message: Message) {
  if (!delayedReactionEnabled || Math.random() >= delayedReactionProbability) {
    return;
  }
  debugLog('Attempting a delayed reaction...');

  try {
    const channel = message.channel;
    if (!(channel instanceof TextChannel) && !(channel instanceof DMChannel)) {
      return;
    }

    const messages = await channel.messages.fetch({ limit: 30 });
    const messageHistory = messages.map(m => ({ author: m.author.tag, content: m.content }));

    const interestingMessageContent = await findInterestingMessage(messageHistory);
    if (interestingMessageContent) {
      const interestingMessage = messages.find(m => m.content === interestingMessageContent);
      if (interestingMessage && !interestingMessage.author.bot) {
        const delay = Math.random() * (delayedReactionMaxDelay - delayedReactionMinDelay) + delayedReactionMinDelay;
        debugLog(`Found interesting message: "${interestingMessage.content}". Replying in ${delay / 1000}s.`);
        setTimeout(async () => {
          debugLog(`Replying to an older message: "${interestingMessage.content}"`);
          const response = await generateResponse(`In response to "${interestingMessage.content}"...`);
          interestingMessage.reply(response);
        }, delay);
      }
    } else {
      debugLog('No interesting message found for a delayed reaction.');
    }
  } catch (error) {
    console.error('Failed to handle delayed reaction:', error);
  }
}

client.on('messageCreate', async (message: Message) => {
  const isDM = message.channel.type === ChannelType.DM;
  if (!isDM && message.channel.id !== targetChannelId) {
    return;
  }

  lastMessageTimestamp = Date.now();

  if (message.author.bot) {
    return;
  }

  const probability = isDM ? dmResponseProbability : responseProbability;
  debugLog(`Message from ${message.author.tag} in ${isDM ? 'DM' : 'channel'}. Response probability: ${probability * 100}%`);

  if (Math.random() < probability) {
    debugLog(`Responding to message from ${message.author.tag}: "${message.content}"`);
    try {
      if (message.channel instanceof TextChannel || message.channel instanceof DMChannel) {
        const imageAttachment = message.attachments.find(att => att.contentType?.startsWith('image/'));
        const imageUrl = imageAttachment?.url;
        const imageMimeType = imageAttachment?.contentType;

        const audioAttachment = message.attachments.find(att => att.contentType?.startsWith('audio/'));
        const audioUrl = audioAttachment?.url;
        const audioMimeType = audioAttachment?.contentType;

        const response = await generateResponse(
          message.content,
          imageUrl,
          imageMimeType ?? undefined,
          audioUrl,
          audioMimeType ?? undefined
        );
        message.reply(response);
      }
    } catch (error) {
      console.error('Failed to send response:', error);
    }
  } else {
    handleDelayedReaction(message);
  }
});

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('DISCORD_TOKEN is not set in the .env file.');
  process.exit(1);
}

client.login(token);