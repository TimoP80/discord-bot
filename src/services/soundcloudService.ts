import { Client } from 'soundcloud-scraper';
import { aiDebug } from '../utils/debugLogger';

export class SoundCloudService {
    private client: Client;

    constructor() {
        this.client = new Client();
    }

    /**
     * Searches for a SoundCloud track and returns the URL of the first result.
     * @param query The search query.
     * @returns The URL of the first track result, or null if no results found.
     */
    public async searchTrack(query: string): Promise<string | null> {
        try {
            aiDebug.log(`🔍 Searching SoundCloud for: "${query}"`);
            // Warning: 'type' argument 'track' is specific to this library, 
            // but if types are loose it might just be the second arg.
            // Based on typical usage: client.search(query, 'track')
            const results = await this.client.search(query, 'track');

            if (results && results.length > 0) {
                // Filter for actual tracks if possible, though 'track' type should handle it
                const track = results[0] as any;
                aiDebug.log(`✅ Found SoundCloud track: ${track.title} (${track.url})`);
                return track.url;
            }

            aiDebug.warn(`⚠️ No SoundCloud results found for query: "${query}"`);
            return null;
        } catch (error) {
            aiDebug.error('❌ Error searching SoundCloud:', error);
            return null;
        }
    }
}

export const soundCloudService = new SoundCloudService();
