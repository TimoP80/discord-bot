import { CommandInteraction, SlashCommandBuilder, CacheType } from 'discord.js';
import { simulationDebug } from '../utils/debugLogger';
import { startSimulation, stopSimulation, pauseSimulation, resumeSimulation } from '../services/simulationService';

export const simStart = {
  data: new SlashCommandBuilder()
    .setName('sim-start')
    .setDescription('Starts the IRC simulation.'),
  async execute(interaction: CommandInteraction<CacheType>) {
    simulationDebug.debug('Executing sim-start command.');
    await interaction.deferReply();
    await startSimulation(interaction.client);
    await interaction.followUp('Simulation started!');
  }
};

export const simStop = {
  data: new SlashCommandBuilder()
    .setName('sim-stop')
    .setDescription('Stops the IRC simulation.'),
  async execute(interaction: CommandInteraction<CacheType>) {
    simulationDebug.debug('Executing sim-stop command.');
    await interaction.deferReply();
    stopSimulation();
    await interaction.followUp('Simulation stopped!');
  }
};

export const simPause = {
  data: new SlashCommandBuilder()
    .setName('sim-pause')
    .setDescription('Pauses the IRC simulation.'),
  async execute(interaction: CommandInteraction<CacheType>) {
    simulationDebug.debug('Executing sim-pause command.');
    await interaction.deferReply();
    pauseSimulation();
    await interaction.followUp('Simulation paused!');
  }
};

export const simResume = {
  data: new SlashCommandBuilder()
    .setName('sim-resume')
    .setDescription('Resumes the IRC simulation.'),
  async execute(interaction: CommandInteraction<CacheType>) {
    simulationDebug.debug('Executing sim-resume command.');
    await interaction.deferReply();
    resumeSimulation();
    await interaction.followUp('Simulation resumed!');
  }
};
