import { CommandInteraction, SlashCommandBuilder, CacheType } from 'discord.js';
import { botDebug } from '../utils/debugLogger';
import { autoRefreshService } from '../services/autoRefreshService';

export const autoRefreshApps = {
  data: new SlashCommandBuilder()
    .setName('auto-refresh-apps')
    .setDescription('Enables auto-refreshing of application commands.')
    .addStringOption(option =>
      option.setName('bot_name')
        .setDescription('The name of the bot to enable auto-refresh for.')
        .setRequired(true)),
  async execute(interaction: CommandInteraction<CacheType>) {
    const botName = (interaction as any).options.getString('bot_name');
    const token = process.env[`TOKEN_${botName.toUpperCase()}`];

    if (!token) {
      await interaction.reply(`Token for bot ${botName} not found in .env file.`);
      return;
    }

    autoRefreshService.start(botName, token);
    botDebug.debug(`Executing auto-refresh-apps command for bot: ${botName}`);
    await interaction.reply(`Auto-refreshing of apps is now enabled for bot ${botName}.`);
  }
};
