import { Client, GatewayIntentBits, Message, TextChannel, ChannelType, Partials, DMChannel, Collection, Interaction, Attachment, GuildMember, ChatInputCommandInteraction, SlashCommandBuilder, AttachmentBuilder, ActivityType } from 'discord.js';
import { Personality, loadPersonality, savePersonality } from './personality';
import { generateChannelActivity, generateReactionToMessage, generatePrivateMessageResponse, generateFollowUpMessage, getPersonalityAwareErrorMessage } from './geminiService';
import { updateRelationshipMemory } from './services/relationshipMemoryService';
import { RelationshipTracker } from './relationship-tracker';
import { Channel, Message as CustomMessage, User, AppConfig } from './types';
import { botDebug } from './utils/debugLogger';
import { initializeConfigWithFallback, saveConfig } from './utils/config';
import * as botControlCommands from './commands/bot-control';
import * as simulationControlCommands from './commands/simulation-control';
import * as userCommands from './commands/user-commands';
import * as imageCommands from './commands/image-commands';
import * as voiceCommands from './commands/voice-commands';
import * as agentCommands from './commands/agent-commands';
import { data as agentData, execute as agentExecute } from './commands/agent-commands';
import { autoRefreshApps } from './commands/auto-refresh-apps';
import { regenerateToken } from './token-utils';
import { RateLimiter } from './rate-limiter';
import { gameWatcherService } from './services/gameWatcherService';
import { elevenLabsAgentService } from './services/elevenLabsAgentService';

interface Command {
  data: { name: string; toJSON(): unknown };
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

export interface BotConfig {
  name: string;
  userId: string;
  token: string;
  personalityFilePath: string;
  monitoredChannelIds: string[];
  model?: string;
  responseProbability?: number;
  dmResponseProbability?: number;
  idleChatterEnabled?: boolean;
  idleChatterIntervalMinutes?: number;
  idleChatterProbability?: number;
  idleChatterPrompts?: string[];
  delayedReactionEnabled?: boolean;
  delayedReactionProbability?: number;
  delayedReactionMinDelaySeconds?: number;
  delayedReactionMaxDelaySeconds?: number;
  avatarUrl?: string;
  followUpEnabled?: boolean;
  followUpMinDelaySeconds?: number;
  followUpMaxDelaySeconds?: number;
  nickname?: string;
  personality?: string;
  languageSkills?: string[];
  writingStyle?: string;
  fallbackMessages?: string[];
  elevenLabsVoiceId?: string;
  useElevenLabsAgent?: boolean;
  elevenLabsAgentId?: string;
  elevenLabsAgentLanguage?: string;
}

export class BotInstance {
  private client: Client;
  public discordClient!: Client;
  private personality: Personality;
  public config: BotConfig;
  private lastMessageTimestamp: number = Date.now();
  private relationshipTracker: RelationshipTracker;
  private messageLocks: Set<string>;
  private commands: Collection<string, Command>;
  private rateLimiter: RateLimiter;
  private followUpTimeouts: Map<string, NodeJS.Timeout> = new Map();

  private allBotConfigs: BotConfig[];

