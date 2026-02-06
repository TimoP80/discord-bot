import fs from 'fs';
import { Relationship } from './relationship-tracker';
import { User } from './types';

export interface FallbackMessages {
  activity: string[];
  reaction: string[];
}

export interface Personality {
  name: string;
  nickname: string;
  personality: string;
  languageSkills: User['languageSkills'];
  writingStyle: User['writingStyle'];
  fallbackMessages?: FallbackMessages;
  promptTemplates?: string[];
  relationships: Relationship[];
  model?: string;
  elevenLabsVoiceId?: string;
  relationshipMemory?: any; // Using any for now to avoid circular dependency, but logically it is UserRelationshipMemory
}

export function loadPersonality(filePath: string, nickname?: string): Personality {
  const resolvedPath = filePath;
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Personality file not found at: ${resolvedPath}`);
  }

  const fileContent = fs.readFileSync(resolvedPath, 'utf-8');
  const config = JSON.parse(fileContent);

  let allPersonalities: Personality[] = [];

  if (Array.isArray(config.users)) {
    allPersonalities = config.users.filter((u: any) => u.name && u.name !== 'monitoredChannelIds');
  } else if (Object.keys(config).length > 0 && config.constructor === Object && !config.users) {
    console.warn('Old personality file format detected. It will be converted on next save.');
    allPersonalities = Object.keys(config).map(botName => ({
      name: botName,
      ...config[botName]
    }));
  }

  if (allPersonalities.length === 0) {
    throw new Error('Invalid personality file: no users/bots found.');
  }

  const targetName = nickname || allPersonalities[0].name;

  if (nickname === undefined) {
    console.warn(`No name provided. Falling back to first user: ${targetName}.`);
  }

  const personalityData = allPersonalities.find(p => p.name === targetName);

  if (personalityData) {
    console.log(`Personality loaded for: ${personalityData.nickname}`);
    return personalityData;
  }

  throw new Error(`Personality for name "${targetName}" not found in ${filePath}.`);
}

export function savePersonality(filePath: string, updatedPersonality: Personality): void {
  const resolvedPath = filePath;

  let allPersonalities: Personality[] = [];
  if (fs.existsSync(resolvedPath)) {
    const fileContent = fs.readFileSync(resolvedPath, 'utf-8');
    try {
      const config = JSON.parse(fileContent);
      if (Array.isArray(config.users)) {
        allPersonalities = config.users;
      } else if (Object.keys(config).length > 0 && config.constructor === Object && !config.users) {
        // Handle old format by converting it
        console.warn('Old personality file format detected. Converting to new format.');
        allPersonalities = Object.keys(config).map(botName => ({
          name: botName,
          ...config[botName]
        }));
      }
    } catch (e) {
      console.error(`Could not parse personality file "${resolvedPath}", starting with a new one.`, e);
    }
  }

  const botIndex = allPersonalities.findIndex(p => p.name === updatedPersonality.name);

  if (botIndex !== -1) {
    // Update existing personality
    allPersonalities[botIndex] = updatedPersonality;
  } else {
    // Add new personality
    allPersonalities.push(updatedPersonality);
  }

  const newConfig = { users: allPersonalities };
  const fileContent = JSON.stringify(newConfig, null, 2);
  fs.writeFileSync(resolvedPath, fileContent, 'utf-8');
  console.log(`Personality saved for: ${updatedPersonality.nickname}`);
}
