import { TokenValidator } from './tokenValidator';
import { regenerateToken, refreshToken } from '../token-utils';
import { TokenData, TokenValidationResult } from '../types/token';
import { createDebugger } from '../utils/debugLogger';

const tokenManagerDebug = createDebugger('station-v:token-manager');

export class TokenManager {
  private static tokenCache = new Map<string, TokenData>();

  /**
   * Ensures a valid token is available for the specified bot.
   * If the current token is invalid, attempts to refresh it or regenerate it.
   * @param botName The name of the bot
   * @returns Promise<string> A valid access token
   */
  static async ensureValidToken(botName: string): Promise<string> {
    try {
      tokenManagerDebug.debug(`Ensuring valid token for bot: ${botName}`);

      // First, try to get token from cache or environment
      const tokenData = this.getTokenData(botName);

      if (!tokenData) {
        tokenManagerDebug.debug(`No cached token data for ${botName}, regenerating...`);
        const regeneratedTokenData = await regenerateToken(botName);
        this.setTokenData(botName, regeneratedTokenData);
        return regeneratedTokenData.accessToken;
      }

      // Validate the current token
      const validationResult = await TokenValidator.validateToken(tokenData.accessToken);

      if (validationResult.isValid) {
        tokenManagerDebug.debug(`Token for ${botName} is still valid`);
        return tokenData.accessToken;
      } else {
        tokenManagerDebug.debug(`Token for ${botName} is invalid, will attempt refresh/regeneration`);
      }

      tokenManagerDebug.warn(`Token for ${botName} is invalid: ${validationResult.error}`);

      // Token is invalid, try to refresh if we have a refresh token
      if (tokenData.refreshToken) {
        try {
          tokenManagerDebug.debug(`Attempting to refresh token for ${botName}`);
          const refreshedData = await refreshToken(botName, tokenData.refreshToken);
          this.setTokenData(botName, refreshedData);
          return refreshedData.accessToken;
        } catch (refreshError) {
          tokenManagerDebug.error(`Token refresh failed for ${botName}:`, refreshError);
          // Fall through to regeneration
        }
      }

      // Refresh failed or no refresh token available, regenerate the token
      tokenManagerDebug.debug(`Regenerating token for ${botName}`);
      const regeneratedTokenData = await regenerateToken(botName);
      this.setTokenData(botName, regeneratedTokenData);

      return regeneratedTokenData.accessToken;

    } catch (error) {
      tokenManagerDebug.error(`Failed to ensure valid token for ${botName}:`, error);

      // If we have a cached/env token, return it even if validation/regeneration failed
      const tokenData = this.getTokenData(botName);
      if (tokenData) {
        tokenManagerDebug.warn(`Returning potentially invalid token for ${botName} after regeneration failure.`);
        return tokenData.accessToken;
      }

      throw new Error(`Token management failed for bot ${botName}: ${error}`);
    }
  }

  /**
   * Gets the cached token data for a bot
   * @param botName The name of the bot
   * @returns TokenData or null if not cached
   */
  private static getTokenData(botName: string): TokenData | null {
    const cached = this.tokenCache.get(botName);
    if (cached && cached.expiresAt > new Date()) {
      return cached;
    }

    // Check environment variables as fallback
    const envToken = process.env[`TOKEN_${botName.toUpperCase()}`];
    if (envToken) {
      tokenManagerDebug.debug(`Retrieved token for ${botName} from env: ${envToken.substring(0, 20)}...`);
      return {
        accessToken: envToken,
        refreshToken: process.env[`REFRESH_TOKEN_${botName.toUpperCase()}`] || '',
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // Assume valid for bot tokens
        tokenType: 'Bot',
        scope: 'bot'
      };
    }

    return null;
  }

  /**
   * Caches token data for a bot
   * @param botName The name of the bot
   * @param tokenData The token data to cache
   */
  private static setTokenData(botName: string, tokenData: TokenData): void {
    this.tokenCache.set(botName, tokenData);

    // Also update environment variables for persistence
    process.env[`TOKEN_${botName.toUpperCase()}`] = tokenData.accessToken;
    if (tokenData.refreshToken) {
      process.env[`REFRESH_TOKEN_${botName.toUpperCase()}`] = tokenData.refreshToken;
    }
  }

  /**
   * Clears the token cache for a specific bot
   * @param botName The name of the bot
   */
  static clearTokenCache(botName?: string): void {
    if (botName) {
      this.tokenCache.delete(botName);
      tokenManagerDebug.debug(`Cleared token cache for ${botName}`);
    } else {
      this.tokenCache.clear();
      tokenManagerDebug.debug('Cleared all token caches');
    }
  }

  /**
   * Gets the current token for a bot without validation
   * @param botName The name of the bot
   * @returns The current token or null if not available
   */
  static getCurrentToken(botName: string): string | null {
    const tokenData = this.getTokenData(botName);
    return tokenData?.accessToken || null;
  }
}
