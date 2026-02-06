declare module 'google-tts-api' {
    interface GetAudioUrlOptions {
        lang?: string;
        slow?: boolean;
        host?: string;
    }

    export function getAudioUrl(text: string, options?: GetAudioUrlOptions): string;
}