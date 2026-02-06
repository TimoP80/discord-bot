import {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    entersState,
    VoiceConnectionStatus,
    AudioPlayerStatus,
    VoiceConnection,
    AudioPlayer,
    EndBehaviorType
} from '@discordjs/voice';
import { VoiceChannel } from 'discord.js';
import { aiDebug } from '../utils/debugLogger';
import { Readable } from 'stream';

/**
 * Service for managing Discord voice connections and audio streaming
 */
export class VoiceService {
    private connections: Map<string, VoiceConnection> = new Map();
    private players: Map<string, AudioPlayer> = new Map();
    private audioStreams: Map<string, Readable> = new Map();

    /**
     * Join a voice channel
     */
    public async joinChannel(channel: VoiceChannel): Promise<VoiceConnection> {
        aiDebug.log(`🎤 Joining voice channel: ${channel.name} (${channel.id})`);

        try {
            const connection = joinVoiceChannel({
                channelId: channel.id,
                guildId: channel.guild.id,
                adapterCreator: channel.guild.voiceAdapterCreator as any,
                selfDeaf: false,
                selfMute: false
            });

            // Wait for connection to be ready
            await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
            aiDebug.log(`✅ Successfully joined voice channel: ${channel.name}`);
            console.log(`[VOICE] ✅ Successfully joined voice channel: ${channel.name}`);

            // Create audio player for this connection
            const player = createAudioPlayer();
            connection.subscribe(player);

            // Store connection and player
            this.connections.set(channel.guild.id, connection);
            this.players.set(channel.guild.id, player);

            // Set up event handlers
            this.setupConnectionHandlers(connection, channel.guild.id);
            this.setupPlayerHandlers(player, channel.guild.id);

            return connection;
        } catch (error) {
            aiDebug.error(`❌ Failed to join voice channel: ${channel.name}`, error);
            throw error;
        }
    }

    /**
     * Leave a voice channel
     */
    public leaveChannel(guildId: string): void {
        aiDebug.log(`🚪 Leaving voice channel for guild: ${guildId}`);

        const connection = this.connections.get(guildId);
        if (connection) {
            connection.destroy();
            this.connections.delete(guildId);
        }

        const player = this.players.get(guildId);
        if (player) {
            player.stop();
            this.players.delete(guildId);
        }

        this.audioStreams.delete(guildId);
        aiDebug.log(`✅ Left voice channel for guild: ${guildId}`);
    }

    /**
     * Play audio in a voice channel
     */
    public async playAudio(guildId: string, audioBuffer: Buffer): Promise<void> {
        const player = this.players.get(guildId);
        if (!player) {
            throw new Error('No audio player found for this guild. Join a voice channel first.');
        }

        aiDebug.log(`🔊 Playing audio in guild: ${guildId} (${audioBuffer.length} bytes)`);

        try {
            // Create audio stream from buffer
            const stream = Readable.from(audioBuffer);
            const resource = createAudioResource(stream);

            // Play the audio
            player.play(resource);

            // Wait for audio to START playing
            await entersState(player, AudioPlayerStatus.Playing, 5_000);
            aiDebug.log(`✅ Audio playback started for guild: ${guildId}`);

            // Wait for audio to FINISH playing (reach Idle state)
            // This prevents the bot from listening to itself or processing new inputs while speaking
            await entersState(player, AudioPlayerStatus.Idle, 60_000); // 60s max timeout for speech
            aiDebug.log(`✅ Audio playback finished for guild: ${guildId}`);
        } catch (error) {
            aiDebug.error(`❌ Failed to play audio in guild: ${guildId}`, error);
            throw error;
        }
    }

