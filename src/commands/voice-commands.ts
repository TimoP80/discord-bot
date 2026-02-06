import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMember, VoiceChannel } from 'discord.js';
import { voiceService } from '../services/voiceService';
import { voiceChatService } from '../services/voiceChatService';
import { speechToTextService } from '../services/speechToTextService';
import { aiDebug } from '../utils/debugLogger';
import type { User } from '../types';

export const data = new SlashCommandBuilder()
    .setName('voice')
    .setDescription('Voice chat commands')
    .addSubcommand(subcommand =>
        subcommand
            .setName('join')
            .setDescription('Join your current voice channel')
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('leave')
            .setDescription('Leave the voice channel')
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('set-bot')
            .setDescription('Set which bot personality responds in voice chat')
            .addStringOption(option =>
                option
                    .setName('bot-name')
                    .setDescription('Name of the bot personality')
                    .setRequired(true)
            )
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('toggle-listening')
            .setDescription('Enable or disable voice listening')
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('status')
            .setDescription('Show current voice chat status')
    );

export async function execute(interaction: ChatInputCommandInteraction) {
    const subcommand = interaction.options.getSubcommand();

    try {
        switch (subcommand) {
            case 'join':
                await handleJoin(interaction);
                break;
            case 'leave':
                await handleLeave(interaction);
                break;
            case 'set-bot':
                await handleSetBot(interaction);
                break;
            case 'toggle-listening':
                await handleToggleListening(interaction);
                break;
            case 'status':
                await handleStatus(interaction);
                break;
            default:
                await interaction.reply({ content: 'Unknown subcommand', ephemeral: true });
        }
    } catch (error) {
        aiDebug.error('❌ Error executing voice command:', error);
        const errorMessage = error instanceof Error ? error.message : 'An error occurred';

        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: `Error: ${errorMessage}`, ephemeral: true });
        } else {
            await interaction.reply({ content: `Error: ${errorMessage}`, ephemeral: true });
        }
    }
}

async function handleJoin(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();

    // Check if STT is configured
    if (!speechToTextService.isConfigured()) {
        await interaction.editReply('❌ Speech-to-Text service is not configured. Please set up STT_PROVIDER and the corresponding API key in your environment variables.');
        return;
    }

    // Check if user is in a voice channel
    const member = interaction.member as GuildMember;
    const voiceChannel = member.voice.channel;

    if (!voiceChannel) {
        await interaction.editReply('❌ You need to be in a voice channel first!');
        return;
    }

    if (!(voiceChannel instanceof VoiceChannel)) {
        await interaction.editReply('❌ I can only join voice channels, not stage channels.');
        return;
    }

    // Check if already in a voice channel
    if (voiceService.isInVoiceChannel(interaction.guildId!)) {
        await interaction.editReply('⚠️ I\'m already in a voice channel. Use `/voice leave` first.');
        return;
    }

    try {
        aiDebug.log(`🎤 Attempting to join voice channel: ${voiceChannel.name} (${voiceChannel.id})`);

        // Check bot permissions
        const permissions = voiceChannel.permissionsFor(interaction.client.user!);
        if (!permissions) {
            await interaction.editReply('❌ Unable to check permissions for voice channel.');
            return;
        }

        if (!permissions.has('Connect')) {
            await interaction.editReply('❌ I don\'t have permission to **Connect** to this voice channel.');
            return;
        }

        if (!permissions.has('Speak')) {
            await interaction.editReply('❌ I don\'t have permission to **Speak** in this voice channel.');
            return;
        }

        // Join the voice channel
        await voiceService.joinChannel(voiceChannel);

        // Start voice chat session (auto-selection temporarily disabled)
        const selectedBot: User | null = null;



        await voiceChatService.startSession(
            interaction.guildId!,
            voiceChannel.id,
            voiceChannel.name,
            selectedBot
        );

        const botMsg = `\n\n💡 Use \`/voice set-bot <name>\` to choose which bot personality responds.`;

        await interaction.editReply(`✅ Joined voice channel **${voiceChannel.name}** and started listening!${botMsg}`);
    } catch (error) {
        aiDebug.error('❌ Failed to join voice channel:', error);
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        await interaction.editReply(
            `❌ Failed to join voice channel: ${errorMsg}\n\n` +
            `**Troubleshooting:**\n` +
            `• Restart the bot to apply voice intents\n` +
            `• Check bot has Connect & Speak permissions\n` +
            `• Enable GuildVoiceStates intent in Discord Developer Portal`
        );
    }
}

