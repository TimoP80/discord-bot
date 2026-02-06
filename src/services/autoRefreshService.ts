import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import { getBotCredentials } from '../utils/credentials';
import { botDebug } from '../utils/debugLogger';

interface Command {
  data: { toJSON(): unknown };
}


class AutoRefreshService {
  private intervalId: NodeJS.Timeout | null = null;

  public start(botName: string, token: string) {
    if (this.intervalId) {
      this.stop();
    }

    this.intervalId = setInterval(async () => {
      await this.refreshCommands(botName, token);
    }, 300000); // 5 minutes

    botDebug.debug(`Auto-refresh service started for bot: ${botName}`);
  }

  public stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      botDebug.debug('Auto-refresh service stopped.');
    }
  }

  private async refreshCommands(botName: string, token: string) {
    const botControlCommands = require('../commands/bot-control');
    const simulationControlCommands = require('../commands/simulation-control');
    const userCommands = require('../commands/user-commands');
    const { autoRefreshApps } = require('../commands/auto-refresh-apps');

    const commands = [
      ...(Object.values(botControlCommands) as Command[]).map((command) => command.data.toJSON()),
      ...(Object.values(simulationControlCommands) as Command[]).map((command) => command.data.toJSON()),
      ...(Object.values(userCommands) as Command[]).map((command) => command.data.toJSON()),
      autoRefreshApps.data.toJSON()
    ];

    const rest = new REST({ version: '10' }).setToken(token);
    try {
      const { clientId } = getBotCredentials(botName);
      botDebug.debug(`Started refreshing application (/) commands for ${botName}.`);
      await rest.put(
        Routes.applicationCommands(clientId),
        { body: commands }
      );
      botDebug.debug(`Successfully reloaded application (/) commands for ${botName}.`);
    } catch (error) {
      botDebug.error('Failed to refresh application commands', error);
    }
  }
}

export const autoRefreshService = new AutoRefreshService();
