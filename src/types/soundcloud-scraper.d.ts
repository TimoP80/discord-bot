declare module 'soundcloud-scraper' {
    export interface ClientOptions {
        fetchAPIKey?: boolean;
    }

    export interface SearchOptions {
        type?: 'all' | 'user' | 'track' | 'playlist' | 'artist';
        limit?: number;
    }

    export interface TrackInfo {
        title: string;
        url: string;
        description: string;
        duration: number;
        genre: string;
        author: {
            name: string;
            username: string;
            url: string;
        };
    }

    export interface SearchResult {
        title: string;
        url: string;
        description?: string;
        type: string;
    }

    export class Client {
        constructor(apiKey?: string, options?: ClientOptions);
        getSongInfo(url: string, options?: { fetchEmbed?: boolean }): Promise<TrackInfo>;
        search(query: string, type?: string): Promise<SearchResult[]>;
        search(query: string, type?: string, limit?: number): Promise<SearchResult[]>;
    }
}
