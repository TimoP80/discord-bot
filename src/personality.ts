import fs from 'fs';
import path from 'path';

export interface Personality {
  nickname: string;
  personality: string;
  languageSkills: any;
  writingStyle: any;
  relationships: {
    name: string;
    type: string;
    history: string;
    dynamics: string;
  }[];
}

let personality: Personality | null = null;

export function loadPersonality(filePath: string): void {
  if (personality) {
    console.log('Personality is already loaded.');
    return;
  }

  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Personality file not found at: ${resolvedPath}`);
  }

  const fileContent = fs.readFileSync(resolvedPath, 'utf-8');
  const personalityData = JSON.parse(fileContent);

  if (!personalityData.users || !Array.isArray(personalityData.users) || personalityData.users.length === 0) {
    throw new Error('Invalid personality file: "users" array is missing or empty.');
  }

  const users: Personality[] = personalityData.users;

  // For simplicity, we'll use the first user's personality for the bot
  const loadedPersonality = users[0];
  personality = loadedPersonality;
  console.log(`Personality loaded for: ${loadedPersonality.nickname}`);
}

export function getPersonality(): Personality {
  if (!personality) {
    throw new Error('Personality has not been loaded. Call loadPersonality first.');
  }
  return personality;
}