import { Client, GatewayIntentBits, Message, TextChannel, ChannelType, Partials, DMChannel } from 'discord.js';
import { Personality, loadPersonality } from './personality';
import { generateResponse, findInterestingMessage } from './gemini-client';
import { debugLog } from './debug-logger';

export interface BotConfig {
  token: string;
  personalityFilePath: string;
  targetChannelId: string;
  responseProbability?: number;
  dmResponseProbability?: number;
  idleChatterEnabled?: boolean;
  idleChatterIntervalMinutes?: number;
  idleChatterPrompt?: string;
  delayedReactionEnabled?: boolean;
  delayedReactionProbability?: number;
  delayedReactionMinDelaySeconds?: number;
  delayedReactionMaxDelaySeconds?: number;
}

export class BotInstance {
  private client: Client;
  private personality: Personality;
  private config: BotConfig;
  private lastMessageTimestamp: number = Date.now();

  constructor(config: BotConfig) {
    this.config = {
      responseProbability: 0.15,
      dmResponseProbability: 0.50,
      idleChatterEnabled: false,
      idleChatterIntervalMinutes: 60,
      idleChatterPrompt: 'The channel has been quiet for a while. Say something to start a conversation.',
      delayedReactionEnabled: false,
      delayedReactionProbability: 0.10,
      delayedReactionMinDelaySeconds: 5,
      delayedReactionMaxDelaySeconds: 15,
      ...config,
    };

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });

    this.personality = loadPersonality(this.config.personalityFilePath);
    this.registerEventHandlers();
  }

  private registerEventHandlers(): void {
    this.client.once('ready', () => {
      console.log(`Logged in as ${this.client.user?.tag} (${this.personality.nickname})`);
      console.log(`Monitoring channel ID: ${this.config.targetChannelId}`);
      if (this.config.idleChatterEnabled) {
        setInterval(() => this.sendIdleChatter(), 60 * 1000);
      }
    });

    this.client.on('messageCreate', (message) => this.handleMessage(message));
  }

  private async handleMessage(message: Message): Promise<void> {
    const isDM = message.channel.type === ChannelType.DM;
    if (!isDM && message.channel.id !== this.config.targetChannelId) {
      return;
    }

    this.lastMessageTimestamp = Date.now();

    if (message.author.bot) {
      return;
    }

    const probability = isDM ? this.config.dmResponseProbability! : this.config.responseProbability!;
    if (Math.random() < probability) {
      this.respondToMessage(message);
    } else {
      this.handleDelayedReaction(message);
    }
  }

  private async respondToMessage(message: Message): Promise<void> {
    debugLog(`[${this.personality.nickname}] Responding to message from ${message.author.tag}: "${message.content}"`);
    try {
      if (message.channel instanceof TextChannel || message.channel instanceof DMChannel) {
        const imageAttachment = message.attachments.find(att => att.contentType?.startsWith('image/'));
        const audioAttachment = message.attachments.find(att => att.contentType?.startsWith('audio/'));

        const response = await generateResponse(
          this.personality,
          message.content,
          imageAttachment?.url,
          imageAttachment?.contentType ?? undefined,
          audioAttachment?.url,
          audioAttachment?.contentType ?? undefined
        );
        message.reply(response);
      }
    } catch (error) {
      console.error(`[${this.personality.nickname}] Failed to send response:`, error);
    }
  }

  private async handleDelayedReaction(message: Message): Promise<void> {
    if (!this.config.delayedReactionEnabled || Math.random() >= this.config.delayedReactionProbability!) {
      return;
    }
    debugLog(`[${this.personality.nickname}] Attempting a delayed reaction...`);

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
          const minDelay = this.config.delayedReactionMinDelaySeconds! * 1000;
          const maxDelay = this.config.delayedReactionMaxDelaySeconds! * 1000;
          const delay = Math.random() * (maxDelay - minDelay) + minDelay;
          
          debugLog(`[${this.personality.nickname}] Found interesting message: "${interestingMessage.content}". Replying in ${delay / 1000}s.`);
          setTimeout(async () => {
            debugLog(`[${this.personality.nickname}] Replying to an older message: "${interestingMessage.content}"`);
            const response = await generateResponse(this.personality, `In response to "${interestingMessage.content}"...`);
            interestingMessage.reply(response);
          }, delay);
        }
      }
    } catch (error) {
      console.error(`[${this.personality.nickname}] Failed to handle delayed reaction:`, error);
    }
  }

  private async sendIdleChatter(): Promise<void> {
    if (!this.config.idleChatterEnabled) {
      return;
    }

    const now = Date.now();
    const minutesSinceLastMessage = (now - this.lastMessageTimestamp) / (1000 * 60);

    if (minutesSinceLastMessage > this.config.idleChatterIntervalMinutes!) {
      debugLog(`[${this.personality.nickname}] Channel has been idle. Sending a message...`);
      try {
        const channel = await this.client.channels.fetch(this.config.targetChannelId);
        if (channel instanceof TextChannel) {
          const response = await generateResponse(this.personality, this.config.idleChatterPrompt!);
          channel.send(response);
          this.lastMessageTimestamp = now;
        }
      } catch (error) {
        console.error(`[${this.personality.nickname}] Failed to send idle chatter:`, error);
      }
    }
  }

  public start(): void {
    this.client.login(this.config.token);
  }
}