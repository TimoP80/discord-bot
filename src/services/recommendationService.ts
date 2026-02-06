
import { aiDebug } from '../utils/debugLogger';

/**
 * Service to handle recommendations for Music (Spotify) and Movies (IMDb).
 * Currently uses "Smart Links" (Web Search URLs) to avoid API key dependencies.
 * Designed to be extensible for real API implementations later.
 */
import { spotifyService } from './spotifyService';

export class RecommendationService {

    /**
     * Generates a Spotify Link using the API if available, otherwise fallback.
     */
    public async getSpotifyLink(query: string): Promise<string> {
        return await spotifyService.searchTrack(query);
    }

    /**
     * Generates an IMDb Find URL for the given query.
     * @param query Movie or TV Show title
     */
    public getImdbLink(query: string): string {
        const encoded = encodeURIComponent(query.trim());
        return `https://www.imdb.com/find/?q=${encoded}&s=tt`; // &s=tt filters to Titles only
    }

    /**
     * Processes a message content string, replacing recommendation tags with valid links.
     * Supported Tags:
     * - [SEARCH_SPOTIFY: <query>]
     * - [SEARCH_IMDB: <query>]
     */
    public async processTags(content: string): Promise<string> {
        let processed = content;

        // Process Spotify Tags (Async replacement requires loop or careful handling)
        if (processed.includes('[SEARCH_SPOTIFY')) {
            const spotifyRegex = /\[SEARCH_SPOTIFY:\s*(.*?)\]/gi;
            // We use a match loop to handle async calls
            const matches = [...processed.matchAll(spotifyRegex)];

            for (const match of matches) {
                const fullTag = match[0];
                const query = match[1];
                if (!query || !query.trim()) continue;

                const link = await this.getSpotifyLink(query);
                aiDebug.log(`🎵 Generated Spotify Link: ${link}`);

                // Replace only this instance
                processed = processed.replace(fullTag, `\n${link}`);
            }
        }

        // Process IMDb Tags
        // Regex matches [SEARCH_IMDB: query] case-insensitive
        const imdbRegex = /\[SEARCH_IMDB:\s*(.*?)\]/gi;
        processed = processed.replace(imdbRegex, (_match, query) => {
            if (!query || !query.trim()) return '';
            const link = this.getImdbLink(query);
            aiDebug.log(`🎬 Generated IMDb Smart Link: ${link}`);
            return `\n${link}`;
        });

        return processed;
    }
}

export const recommendationService = new RecommendationService();
