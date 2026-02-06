import { Client, TextChannel } from 'discord.js';
import { AppConfig, Channel, User, Message } from '../types';
import { generateChannelActivity, generateRandomWorldConfiguration } from '../geminiService';
import { getDb, saveDatabase, loadDatabase } from './configDatabaseService';
import { simulationDebug } from '../utils/debugLogger';
import { botInstances } from '../bot-controls';

let simulationInterval: NodeJS.Timeout | null = null;
let isPaused = false;

const getSimulationInterval = (speed: 'fast' | 'normal' | 'slow' | 'off'): number => {
  switch (speed) {
    case 'fast':
      return 5 * 1000; // 5 seconds
    case 'normal':
      return 15 * 1000; // 15 seconds
    case 'slow':
      return 30 * 1000; // 30 seconds
    default:
      return -1; // Off
  }
};

export const startSimulation = async (client: Client): Promise<void> => {
  if (simulationInterval) {
    simulationDebug.warn('Simulation is already running.');
    return;
  }

  simulationDebug.log('Starting simulation...');
  botInstances.forEach(bot => bot.startSimulation());

  try {
    await loadDatabase();
    const db = getDb();

    // Sync users and channels from Discord
    const guild = client.guilds.cache.first();
    if (!guild) {
      simulationDebug.error('No guild found to simulate.');
      return;
    }

    await guild.channels.fetch();

    // Sync users from the bot configurations
    const botUsers = botInstances.map(bot => {
      const config = bot.config;
      return {
        id: config.userId || '',
        nickname: config.nickname || config.name,
        personality: config.personality || '',
        languageSkills: config.languageSkills,
        writingStyle: config.writingStyle,
        fallbackMessages: config.fallbackMessages,
        status: 'online' as const,
        userType: 'bot' as const,
        model: config.model
      };
    });

    // Add human users
    let humanUsers: unknown[] = [];
    try {
      await guild.members.fetch();
      humanUsers = guild.members.cache
        .filter(member => !member.user.bot)
        .map(member => ({
          id: member.id,
          nickname: member.displayName,
          personality: 'human',
          languageSkills: { languages: [{ language: 'English', fluency: 'native' as const }] },
          writingStyle: {
            formality: 'casual' as const,
            verbosity: 'moderate' as const,
            humor: 'none' as const,
            emojiUsage: 'occasional' as const,
            punctuation: 'standard' as const
          },
          status: 'online' as const,
          userType: 'human' as const
        }));
    } catch (error) {
      simulationDebug.warn('Failed to fetch guild members, generating synthetic users:', error);
      humanUsers = [
        {
          id: 'synthetic1',
          nickname: 'Alice',
          personality: 'human',
          languageSkills: { languages: [{ language: 'English', fluency: 'native' }] },
          writingStyle: { formality: 'casual', verbosity: 'moderate', humor: 'none', emojiUsage: 'occasional', punctuation: 'standard' },
          status: 'online',
          userType: 'human'
        },
        {
          id: 'synthetic2',
          nickname: 'Bob',
          personality: 'human',
          languageSkills: { languages: [{ language: 'English', fluency: 'native' }] },
          writingStyle: { formality: 'casual', verbosity: 'moderate', humor: 'none', emojiUsage: 'occasional', punctuation: 'standard' },
          status: 'online',
          userType: 'human'
        }
      ];
    }

    db.userObjects = [...(botUsers as unknown as User[]), ...(humanUsers as User[])];

    // Sync channels
    db.channelObjects = guild.channels.cache
      .filter(channel => channel.type === 0) // 0 for TextChannel
      .map(channel => ({
        id: channel.id,
        name: `#${channel.name}`,
        topic: (channel as TextChannel).topic || 'No topic',
        users: db.userObjects || [],
        messages: [],
        operators: []
      }));

    await saveDatabase();
    simulationDebug.log('Users and channels synced from Discord and bot configurations.');

    const simulationTick = async () => {
      if (isPaused) {
        return;
      }

      const currentDb = getDb();
      const channels = currentDb.channelObjects;
      if (!channels || channels.length === 0) {
        simulationDebug.warn('No channels to simulate activity in.');
        return;
      }

      // Randomly select a bot to generate activity
      if (botInstances.length === 0) {
        simulationDebug.warn('No bot instances available for simulation.');
        return;
      }

      const randomBot = botInstances[Math.floor(Math.random() * botInstances.length)];
      const randomChannel = channels[Math.floor(Math.random() * channels.length)];

      try {
        if (!randomChannel.id) return;

        // Fetch real Discord channel to get latest messages
        const discordChannel = await randomBot.discordClient.channels.fetch(randomChannel.id);
        if (!(discordChannel instanceof TextChannel)) {
          return;
        }

        // Check permissions
        const member = await discordChannel.guild.members.fetch(randomBot.discordClient.user!.id);
        if (!discordChannel.permissionsFor(member).has('SendMessages')) {
          simulationDebug.warn(`Bot ${randomBot.config.name} lacks SendMessages permission in channel ${randomChannel.name}`);
          return;
        }

        // Fetch recent messages for context
        const recentMessages = await discordChannel.messages.fetch({ limit: 20 });
        const lastMessage = recentMessages.first();

        // COOLDOWN CHECK: Don't speak if the last message was very recent
        // This gives humans a chance to reply and prevents bot spam
        if (lastMessage && (Date.now() - lastMessage.createdTimestamp < 8000)) {
          simulationDebug.log(`Skipping simulation tick for ${randomChannel.name} - conversation is active (last msg ${Math.round((Date.now() - lastMessage.createdTimestamp) / 1000)}s ago)`);
          return;
        }

        // Update DB channel object with real messages so the AI sees the context
        randomChannel.messages = recentMessages.reverse().map(m => ({
          id: Number(m.id) || Date.now(), // Best effort conversion for ID
          nickname: m.member?.displayName || m.author.username,
          content: m.content,
          timestamp: new Date(m.createdTimestamp),
          type: 'user' as const
        } as unknown as Message));

        simulationDebug.log(`Bot ${randomBot.config.name} generating activity in channel: ${randomChannel.name}`);

        const activity = await generateChannelActivity(randomChannel, currentDb.currentUserNickname, currentDb.aiModel);

        if (activity && activity.trim().length > 0) {
          await discordChannel.send(activity);
          simulationDebug.log(`Simulation: Sent message in ${randomChannel.name}: "${activity}"`);
        }
      } catch (error) {
        simulationDebug.error('Error in simulation tick:', error);
      }
    };

    const intervalMs = getSimulationInterval(db.simulationSpeed);
    if (intervalMs > 0) {
      simulationInterval = setInterval(simulationTick, intervalMs);
      simulationDebug.log(`Simulation started with an interval of ${intervalMs}ms.`);
    } else {
      simulationDebug.log('Simulation speed is set to "off". No simulation will run.');
    }
  } catch (error) {
    simulationDebug.error('Failed to start simulation:', error);
  }
};

export const stopSimulation = (): void => {
  if (simulationInterval) {
    clearInterval(simulationInterval);
    simulationInterval = null;
    isPaused = false;
    simulationDebug.log('Simulation stopped.');
    botInstances.forEach(bot => bot.stopSimulation());
  } else {
    simulationDebug.warn('Simulation is not running.');
  }
};

export const pauseSimulation = (): void => {
  if (simulationInterval && !isPaused) {
    isPaused = true;
    simulationDebug.log('Simulation paused.');
  } else {
    simulationDebug.warn('Simulation is not running or is already paused.');
  }
};

export const resumeSimulation = (): void => {
  if (simulationInterval && isPaused) {
    isPaused = false;
    simulationDebug.log('Simulation resumed.');
  } else {
    simulationDebug.warn('Simulation is not running or is not paused.');
  }
};
