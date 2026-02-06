import { CommandInteraction, SlashCommandBuilder, CacheType, AttachmentBuilder } from 'discord.js';
import { botDebug } from '../utils/debugLogger';
import { generateImage } from '../geminiService';

export const generateImageCommand = {
    data: new SlashCommandBuilder()
        .setName('generate-image')
        .setDescription('Generates an image using AI based on your prompt.')
        .addStringOption(option =>
            option.setName('prompt')
                .setDescription('The description of the image to generate.')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('aspect_ratio')
                .setDescription('The aspect ratio of the generated image.')
                .setRequired(false)
                .addChoices(
                    { name: 'Square (1:1)', value: '1:1' },
                    { name: 'Landscape (16:9)', value: '16:9' },
                    { name: 'Portrait (9:16)', value: '9:16' },
                    { name: 'Standard Landscape (4:3)', value: '4:3' },
                    { name: 'Standard Portrait (3:4)', value: '3:4' }
                )),
    async execute(interaction: CommandInteraction<CacheType>) {
        const prompt = (interaction as any).options.getString('prompt');
        const aspectRatio = (interaction as any).options.getString('aspect_ratio') || '1:1';

        await interaction.deferReply();

        botDebug.debug(`Executing generate-image command (Gemini) for prompt: "${prompt}", aspect ratio: ${aspectRatio}`);

        try {
            const imageBuffer = await generateImage(prompt, { aspectRatio });

            if (imageBuffer) {
                const attachment = new AttachmentBuilder(imageBuffer, { name: 'generated-image.png' });
                await interaction.editReply({
                    content: `Here is your generated image for: "${prompt}" (Model: Imagen 4, Ratio: ${aspectRatio})`,
                    files: [attachment]
                });
            } else {
                await interaction.editReply('Sorry, I failed to generate an image. Please try again later.');
            }
        } catch (error) {
            console.error('Error executing generate-image command:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            await interaction.editReply(`❌ **Image Generation Failed**: ${errorMessage}`);
        }
    }
};
