import ytSearch from 'yt-search';
import { aiDebug } from '../utils/debugLogger';

export class YouTubeService {
    /**
     * Searches for a YouTube video and returns the URL of the first result.
     * @param query The search query.
     * @returns The URL of the first video result, or null if no results found.
     */
    public async searchVideo(query: string): Promise<string | null> {
        try {
            aiDebug.log(`🔍 Searching YouTube for: "${query}"`);
            const r = await ytSearch(query);

            if (r && r.videos.length > 0) {
                const video = r.videos[0];
                aiDebug.log(`✅ Found YouTube video: ${video.title} (${video.url})`);
                return video.url;
            }

            aiDebug.warn(`⚠️ No YouTube results found for query: "${query}"`);
            return null;
        } catch (error) {
            aiDebug.error('❌ Error searching YouTube:', error);
            return null;
        }
    }
}

export const youtubeService = new YouTubeService();
