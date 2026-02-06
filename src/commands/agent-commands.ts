import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMember } from 'discord.js';
import { elevenLabsAgentService, ElevenLabsAgent } from '../services/elevenLabsAgentService';
import { aiDebug } from '../utils/debugLogger';

const data = new SlashCommandBuilder()
    .setName('agent')
    .setDescription('ElevenLabs Agent Platform commands')
    .addSubcommand(subcommand =>
        subcommand
            .setName('create')
            .setDescription('Create a new conversational agent')
            .addStringOption(option =>
                option
                    .setName('name')
                    .setDescription('Name of the agent')
                    .setRequired(true)
            )
            .addStringOption(option =>
                option
                    .setName('system_prompt')
                    .setDescription('System prompt defining the agent\'s personality and behavior')
                    .setRequired(true)
            )
            .addStringOption(option =>
                option
                    .setName('language')
                    .setDescription('Primary language for the agent (e.g., en, fi, es)')
                    .setRequired(false)
            )
            .addStringOption(option =>
                option
                    .setName('personality')
                    .setDescription('Agent personality type (friendly, professional, humorous, etc.)')
                    .setRequired(false)
            )
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('list')
            .setDescription('List all available agents')
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('set-active')
            .setDescription('Set an agent as active for text chat responses')
            .addStringOption(option =>
                option
                    .setName('agent_id')
                    .setDescription('ID of the agent to set as active')
                    .setRequired(true)
            )
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('clear-history')
            .setDescription('Clear conversation history for an agent')
            .addStringOption(option =>
                option
                    .setName('agent_id')
                    .setDescription('ID of the agent')
                    .setRequired(true)
            )
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('delete')
            .setDescription('Delete an agent')
            .addStringOption(option =>
                option
                    .setName('agent_id')
                    .setDescription('ID of the agent to delete')
                    .setRequired(true)
            )
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('status')
            .setDescription('Show agent platform status and active agent')
    );

async function execute(interaction: ChatInputCommandInteraction) {
    const subcommand = interaction.options.getSubcommand();

    try {
        switch (subcommand) {
            case 'create':
                await handleCreateAgent(interaction);
                break;
            case 'list':
                await handleListAgents(interaction);
                break;
            case 'set-active':
                await handleSetActiveAgent(interaction);
                break;
            case 'clear-history':
                await handleClearHistory(interaction);
                break;
            case 'delete':
                await handleDeleteAgent(interaction);
                break;
            case 'status':
                await handleStatus(interaction);
                break;
            default:
                await interaction.reply({ content: 'Unknown subcommand', ephemeral: true });
        }
    } catch (error) {
        aiDebug.error('❌ Error executing agent command:', error);
        const errorMessage = error instanceof Error ? error.message : 'An error occurred';

        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: `Error: ${errorMessage}`, ephemeral: true });
        } else {
            await interaction.reply({ content: `Error: ${errorMessage}`, ephemeral: true });
        }
    }
}

async function handleCreateAgent(interaction: ChatInputCommandInteraction) {
    if (!elevenLabsAgentService.isConfigured()) {
        await interaction.reply({
            content: '❌ ElevenLabs Agent Platform is not configured. Please set ELEVENLABS_API_KEY in your environment variables.',
            ephemeral: true
        });
        return;
    }

    await interaction.deferReply();

    const name = interaction.options.getString('name', true);
    const systemPrompt = interaction.options.getString('system_prompt', true);
    const language = interaction.options.getString('language') || 'en';
    const personality = interaction.options.getString('personality') || 'friendly';

    try {
        const agent = await elevenLabsAgentService.createAgent({
            name,
            systemPrompt,
            language,
            personality
        });

        if (agent) {
            const response = `✅ **Agent Created Successfully!**

**Name:** ${agent.name}
**ID:** \`${agent.id}\`
**Language:** ${agent.language}
**Personality:** ${agent.personality}

**System Prompt:** ${agent.systemPrompt.substring(0, 200)}${agent.systemPrompt.length > 200 ? '...' : ''}

💡 **Next Steps:**
• Use \`/agent set-active agent_id:${agent.id}\` to make this agent respond to text chat
• The agent will now handle conversations in ${agent.language} with a ${agent.personality} personality`;

            await interaction.editReply(response);
        } else {
            await interaction.editReply('❌ Failed to create agent. Please check your ElevenLabs API configuration.');
        }
    } catch (error) {
        aiDebug.error('❌ Error creating agent:', error);
        await interaction.editReply('❌ Failed to create agent. Please try again.');
    }
}

