import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export function getBotCredentials(botName: string): { clientId: string; clientSecret: string } {
  const upperCaseBotName = botName.toUpperCase();
  const clientId = process.env[`${upperCaseBotName}_CLIENT_ID`];
  const clientSecret = process.env[`${upperCaseBotName}_CLIENT_SECRET`];

  if (!clientId || !clientSecret) {
    throw new Error(`Credentials for bot ${botName} not found in .env file.`);
  }

  return { clientId, clientSecret };
}
