import { CommandInteraction, SlashCommandBuilder, CacheType } from 'discord.js';
import { botDebug } from '../utils/debugLogger';

export const listApps = {
  data: new SlashCommandBuilder()
    .setName('list-apps')
    .setDescription('Lists all applications for a given user.')
    .addStringOption(option =>
      option.setName('user_id')
        .setDescription('The ID of the user.')
        .setRequired(true)),
  async execute(interaction: CommandInteraction<CacheType>) {
    const userId = (interaction as any).options.getString('user_id');
    botDebug.debug(`Executing list-apps command for user: ${userId}`);
    // In a real application, you would fetch the applications for the user from a database or API.
    // For this example, we'll just return a static list.
    await interaction.reply(`Applications for user ${userId}:\n- App 1\n- App 2\n- App 3`);
  }
};
