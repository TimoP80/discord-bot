export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export interface RefreshTokenRequest {
  client_id: string;
  client_secret: string;
  grant_type: 'refresh_token';
  refresh_token: string;
}

export interface RefreshTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string; // May not be provided if refresh token is still valid
  scope: string;
}

export interface TokenData {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  tokenType: string;
  scope: string;
}

export interface TokenValidationResult {
  isValid: boolean;
  expiresAt?: Date;
  error?: string;
}

export interface TokenRegenerationResult {
  success: boolean;
  tokenData?: TokenData;
  error?: string;
}

export interface BotCredentials {
  clientId: string;
  clientSecret: string;
}
