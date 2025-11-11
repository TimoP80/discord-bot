import * as dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import { BotInstance, BotConfig } from './bot-instance';

const botsConfigPath = path.resolve(process.env.BOTS_CONFIG_PATH || 'bots.json');
if (!fs.existsSync(botsConfigPath)) {
  console.error(`Bots configuration file not found at: ${botsConfigPath}`);
  process.exit(1);
}

const botsConfig: BotConfig[] = JSON.parse(fs.readFileSync(botsConfigPath, 'utf-8'));

if (!botsConfig || !Array.isArray(botsConfig) || botsConfig.length === 0) {
  console.error('Invalid bots configuration file: The file should contain an array of bot configurations.');
  process.exit(1);
}

const geminiApiKey = process.env.GEMINI_API_KEY;
if (!geminiApiKey) {
  console.error('GEMINI_API_KEY is not set in the .env file.');
  process.exit(1);
}

botsConfig.forEach(config => {
  const bot = new BotInstance(config);
  bot.start();
});