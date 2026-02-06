import axios, { AxiosResponse } from 'axios';
import { TokenValidationResult } from '../types/token';
import { createDebugger } from '../utils/debugLogger';

const tokenValidatorDebug = createDebugger('station-v:token-validator');

export class TokenValidator {
  private static readonly DISCORD_API_BASE = 'https://discord.com/api/v10';

  /**
   * Validates a Discord bot token by attempting to fetch the current user's information
   * @param token The bot token to validate
   * @returns Promise<TokenValidationResult> indicating if the token is valid
   */
  static async validateToken(token: string): Promise<TokenValidationResult> {
    try {
      tokenValidatorDebug.debug('Validating token...');

      const response: AxiosResponse = await axios.get(`${this.DISCORD_API_BASE}/users/@me`, {
        headers: {
          'Authorization': `Bot ${token}`,
          'User-Agent': 'DiscordBot (https://discord.com/api, 10)'
        },
        timeout: 10000 // 10 second timeout
      });

      if (response.status === 200) {
        tokenValidatorDebug.debug('Token validation successful');
        return {
          isValid: true
        };
      } else {
        tokenValidatorDebug.warn(`Token validation failed with status: ${response.status}`);
        return {
          isValid: false,
          error: `Unexpected response status: ${response.status}`
        };
      }
    } catch (error: unknown) {
      tokenValidatorDebug.error('Token validation error:', (error as any).message);

      if ((error as any).response) {
        // Discord API returned an error response
        const status = (error as any).response.status;
        if (status === 401) {
          return {
            isValid: false,
            error: 'Invalid token (401 Unauthorized)'
          };
        } else if (status === 403) {
          return {
            isValid: false,
            error: 'Forbidden access (403 Forbidden)'
          };
        } else {
          return {
            isValid: true,
            error: `API error: ${status} ${(error as any).response.statusText}`
          };
        }
      } else {
        return {
          isValid: true,
          error: (error as any).code === 'ECONNABORTED' ? 'Request timeout' : `Network error: ${(error as any).message}`
        };
      }
    }
  }

  /**
   * Checks if a token is close to expiration (within 5 minutes)
   * Note: Discord bot tokens don't expire, but this method is included for future OAuth2 token support
   * @param expiresAt The expiration date of the token
   * @returns true if the token expires within 5 minutes
   */
  static isTokenExpiringSoon(expiresAt: Date): boolean {
    const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);
    return expiresAt <= fiveMinutesFromNow;
  }
}