async function handleLeave(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();

    if (!voiceService.isInVoiceChannel(interaction.guildId!)) {
        await interaction.editReply('❌ I\'m not in a voice channel.');
        return;
    }

    try {
        // Stop voice chat session
        voiceChatService.stopSession(interaction.guildId!);

        // Leave the voice channel
        voiceService.leaveChannel(interaction.guildId!);

        await interaction.editReply('✅ Left the voice channel and stopped listening.');
    } catch (error) {
        aiDebug.error('❌ Failed to leave voice channel:', error);
        await interaction.editReply('❌ Failed to leave voice channel.');
    }
}

async function handleSetBot(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();

    const botName = interaction.options.getString('bot-name', true);

    if (!voiceChatService.hasSession(interaction.guildId!)) {
        await interaction.editReply('❌ No active voice chat session. Use `/voice join` first.');
        return;
    }

    try {
        // Load personalities from config
        const { loadConfig } = await import('../utils/config');
        const config = await loadConfig();

        if (!config || !config.userObjects || config.userObjects.length === 0) {
            await interaction.editReply('❌ No bot personalities found in configuration. Please configure bot personalities first.');
            return;
        }

        // Find the bot personality by nickname
        const botPersonality = config.userObjects.find(
            user => user.nickname.toLowerCase() === botName.toLowerCase()
        );

        if (!botPersonality) {
            // List available personalities
            const availableBots = config.userObjects
                .filter(u => u.userType === 'virtual' || u.userType === 'bot')
                .map(u => u.nickname)
                .join(', ');

            await interaction.editReply(
                `❌ Bot personality "${botName}" not found.\n\n` +
                `Available personalities: ${availableBots || 'None'}`
            );
            return;
        }

        // Set the bot personality for voice chat
        voiceChatService.setBotPersonality(interaction.guildId!, botPersonality);

        // Check if voice ID is configured
        const voiceInfo = botPersonality.elevenLabsVoiceId
            ? `\n🎤 Voice: ${botPersonality.elevenLabsVoiceId.substring(0, 8)}...`
            : '\n⚠️ No ElevenLabs voice ID configured for this bot';

        await interaction.editReply(
            `✅ Set voice chat bot to **${botPersonality.nickname}**\n` +
            `📝 Personality: ${botPersonality.personality.substring(0, 100)}...${voiceInfo}`
        );
    } catch (error) {
        aiDebug.error('❌ Error loading bot personality:', error);
        await interaction.editReply('❌ Failed to load bot personality from configuration.');
    }
}

async function handleToggleListening(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();

    if (!voiceChatService.hasSession(interaction.guildId!)) {
        await interaction.editReply('❌ No active voice chat session. Use `/voice join` first.');
        return;
    }

    const isListening = voiceChatService.toggleListening(interaction.guildId!);

    await interaction.editReply(`${isListening ? '🎧' : '🔇'} Voice listening ${isListening ? 'enabled' : 'disabled'}`);
}

async function handleStatus(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();

    const session = voiceChatService.getSession(interaction.guildId!);

    if (!session) {
        await interaction.editReply('❌ No active voice chat session.');
        return;
    }

    const sttConfig = speechToTextService.getConfig();
    const botName = session.activeBotPersonality?.nickname || 'None';
    const historyCount = session.conversationHistory.length;

    const statusMessage = `**Voice Chat Status**

📍 Channel: **${session.channelName}**
🤖 Active Bot: **${botName}**
🎧 Listening: ${session.isListening ? '✅ Enabled' : '❌ Disabled'}
🎙️ STT Provider: **${sttConfig.provider}**
💬 Conversation History: **${historyCount}** messages
🌐 Language: **${sttConfig.language}**`;

    await interaction.editReply(statusMessage);
}