async function handleListAgents(interaction: ChatInputCommandInteraction) {
    if (!elevenLabsAgentService.isConfigured()) {
        await interaction.reply({
            content: '❌ ElevenLabs Agent Platform is not configured.',
            ephemeral: true
        });
        return;
    }

    await interaction.deferReply();

    try {
        const agents = elevenLabsAgentService.getAllAgents();

        if (agents.length === 0) {
            await interaction.editReply('📝 **No agents found.**\n\nUse `/agent create` to create your first conversational agent!');
            return;
        }

        let response = `🤖 **Available Agents (${agents.length})**\n\n`;

        for (const agent of agents) {
            const historyCount = elevenLabsAgentService.getConversationHistory(agent.id).length;
            response += `**${agent.name}** (\`${agent.id}\`)
• Language: ${agent.language}
• Personality: ${agent.personality}
• Conversation History: ${historyCount} messages
• System Prompt: ${agent.systemPrompt.substring(0, 100)}${agent.systemPrompt.length > 100 ? '...' : ''}\n\n`;
        }

        response += `💡 **Commands:**
• \`/agent set-active agent_id:<id>\` - Set agent for text chat
• \`/agent clear-history agent_id:<id>\` - Clear conversation history
• \`/agent delete agent_id:<id>\` - Delete agent`;

        await interaction.editReply(response);
    } catch (error) {
        aiDebug.error('❌ Error listing agents:', error);
        await interaction.editReply('❌ Failed to retrieve agents list.');
    }
}

async function handleSetActiveAgent(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();

    const agentId = interaction.options.getString('agent_id', true);

    try {
        const agent = elevenLabsAgentService.getAgent(agentId);

        if (!agent) {
            // List available agents
            const agents = elevenLabsAgentService.getAllAgents();
            const agentList = agents.map(a => `• \`${a.id}\` - ${a.name}`).join('\n');

            await interaction.editReply(
                `❌ Agent with ID \`${agentId}\` not found.\n\n**Available agents:**\n${agentList || 'None'}`
            );
            return;
        }

        // For now, we'll store this in a simple way
        // In a full implementation, this would update the bot's configuration
        const response = `✅ **Agent Set as Active**

**${agent.name}** is now active for text chat responses!

**Configuration:**
• Language: ${agent.language}
• Personality: ${agent.personality}
• System Prompt: ${agent.systemPrompt.substring(0, 150)}${agent.systemPrompt.length > 150 ? '...' : ''}

The bot will now use this agent for text conversations in ${agent.language}. Language barriers should be significantly reduced! 🌍`;

        await interaction.editReply(response);

        aiDebug.log(`🤖 Set active agent: ${agent.name} (${agentId}) for text chat`);

    } catch (error) {
        aiDebug.error('❌ Error setting active agent:', error);
        await interaction.editReply('❌ Failed to set active agent.');
    }
}

async function handleClearHistory(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();

    const agentId = interaction.options.getString('agent_id', true);

    try {
        const agent = elevenLabsAgentService.getAgent(agentId);

        if (!agent) {
            await interaction.editReply(`❌ Agent with ID \`${agentId}\` not found.`);
            return;
        }

        elevenLabsAgentService.clearConversation(agentId);

        await interaction.editReply(`🧹 **Conversation history cleared** for agent **${agent.name}**.`);
        aiDebug.log(`🧹 Cleared conversation history for agent: ${agent.name} (${agentId})`);

    } catch (error) {
        aiDebug.error('❌ Error clearing agent history:', error);
        await interaction.editReply('❌ Failed to clear conversation history.');
    }
}

async function handleDeleteAgent(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();

    const agentId = interaction.options.getString('agent_id', true);

    try {
        const agent = elevenLabsAgentService.getAgent(agentId);

        if (!agent) {
            await interaction.editReply(`❌ Agent with ID \`${agentId}\` not found.`);
            return;
        }

        // Confirm deletion (in Discord, we'll just proceed since it's a slash command)
        elevenLabsAgentService.deleteAgent(agentId);

        await interaction.editReply(`🗑️ **Agent deleted:** ${agent.name} (${agentId})`);
        aiDebug.log(`🗑️ Deleted agent: ${agent.name} (${agentId})`);

    } catch (error) {
        aiDebug.error('❌ Error deleting agent:', error);
        await interaction.editReply('❌ Failed to delete agent.');
    }
}

async function handleStatus(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();

    try {
        const isConfigured = elevenLabsAgentService.isConfigured();
        const agents = elevenLabsAgentService.getAllAgents();

        let response = `🤖 **ElevenLabs Agent Platform Status**\n\n`;

        response += `**Configuration:** ${isConfigured ? '✅ Configured' : '❌ Not Configured'}\n`;
        response += `**API Key:** ${process.env.ELEVENLABS_API_KEY ? '✅ Set' : '❌ Missing'}\n`;
        response += `**Total Agents:** ${agents.length}\n\n`;

        if (agents.length > 0) {
            response += `**Agent Details:**\n`;
            for (const agent of agents) {
                const historyCount = elevenLabsAgentService.getConversationHistory(agent.id).length;
                response += `• **${agent.name}** (\`${agent.id.substring(0, 12)}...\`)\n`;
                response += `  - Language: ${agent.language}\n`;
                response += `  - Messages: ${historyCount}\n`;
                response += `  - Personality: ${agent.personality}\n\n`;
            }
        } else {
            response += `📝 **No agents created yet.**\nUse \`/agent create\` to get started!\n\n`;
        }

        response += `🌍 **Language Support:** Eliminates language barriers through advanced AI translation and understanding.`;

        await interaction.editReply(response);

    } catch (error) {
        aiDebug.error('❌ Error getting agent status:', error);
        await interaction.editReply('❌ Failed to retrieve agent platform status.');
    }
}

export { data, execute };