  constructor(config: BotConfig, messageLocks: Set<string>, allBotConfigs: BotConfig[]) {
    botDebug.debug(`Constructing BotInstance for ${config.name}`);
    this.messageLocks = messageLocks;
    this.allBotConfigs = allBotConfigs;
    this.commands = new Collection();

    // Initialize rate limiter with default config, will be updated in start()
    this.rateLimiter = new RateLimiter({ minDelayMs: 200 });

    this.config = {
      responseProbability: 0.08, // Reduced from 0.15 to make responses less frequent
      dmResponseProbability: 1.0,
      idleChatterEnabled: false,
      idleChatterIntervalMinutes: 60,
      idleChatterProbability: 0.5,
      idleChatterPrompts: ['The channel has been quiet for a while. Say something to start a conversation.'],
      delayedReactionEnabled: false,
      delayedReactionProbability: 0.10,
      delayedReactionMinDelaySeconds: 5,
      delayedReactionMaxDelaySeconds: 15,
      followUpEnabled: false,
      followUpMinDelaySeconds: 120,
      followUpMaxDelaySeconds: 300,
      model: 'gemini-3-flash-preview',
      ...config
    };

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates // Required for voice channels
      ],
      partials: [Partials.Channel]
    });
    this.discordClient = this.client;

    this.personality = loadPersonality(this.config.personalityFilePath, this.config.name);
    // Use model from personality file if available, otherwise use config.model as fallback
    if (!this.personality.model && this.config.model) {
      this.personality.model = this.config.model;
    }
    this.relationshipTracker = new RelationshipTracker(this.config.personalityFilePath);
    this.registerEventHandlers();
    this.loadCommands();
  }

  private registerEventHandlers(): void {
    botDebug.debug(`Registering event handlers for ${this.config.name}`);
    this.client.once('clientReady', () => {
      botDebug.debug(`Bot ${this.config.name} is ready.`);
      if (this.config.avatarUrl) {
        this.client.user?.setAvatar(this.config.avatarUrl)
          .catch(console.error);
      }
      if (this.config.idleChatterEnabled) {
        botDebug.debug(`Starting idle chatter interval for ${this.config.name}`);
        setInterval(() => this.sendIdleChatter(), 60 * 1000);
      }
    });

    this.client.on('messageCreate', (message) => this.handleMessage(message));
    this.client.on('interactionCreate', (interaction) => this.handleInteraction(interaction));
  }

  private loadCommands(): void {
    botDebug.debug(`Loading commands for ${this.config.name}`);
    const allCommands = { ...botControlCommands, ...simulationControlCommands, ...userCommands, ...imageCommands, autoRefreshApps };
    for (const command of Object.values(allCommands)) {
      this.commands.set(command.data.name, command);
    }
    // Voice and agent commands have different structure (single command with subcommands)
    if (voiceCommands.data) {
      this.commands.set(voiceCommands.data.name, voiceCommands as any);
    }
    if (agentData) {
      this.commands.set(agentData.name, { data: agentData, execute: agentExecute } as any);
    }
    botDebug.debug(`Loaded ${this.commands.size} commands for ${this.config.name}`);
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) return;
    botDebug.debug(`Handling interaction "${interaction.commandName}" for ${this.config.name}`);

    const command = this.commands.get(interaction.commandName);

    if (!command) {
      botDebug.warn(`No command matching "${interaction.commandName}" was found.`);
      return;
    }

    try {
      await command.execute(interaction);
      botDebug.debug(`Executed command "${interaction.commandName}" successfully.`);
    } catch (error) {
      console.error(error);
      botDebug.error(`Error executing command "${interaction.commandName}":`, error);
      await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
    }
  }

  private async handleMessage(message: Message): Promise<void> {
    botDebug.debug(`Incoming message - Content: "${message.content?.substring(0, 100)}${message.content && message.content.length > 100 ? '...' : ''}", Author: ${message.author.username}, Is DM: ${message.channel.type === ChannelType.DM}`);
    botDebug.debug(`Handling message from ${message.author.tag} in channel ${message.channel.id}`);
    const isDM = message.channel.type === ChannelType.DM;

    // CHECK GAME WATCHER SERVICE FIRST
    await gameWatcherService.handleMessage(message, this.config);

    if (!isDM && !this.config.monitoredChannelIds?.includes(message.channel.id)) {
      return;
    }

    this.lastMessageTimestamp = Date.now();

    // Ignore messages from the bot itself to prevent loops
    if (message.author.id === this.client.user!.id) {
      return;
    }

    const displayName = message.member?.displayName ?? message.author.displayName;

    // Update Relationship Memory
    try {
      const customMessage = this.discordMessageToCustomMessage(message);
      const channelName = message.channel instanceof TextChannel ? message.channel.name : 'DM';
      const aiUser = this.personalityToUser(this.personality);

      const updatedAiUser = updateRelationshipMemory(
        aiUser,
        displayName,
        channelName,
        customMessage
      );

      // Update and save personality with new memory
      if (updatedAiUser.relationshipMemory) {
        this.personality.relationshipMemory = updatedAiUser.relationshipMemory;
        // Check if we should save (e.g. only every 5 interactions or debounced? For now, simple save)
        savePersonality(this.config.personalityFilePath, this.personality);
      }
    } catch (err) {
      console.error('Error updating relationship memory:', err);
    }

    // Clear follow-up timeout if it's a DM from a user
    if (isDM) {
      this.clearFollowUpTimeout(message.channel.id);
    }

    const isMentioned = message.mentions.users.has(this.client.user!.id);

    // If the bot is mentioned, it should always respond.
    if (isMentioned) {
      const commandRegex = /<@!?\d+>\s*!(set|list|save|topic|language|setname|status)\s*(.*)/i;
      const match = message.content.match(commandRegex);

      if (match) {
        const command = match[1];
        const args = match[2].trim();
        this.handleCommand(message, command, args);
        return;
      }
      this.respondToMessage(message, displayName);
      return; // Stop further processing
    }

    if (isDM || Math.random() < this.config.responseProbability!) {
      if (this.messageLocks.has(message.id)) {
        return;
      }
      this.messageLocks.add(message.id);

      // New logic: 30% chance for a proactive message instead of a reaction
      // New logic: 30% chance for a proactive message instead of a reaction in channels
      // And a 100% chance for a proactive message in DMs if no other response is sent
      const isProactive = isDM || (!isDM && Math.random() < 0.3);

      if (isProactive) {
        if (message.channel instanceof TextChannel) {
          this.sendProactiveChatter(message.channel).finally(() => {
            this.messageLocks.delete(message.id);
          });
        } else if (isDM) {
          this.respondToMessage(message, displayName).finally(() => {
            this.messageLocks.delete(message.id);
            if (isDM) {
              this.scheduleFollowUp(message.channel as DMChannel);
            }
          });
        }
      } else {
        this.respondToMessage(message, displayName).finally(() => {
          this.messageLocks.delete(message.id);
          if (isDM) {
            this.scheduleFollowUp(message.channel as DMChannel);
          }
        });
      }
    }
  }

  private async handleAgentResponse(message: Message, displayName: string): Promise<boolean> {
    try {
      if (!this.config.elevenLabsAgentId) {
        return false;
      }

      const agent = elevenLabsAgentService.getAgent(this.config.elevenLabsAgentId);
      if (!agent) {
        botDebug.warn(`Configured agent ${this.config.elevenLabsAgentId} not found, falling back to regular response`);
        return false;
      }

      const isDM = message.channel.type === ChannelType.DM;
      const channel = message.channel;

      // Start typing indicator
      if (channel.type === ChannelType.DM || channel.type === ChannelType.GuildText || channel.type === ChannelType.PublicThread || channel.type === ChannelType.PrivateThread) {
        await channel.sendTyping();
      }

      // Get response from agent
      const agentResponse = await elevenLabsAgentService.converseWithAgent(
        this.config.elevenLabsAgentId,
        message.content || '',
        message.author.id,
        this.config.elevenLabsAgentLanguage || agent.language
      );

      if (agentResponse) {
        // Send the response
        this.rateLimiter.send(channel.id, () => {
          if (channel.type === ChannelType.DM || channel.type === ChannelType.GuildText || channel.type === ChannelType.PublicThread || channel.type === ChannelType.PrivateThread) {
            return channel.send(agentResponse);
          }
          return Promise.resolve();
        });
        this.lastMessageTimestamp = Date.now();

        // Schedule follow-up for DMs if enabled
        if (isDM && this.config.followUpEnabled && channel instanceof DMChannel) {
          this.scheduleFollowUp(channel);
        }

        botDebug.log(`🤖 Agent ${agent.name} responded to ${displayName}: "${agentResponse.substring(0, 50)}..."`);
        return true;
      }

      return false;

    } catch (error) {
      botDebug.error('❌ Error handling agent response:', error);
      return false;
    }
  }

  private personalityToUser(personality: Personality): User {
    return {
      id: this.client.user!.id,
      nickname: personality.nickname,
      personality: personality.personality,
      languageSkills: personality.languageSkills,
      writingStyle: personality.writingStyle,
      status: 'online',
      userType: 'bot',
      elevenLabsVoiceId: personality.elevenLabsVoiceId,
      relationshipMemory: personality.relationshipMemory
    };
  }

  private discordMessageToCustomMessage(message: Message): CustomMessage {
    const attachments = message.attachments.map((attachment: Attachment) => ({
      url: attachment.url,
      type: (attachment.contentType?.startsWith('image/') ? 'image' : attachment.contentType?.startsWith('audio/') ? 'audio' : 'file') as 'image' | 'audio' | 'file',
      fileName: attachment.name
    }));

    return {
      id: Date.now() + Math.random(), // geminiService expects a number, not a snowflake string
      nickname: message.member?.displayName ?? message.author.displayName,
      content: message.content,
      timestamp: message.createdAt,
      type: 'user',
      attachments: attachments
    };
  }

  private async discordChannelToCustomChannel(discordChannel: TextChannel | DMChannel): Promise<Channel> {
    const messages = await discordChannel.messages.fetch({ limit: 20 });
    const customMessages: CustomMessage[] = messages.map((m: Message) => this.discordMessageToCustomMessage(m)).reverse();

    let users: User[] = [];
    if (discordChannel instanceof TextChannel) {
      const members = await discordChannel.members;
      users = members.map((member: GuildMember) => {
        const botConfig = this.allBotConfigs.find(b => b.userId === member.id);
        if (botConfig) {
          // Use the in-memory personality if it's the current bot's personality
          const personality = botConfig.name === this.config.name
            ? this.personality
            : loadPersonality(botConfig.personalityFilePath, botConfig.name);
          return this.personalityToUser(personality);
        }
        return {
          id: member.id,
          nickname: member.displayName,
          personality: '', // We don't know the personality of other users here
          languageSkills: { languages: [{ language: 'English', fluency: 'native' }] }, // Assume English for now
          writingStyle: { // Default writing style
            formality: 'casual',
            verbosity: 'moderate',
            humor: 'none',
            emojiUsage: 'occasional',
            punctuation: 'standard'
          },
          status: 'online',
          userType: member.user.bot ? 'bot' : 'network'
        };
      });
    } else { // DMChannel
      const recipient = (discordChannel as DMChannel).recipient;
      if (recipient) {
        users.push({
          id: recipient.id,
          nickname: recipient.displayName,
          personality: '',
          languageSkills: { languages: [{ language: 'English', fluency: 'native' }] },
          writingStyle: {
            formality: 'casual',
            verbosity: 'moderate',
            humor: 'none',
            emojiUsage: 'occasional',
            punctuation: 'standard'
          },
          status: 'online',
          userType: 'network'
        });
      }
    }


    return {
      name: discordChannel instanceof TextChannel ? `#${discordChannel.name}` : 'DM',
      topic: discordChannel instanceof TextChannel ? discordChannel.topic ?? 'No topic' : 'Direct Message',
      users: users,
      messages: customMessages,
      operators: [] // Not tracking operators in this context
    };
  }

  private async respondToMessage(message: Message, displayName: string): Promise<void> {
    try {
      const isDM = message.channel.type === ChannelType.DM;

      // Check if ElevenLabs Agent Platform should be used
      if (this.config.useElevenLabsAgent && this.config.elevenLabsAgentId && elevenLabsAgentService.isConfigured()) {
        const agentResponse = await this.handleAgentResponse(message, displayName);
        if (agentResponse) {
          // Agent handled the response, no need to continue with regular logic
          return;
        }
        // Fall back to regular response if agent fails
      }

      if (isDM && message.channel instanceof DMChannel) {
        const channel = message.channel;
        const history = await channel.messages.fetch({ limit: 20 });
        const conversation = {
          user: this.personalityToUser(this.personality),
          messages: history.map((m: Message) => this.discordMessageToCustomMessage(m)).reverse()
        };
        await channel.sendTyping();
        const appConfig = await initializeConfigWithFallback();
        if (appConfig.rateLimiting?.geminiConservative) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        const response = await generatePrivateMessageResponse(
          conversation,
          this.discordMessageToCustomMessage(message),
          message.author.displayName,
          this.config.model || 'gemini-3-flash-preview'  // Use config model or default to Gemini 3 Flash
        );
        if (response && response.content) {
          this.rateLimiter.send(channel.id, () => {
            const payload: any = { content: response.content };
            const attachments: AttachmentBuilder[] = [];

            if (response.imageBuffer) {
              attachments.push(new AttachmentBuilder(response.imageBuffer, { name: 'generated-image.png' }));
            }
            if (response.audioBuffer) {
              attachments.push(new AttachmentBuilder(response.audioBuffer, { name: 'voice-message.mp3' }));
            }

            if (attachments.length > 0) {
              payload.files = attachments;
            }
            return channel.send(payload);
          });
        }
      } else if (!isDM && message.channel instanceof TextChannel) {
        const channel = message.channel;
        const customChannel = await this.discordChannelToCustomChannel(channel);
        const customMessage = this.discordMessageToCustomMessage(message);
        const appConfig = await initializeConfigWithFallback();
        if (appConfig.rateLimiting?.geminiConservative) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // Decide whether to give a short reaction or a full conversational response
        // More likely to give full responses if:
        // 1. Bot hasn't responded recently (more than 5 minutes ago)
        // 2. Message is directed at the bot (@mention)
        // 3. Message seems conversational (longer than 50 chars)
        const timeSinceLastResponse = Date.now() - this.lastMessageTimestamp;
        const isMentioned = message.mentions.users.has(this.client.user!.id);
        const isConversational = message.content && message.content.length > 50;
        const shouldGiveFullResponse = isMentioned ||
          isConversational ||
          (timeSinceLastResponse > 5 * 60 * 1000 && Math.random() < 0.3);

        let response: string;
        if (shouldGiveFullResponse) {
          // Generate a full conversational response
          response = await generateChannelActivity(
            customChannel,
            this.client.user?.displayName ?? this.personality.nickname,
            this.config.model || 'gemini-3-flash-preview'
          );
        } else {
          // Generate a short reaction
          response = await generateReactionToMessage(
            customChannel,
            customMessage,
            this.personalityToUser(this.personality),
            this.config.model || 'gemini-3-flash-preview'
          );
        }

        if (response) {
          this.rateLimiter.send(channel.id, () => channel.send(response));
          this.lastMessageTimestamp = Date.now();
        }
      }
    } catch (error) {
      console.error(`[${this.personality.nickname}] Failed to send response:`, error);
      // Send personality-aware error message for DM failures
      const isDMError = message.channel.type === ChannelType.DM;
      if (isDMError && message.channel instanceof DMChannel) {
        try {
          const errorMessage = getPersonalityAwareErrorMessage(this.personalityToUser(this.personality), 'send_failure');
          this.rateLimiter.send(message.channel.id, () => (message.channel as DMChannel).send(errorMessage));
        } catch (sendError) {
          console.error(`[${this.personality.nickname}] Failed to send error message:`, sendError);
        }
      }
    }
  }

  private clearFollowUpTimeout(channelId: string): void {
    const timeout = this.followUpTimeouts.get(channelId);
    if (timeout) {
      clearTimeout(timeout);
      this.followUpTimeouts.delete(channelId);
      botDebug.debug(`Cleared follow-up timeout for channel ${channelId}`);
    }
  }

  private scheduleFollowUp(channel: DMChannel): void {
    if (!this.config.followUpEnabled) {
      return;
    }

    this.clearFollowUpTimeout(channel.id);

    const minDelay = (this.config.followUpMinDelaySeconds || 120) * 1000;
    const maxDelay = (this.config.followUpMaxDelaySeconds || 300) * 1000;
    const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;

    botDebug.debug(`Scheduling follow-up for channel ${channel.id} in ${delay / 1000} seconds`);
    console.log(`[DEBUG] Scheduling follow-up for channel ${channel.id} in ${delay / 1000} seconds`);

    const timeout = setTimeout(() => {
      console.log(`[DEBUG] Follow-up timer fired for channel ${channel.id}`);
      this.sendFollowUp(channel);
    }, delay);

    this.followUpTimeouts.set(channel.id, timeout);
  }

  private async sendFollowUp(channel: DMChannel): Promise<void> {
    console.log(`[DEBUG] sendFollowUp executing for channel ${channel.id}`);
    this.followUpTimeouts.delete(channel.id);

    // Check if the last message was from the bot (meaning user hasn't replied yet)
    const messages = await channel.messages.fetch({ limit: 1 });
    const lastMessage = messages.first();
    console.log(`[DEBUG] Last message author: ${lastMessage?.author.id}, Bot ID: ${this.client.user!.id}`);

    // If the last message is NOT from the bot, it means the user replied.
    // We only want to follow up if the user is silent (i.e., bot was the last one to speak).
    if (lastMessage && lastMessage.author.id !== this.client.user!.id) {
      console.log(`[DEBUG] Skipping follow-up because last message was NOT from me (it was from ${lastMessage.author.username})`);
      botDebug.debug(`Skipping follow-up for channel ${channel.id} because last message was not from me`);
      return;
    }

    botDebug.debug(`Sending follow-up message to channel ${channel.id}`);

    try {
      const history = await channel.messages.fetch({ limit: 20 });
      const conversation = {
        user: this.personalityToUser(this.personality),
        messages: history.map((m: Message) => this.discordMessageToCustomMessage(m)).reverse()
      };

      const recipient = channel.recipient;
      const recipientName = recipient ? recipient.displayName : 'User';

      await channel.sendTyping();

      console.log(`[DEBUG] Calling generateFollowUpMessage...`);
      const response = await generateFollowUpMessage(
        conversation,
        recipientName,
        this.config.model
      );
      console.log(`[DEBUG] generateFollowUpMessage response: ${response}`);

      if (response) {
        this.rateLimiter.send(channel.id, () => channel.send(response));
      }
    } catch (error) {
      console.error(`[${this.personality.nickname}] Failed to send follow-up:`, error);
    }
  }

  private async handleCommand(message: Message, command: string, args: string): Promise<void> {
    const parts = args.split(' ');
    const action = parts[0];

    if (command.toLowerCase() === 'set') {
      if (action.toLowerCase() === 'name') {
        const newNickname = parts.slice(1).join(' ');
        if (newNickname) {
          const appConfig = await initializeConfigWithFallback();
          appConfig.currentUserNickname = newNickname;
          await saveConfig(appConfig);
          this.rateLimiter.send(message.channel.id, () => message.reply(`Human user nickname updated to: ${newNickname}`));
        } else {
          this.rateLimiter.send(message.channel.id, () => message.reply('Please provide a nickname. Usage: `!set name <nickname>`'));
        }
        return;
      }

      const attribute = parts[1];
      const value = parts.slice(2).join(' ');

      if (action === 'personality' && attribute && value) {
        let updateSuccessful = false;
        if (attribute in this.personality.writingStyle) {
          (this.personality.writingStyle as Record<string, string>)[attribute] = value;
          updateSuccessful = true;
        }

        if (updateSuccessful) {
          savePersonality(this.config.personalityFilePath, this.personality);
          this.rateLimiter.send(message.channel.id, () => message.reply(`Personality attribute ${attribute} updated to ${value}.`));
        } else {
          this.rateLimiter.send(message.channel.id, () => message.reply(`Invalid personality attribute: ${attribute}.`));
        }
      } else if (action === 'speed' && attribute) {
        const appConfig = await initializeConfigWithFallback();
        const validSpeeds = ['fast', 'normal', 'slow', 'off'];
        if (validSpeeds.includes(attribute)) {
          appConfig.simulationSpeed = attribute as AppConfig['simulationSpeed'];
          await saveConfig(appConfig);
          this.rateLimiter.send(message.channel.id, () => message.reply(`Simulation speed updated to ${attribute}.`));
        } else {
          this.rateLimiter.send(message.channel.id, () => message.reply(`Invalid speed value: ${attribute}. Valid values are: fast, normal, slow, off.`));
        }
      } else {
        this.rateLimiter.send(message.channel.id, () => message.reply('Invalid command format. Use `!set personality <attribute> <value>`, `!set speed <value>`, or `!set name <nickname>`.'));
      }
    } else if (command === 'list') {
      if (action === 'personality') {
        const personalityAttributes = Object.entries(this.personality.writingStyle)
          .map(([key, value]) => `  - ${key}: ${value}`)
          .join('\n');
        this.rateLimiter.send(message.channel.id, () => message.reply(`Current personality attributes:\n\`\`\`\n${personalityAttributes}\n\`\`\``));
      } else {
        this.rateLimiter.send(message.channel.id, () => message.reply('Invalid command format. Use `!list personality`.'));
      }
    } else if (command === 'save') {
      try {
        const appConfig = await initializeConfigWithFallback();
        await saveConfig(appConfig);
        this.rateLimiter.send(message.channel.id, () => message.reply('Settings saved successfully.'));
      } catch (error) {
        console.error('Failed to save settings:', error);
        this.rateLimiter.send(message.channel.id, () => message.reply('Failed to save settings.'));
      }
    } else if (command === 'topic') {
      if (message.channel instanceof TextChannel) {
        try {
          await message.channel.setTopic(args);
          this.rateLimiter.send(message.channel.id, () => message.reply(`Channel topic updated to: ${args}`));
        } catch (error) {
          console.error('Failed to set channel topic:', error);
          this.rateLimiter.send(message.channel.id, () => message.reply('Failed to set channel topic. Make sure I have the "Manage Channels" permission.'));
        }
      } else {
        this.rateLimiter.send(message.channel.id, () => message.reply('The `!topic` command can only be used in a server channel.'));
      }
    } else if (command === 'language') {
      if (message.channel instanceof TextChannel) {
        const appConfig = await initializeConfigWithFallback();
        const channelConfig = appConfig.channelObjects?.find(c => c.name === `#${(message.channel as TextChannel).name}`);
        if (channelConfig) {
          channelConfig.dominantLanguage = args;
        } else {
          // If channel config doesn't exist, create it
          const newChannelConfig: Channel = {
            name: `#${(message.channel as TextChannel).name}`,
            topic: '',
            users: [],
            messages: [],
            operators: [],
            dominantLanguage: args
          };
          if (!appConfig.channelObjects) {
            appConfig.channelObjects = [];
          }
          appConfig.channelObjects.push(newChannelConfig);
        }
        await saveConfig(appConfig);
        this.rateLimiter.send(message.channel.id, () => message.reply(`Channel language updated to: ${args}`));
      } else {
        this.rateLimiter.send(message.channel.id, () => message.reply('The `!language` command can only be used in a server channel.'));
      }
    } else if (command === 'setname') {
      const newNickname = args;
      if (newNickname) {
        const appConfig = await initializeConfigWithFallback();
        appConfig.currentUserNickname = newNickname;
        await saveConfig(appConfig);
        this.rateLimiter.send(message.channel.id, () => message.reply(`Human user nickname updated to: ${newNickname}`));
      } else {
        this.rateLimiter.send(message.channel.id, () => message.reply('Please provide a nickname. Usage: `!setname <nickname>`'));
      }
    } else if (command === 'status') {
      const statusText = args;
      if (statusText) {
        // Set Discord Presence
        this.client.user?.setActivity(statusText, { type: ActivityType.Playing });

        // Set Voice Context (if guild available)
        if (message.guild) {
          const { voiceChatService } = await import('./services/voiceChatService');
          voiceChatService.setContext(message.guild.id, statusText);
        }

        this.rateLimiter.send(message.channel.id, () => message.reply(`✅ Status and Voice Context updated to: "${statusText}"`));
      } else {
        // Clear status
        this.client.user?.setActivity();
        if (message.guild) {
          const { voiceChatService } = await import('./services/voiceChatService');
          voiceChatService.setContext(message.guild.id, '');
        }
        this.rateLimiter.send(message.channel.id, () => message.reply('Status cleared.'));
      }
    }
  }

  private async sendProactiveChatter(channel: TextChannel): Promise<void> {
    try {
      botDebug.debug(`[${this.personality.nickname}] Sending proactive chatter...`);
      const customChannel = await this.discordChannelToCustomChannel(channel);
      const appConfig = await initializeConfigWithFallback();
      if (appConfig.rateLimiting?.geminiConservative) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      // Use generateChannelActivity for proactive messages
      const response = await generateChannelActivity(
        customChannel,
        this.client.user?.displayName ?? this.personality.nickname,
        this.config.model
      );
      if (response) {
        this.rateLimiter.send(channel.id, () => channel.send(response));
        this.lastMessageTimestamp = Date.now();
      }
    } catch (error) {
      console.error(`[${this.personality.nickname}] Failed to send proactive chatter:`, error);
    }
  }

  private async sendIdleChatter(): Promise<void> {
    if (!this.config.idleChatterEnabled) {
      return;
    }

    const now = Date.now();
    const minutesSinceLastMessage = (now - this.lastMessageTimestamp) / (1000 * 60);

    if (minutesSinceLastMessage > this.config.idleChatterIntervalMinutes!) {
      if (Math.random() < this.config.idleChatterProbability!) {
        try {
          if (this.config.monitoredChannelIds.length === 0) {
            return;
          }
          const channelId = this.config.monitoredChannelIds[0];
          const discordChannel = await this.client.channels.fetch(channelId);
          if (discordChannel instanceof TextChannel) {
            const onlineMembers = discordChannel.guild.members.cache.filter((member: GuildMember) =>
              !member.user.bot &&
              member.presence?.status &&
              member.presence.status === 'online'
            );

            if (onlineMembers.size > 0) {
              botDebug.debug(`[${this.personality.nickname}] Channel is idle, but users are online. Sending a message...`);
              const customChannel = await this.discordChannelToCustomChannel(discordChannel);
              const appConfig = await initializeConfigWithFallback();
              if (appConfig.rateLimiting?.geminiConservative) {
                await new Promise(resolve => setTimeout(resolve, 1000));
              }
              const response = await generateChannelActivity(
                customChannel,
                this.client.user?.displayName ?? this.personality.nickname,
                this.config.model
              );
              if (response) {
                this.rateLimiter.send(discordChannel.id, () => discordChannel.send(response));
                this.lastMessageTimestamp = now;
              }
            } else {
              botDebug.debug(`[${this.personality.nickname}] Channel is idle, but no users are online. Skipping idle chatter.`);
            }
          }
        } catch (error) {
          console.error(`[${this.personality.nickname}] Failed to send idle chatter:`, error);
        }
      }
    }
  }

  public async start(): Promise<void> {
    botDebug.debug(`Starting bot ${this.config.name}...`);

    // Initialize Game Watcher
    gameWatcherService.initialize('1449441622805975061');

    // Load and update rate limiter config
    try {
      const appConfig = await initializeConfigWithFallback();
      const minDelayMs = appConfig.rateLimiting?.discordMinDelayMs ?? 200;
      this.rateLimiter.setConfig({ minDelayMs });
      botDebug.debug(`Updated rate limiter config: minDelayMs=${minDelayMs}`);
    } catch (error) {
      botDebug.warn(`Failed to load rate limiter config, using defaults:`, error);
    }

    try {
      await this.client.login(this.config.token);
      botDebug.debug(`Bot ${this.config.name} logged in successfully.`);
    } catch (error: unknown) {
      botDebug.error(`Failed to log in for bot ${this.config.name}:`, error);
      if (error instanceof Error && 'code' in error && (error as any).code === 'TokenInvalid') {
        botDebug.warn(`Invalid token for ${this.config.name}. Attempting to regenerate...`);
        try {
          const newToken = await regenerateToken(this.config.name);
          this.config.token = newToken.accessToken;
          await this.client.login(this.config.token);
          botDebug.debug(`Bot ${this.config.name} logged in with new token.`);
        } catch (regenerationError) {
          botDebug.error(`Failed to regenerate token for ${this.config.name}:`, regenerationError);
          throw new Error(`Failed to regenerate token for ${this.config.name}. Please check your .env file and ensure ${this.config.name.toUpperCase()}_CLIENT_ID and ${this.config.name.toUpperCase()}_CLIENT_SECRET are correct.`);
        }
      } else {
        throw error;
      }
    }
  }

  public async stop(): Promise<void> {
    botDebug.debug(`Stopping bot ${this.config.name}...`);

    // Wait for the rate limiter queue to be empty
    await this.rateLimiter.waitForQueueDrain();

    await this.client.destroy();

    // Clear all follow-up timeouts
    for (const [channelId, timeout] of this.followUpTimeouts.entries()) {
      clearTimeout(timeout);
    }
    this.followUpTimeouts.clear();

    botDebug.debug(`Bot ${this.config.name} stopped.`);
  }

  public async startSimulation(): Promise<void> {
    botDebug.debug(`[${this.config.name}] startSimulation called`);
  }

  public stopSimulation(): void {
    botDebug.debug(`[${this.config.name}] stopSimulation called`);
  }
}
