import { ChatInputCommandInteraction, SlashCommandBuilder, CacheType } from 'discord.js';
import { botDebug } from '../utils/debugLogger';
import { agentGuiService } from '../services/agentGuiService';

export const botMute = {
  data: new SlashCommandBuilder()
    .setName('bot-mute')
    .setDescription('Mutes a specific bot or all bots.')
    .addStringOption(option =>
      option.setName('bot_name')
        .setDescription('The name of the bot to mute.')
        .setRequired(false)),
  async execute(interaction: ChatInputCommandInteraction<CacheType>) {
   const botName = interaction.options.getString('bot_name') || 'All bots';
   botDebug.debug(`Executing bot-mute command for: ${botName}`);
   await interaction.reply(`${botName} muted!`);
 }
};

export const botUnmute = {
  data: new SlashCommandBuilder()
    .setName('bot-unmute')
    .setDescription('Unmutes a specific bot or all bots.')
    .addStringOption(option =>
      option.setName('bot_name')
        .setDescription('The name of the bot to unmute.')
        .setRequired(false)),
  async execute(interaction: ChatInputCommandInteraction<CacheType>) {
   const botName = interaction.options.getString('bot_name') || 'All bots';
   botDebug.debug(`Executing bot-unmute command for: ${botName}`);
   await interaction.reply(`${botName} unmuted!`);
 }
};

export const botMsgRate = {
  data: new SlashCommandBuilder()
    .setName('bot-msg-rate')
    .setDescription('Adjusts the message rate of a specific bot or all bots.')
    .addNumberOption(option =>
      option.setName('rate')
        .setDescription('A value between 0.0 and 1.0.')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('bot_name')
        .setDescription('The name of the bot to adjust.')
        .setRequired(false)),
  async execute(interaction: ChatInputCommandInteraction<CacheType>) {
   const rate = interaction.options.getNumber('rate');
   const botName = interaction.options.getString('bot_name') || 'All bots';
   botDebug.debug(`Executing bot-msg-rate command for: ${botName} with rate: ${rate}`);
   await interaction.reply(`Message rate for ${botName} set to ${rate}!`);
 }
};

export const openAgentGui = {
  data: new SlashCommandBuilder()
    .setName('agent-gui')
    .setDescription('Opens the ElevenLabs Agent Management GUI.'),
  async execute(interaction: ChatInputCommandInteraction<CacheType>) {
    botDebug.debug('Executing agent-gui command');

    try {
      // Check if running in Electron environment
      if (typeof window !== 'undefined' && (window as any).electronAPI) {
        // Running in renderer process
        await interaction.reply('Opening Agent GUI...');
        // The GUI would be opened from the main process
      } else {
        // Running in main process (typical for Discord bots)
        agentGuiService.showAgentWindow();
        await interaction.reply('🤖 Agent Management GUI opened! Check your desktop application.');
      }
    } catch (error) {
      botDebug.error('Error opening agent GUI:', error);
      await interaction.reply('❌ Failed to open Agent GUI. Make sure you\'re running the Electron app.');
    }
  }
};
