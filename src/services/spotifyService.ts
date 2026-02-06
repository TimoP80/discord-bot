
import axios from 'axios';
import { aiDebug } from '../utils/debugLogger';
import { loadConfig } from '../utils/config';

interface SpotifyTokenResponse {
    access_token: string;
    token_type: string;
    expires_in: number;
}

interface SpotifyTrack {
    name: string;
    external_urls: {
        spotify: string;
    };
    artists: { name: string }[];
}

interface SpotifySearchResponse {
    tracks: {
        items: SpotifyTrack[];
    };
}

export class SpotifyService {
    private accessToken: string | null = null;
    private tokenExpiresAt: number = 0;

    /**
     * authenticates with Spotify using Client Credentials Flow.
     * This is required to search for tracks.
     */
    private async authenticate(): Promise<boolean> {
        try {
            // Check if token is still valid
            if (this.accessToken && Date.now() < this.tokenExpiresAt) {
                return true;
            }

            const config = await loadConfig();
            if (!config?.spotify?.clientId || !config?.spotify?.clientSecret) {
                aiDebug.warn('Spotify credentials missing from config.');
                return false;
            }

            const authString = Buffer.from(
                `${config.spotify.clientId}:${config.spotify.clientSecret}`
            ).toString('base64');

            const response = await axios.post<SpotifyTokenResponse>(
                'https://accounts.spotify.com/api/token',
                'grant_type=client_credentials',
                {
                    headers: {
                        'Authorization': `Basic ${authString}`,
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }
            );

            this.accessToken = response.data.access_token;
            // expires_in is in seconds, set expiry time with a small buffer
            this.tokenExpiresAt = Date.now() + (response.data.expires_in * 1000) - 60000;

            aiDebug.log('✅ Connected to Spotify API successfully.');
            return true;

        } catch (error) {
            const err = error as any;
            aiDebug.error('❌ Spotify Authentication Failed:', err.response?.data || err.message);
            return false;
        }
    }

    /**
     * Searches for a track and returns the direct Spotify URL.
     * @param query Song query (e.g. "Daft Punk Discovery")
     * @returns The Spotify URL (https://open.spotify.com/track/...) or formatted Smart Link fallback
     */
    public async searchTrack(query: string): Promise<string> {
        const isAuthenticated = await this.authenticate();

        if (!isAuthenticated || !this.accessToken) {
            aiDebug.warn('Using fallback Smart Link for Spotify (Auth Failed)');
            return this.getSmartLink(query);
        }

        try {
            const searchUrl = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=1`;
            const response = await axios.get<SpotifySearchResponse>(searchUrl, {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`
                }
            });

            const track = response.data.tracks.items[0];
            if (track) {
                const artistName = track.artists[0]?.name || 'Unknown Artist';
                aiDebug.log(`🎵 Found Spotify Track: "${track.name}" by ${artistName}`);
                return track.external_urls.spotify;
            } else {
                aiDebug.log(`No results found on Spotify API for "${query}", using fallback.`);
                return this.getSmartLink(query);
            }

        } catch (error) {
            aiDebug.error('Error searching Spotify:', error);
            return this.getSmartLink(query);
        }
    }

    /**
     * Fallback generation if API fails
     */
    private getSmartLink(query: string): string {
        return `https://open.spotify.com/search/${encodeURIComponent(query)}`;
    }
}

export const spotifyService = new SpotifyService();