    /**
     * Start receiving audio from a voice channel
     */
    public startReceiving(guildId: string, callback: (audioBuffer: Buffer, userId: string) => void): void {
        const connection = this.connections.get(guildId);
        if (!connection) {
            throw new Error('No voice connection found for this guild. Join a voice channel first.');
        }

        aiDebug.log(`🎧 Starting to receive audio in guild: ${guildId}`);

        // Set up audio receiver
        connection.receiver.speaking.on('start', (userId) => {
            aiDebug.log(`👤 User ${userId} started speaking`);
            // console.log(`[VOICE] 👤 User ${userId} started speaking`);

            const audioStream = connection.receiver.subscribe(userId, {
                end: {
                    behavior: EndBehaviorType.AfterSilence,
                    duration: 2000 // 2 seconds of silence
                }
            });

            const audioChunks: Buffer[] = [];

            // We need to decode Opus packets to PCM as they arrive
            // because concatenating Opus packets invalidates the stream
            // Dynamic import would be better but for now we require it here
            // We'll use a try-catch to handle the import if it's missing, though it's key functionality
            let encoder: any;
            try {
                const { OpusEncoder } = require('@discordjs/opus');
                encoder = new OpusEncoder(48000, 2);
            } catch (e) {
                aiDebug.error('Failed to load @discordjs/opus encoder', e);
            }

            audioStream.on('data', (chunk: Buffer) => {
                if (encoder) {
                    try {
                        // Decode Opus packet to PCM
                        const pcm = encoder.decode(chunk);
                        audioChunks.push(pcm);
                    } catch (e) {
                        // Ignore decode errors for bad packets
                    }
                } else {
                    // Fallback to raw chunks (will fail downstream but prevents crash here)
                    audioChunks.push(chunk);
                }
            });

            audioStream.on('end', () => {
                aiDebug.log(`🔇 User ${userId} stopped speaking (${audioChunks.length} chunks)`);
                // console.log(`[VOICE] 🔇 User ${userId} stopped speaking (${audioChunks.length} chunks)`);

                if (audioChunks.length > 0) {
                    const audioBuffer = Buffer.concat(audioChunks);

                    // Filter out very short audio (less than 0.5s) to avoid triggering on background noise
                    // 48kHz * 2 channels * 2 bytes/sample * 0.5s = 96,000 bytes
                    if (audioBuffer.length < 96000) {
                        aiDebug.log(`⚠️ Audio too short (${audioBuffer.length} bytes), ignoring (likely noise)`);
                        return;
                    }

                    callback(audioBuffer, userId);
                }
            });

            audioStream.on('error', (error) => {
                aiDebug.error(`❌ Audio stream error for user ${userId}:`, error);
            });
        });
    }

    /**
     * Stop receiving audio from a voice channel
     */
    public stopReceiving(guildId: string): void {
        const connection = this.connections.get(guildId);
        if (connection) {
            connection.receiver.speaking.removeAllListeners();
            aiDebug.log(`🔇 Stopped receiving audio in guild: ${guildId}`);
        }
    }

    /**
     * Get the current voice connection for a guild
     */
    public getConnection(guildId: string): VoiceConnection | undefined {
        return this.connections.get(guildId);
    }

    /**
     * Check if bot is in a voice channel in a guild
     */
    public isInVoiceChannel(guildId: string): boolean {
        const connection = this.connections.get(guildId);
        return connection !== undefined && connection.state.status !== VoiceConnectionStatus.Destroyed;
    }

    /**
     * Set up connection event handlers
     */
    private setupConnectionHandlers(connection: VoiceConnection, guildId: string): void {
        connection.on('stateChange', (oldState, newState) => {
            aiDebug.log(`🔄 Voice connection state changed: ${oldState.status} -> ${newState.status} (guild: ${guildId})`);
        });

        connection.on('error', (error) => {
            aiDebug.error(`❌ Voice connection error (guild: ${guildId}):`, error);
        });

        connection.on(VoiceConnectionStatus.Disconnected, async () => {
            aiDebug.warn(`⚠️ Voice connection disconnected (guild: ${guildId})`);

            try {
                // Try to reconnect
                await Promise.race([
                    entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                    entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
                ]);
                aiDebug.log(`✅ Reconnected to voice channel (guild: ${guildId})`);
            } catch (error) {
                aiDebug.error(`❌ Failed to reconnect, destroying connection (guild: ${guildId})`);
                connection.destroy();
                this.connections.delete(guildId);
            }
        });
    }

    /**
     * Set up audio player event handlers
     */
    private setupPlayerHandlers(player: AudioPlayer, guildId: string): void {
        player.on('stateChange', (oldState, newState) => {
            aiDebug.log(`🔄 Audio player state changed: ${oldState.status} -> ${newState.status} (guild: ${guildId})`);
        });

        player.on('error', (error) => {
            aiDebug.error(`❌ Audio player error (guild: ${guildId}):`, error);
        });

        player.on(AudioPlayerStatus.Idle, () => {
            aiDebug.log(`⏸️ Audio player idle (guild: ${guildId})`);
        });
    }
}

export const voiceService = new VoiceService();
