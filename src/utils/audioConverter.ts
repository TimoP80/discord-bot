import { OpusEncoder } from '@discordjs/opus';
import { spawn } from 'child_process';

/**
 * Audio conversion utilities for Discord voice chat
 * Converts raw Opus packets to PCM/WAV format for STT services
 */
export class AudioConverter {
    /**
     * Convert raw Opus audio to WAV PCM
     * Discord sends raw Opus codec data at 48kHz stereo
     */
    /**
     * Convert PCM audio to WAV
     * Input is already decoded PCM (16-bit, 48kHz, stereo)
     */
    static async pcmToWav(pcmBuffer: Buffer): Promise<Buffer> {
        console.log(`[AudioConverter] Wrapping ${pcmBuffer.length} bytes of PCM in WAV header...`);

        try {
            // Create WAV header for the PCM data
            const wavHeader = this.createWavHeader(
                pcmBuffer.length,
                48000, // Sample rate
                2,     // Channels (stereo)
                16     // Bits per sample
            );

            const wavBuffer = Buffer.concat([wavHeader, pcmBuffer]);
            console.log(`[AudioConverter] ✅ Created WAV file: ${wavBuffer.length} bytes`);

            return wavBuffer;
        } catch (error) {
            console.error('[AudioConverter] ❌ WAV creation failed:', error);
            throw error;
        }
    }

    /**
     * Create WAV file header
     */
    private static createWavHeader(
        dataLength: number,
        sampleRate: number,
        channels: number,
        bitsPerSample: number
    ): Buffer {
        const header = Buffer.alloc(44);

        // RIFF chunk descriptor
        header.write('RIFF', 0);
        header.writeUInt32LE(36 + dataLength, 4);
        header.write('WAVE', 8);

        // fmt sub-chunk
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
        header.writeUInt16LE(1, 20); // AudioFormat (1 for PCM)
        header.writeUInt16LE(channels, 22);
        header.writeUInt32LE(sampleRate, 24);
        header.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28); // ByteRate
        header.writeUInt16LE(channels * (bitsPerSample / 8), 32); // BlockAlign
        header.writeUInt16LE(bitsPerSample, 34);

        // data sub-chunk
        header.write('data', 36);
        header.writeUInt32LE(dataLength, 40);

        return header;
    }
}
