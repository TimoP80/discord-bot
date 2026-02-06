declare module 'yt-search' {
    interface SearchResult {
        title: string;
        url: string;
        description: string;
        timestamp: string;
        views: number;
        ago: string;
        image: string;
        thumbnail: string;
        seconds: number;
        author: {
            name: string;
            url: string;
        };
    }

    interface SearchOptions {
        query?: string;
        search?: string;
    }

    interface SearchResponse {
        videos: SearchResult[];
        playlists: any[];
        lists: any[];
        accounts: any[];
    }

    function search(query: string | SearchOptions): Promise<SearchResponse>;
    function search(query: string | SearchOptions, callback: (err: any, data: SearchResponse) => void): void;

    export = search;
}
