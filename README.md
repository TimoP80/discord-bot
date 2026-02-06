# Discord Bot

A Discord bot featuring a **multi-provider AI system** with enterprise-grade reliability, supporting multiple bot instances, each with its own unique personality. **Now with cloud-first reliability and rate-limit free operation!**

## Features

*   **🚀 Multi-Provider AI System**: Enterprise-grade reliability with 7 AI providers (OllamaCloud, Gemini, OpenAI, Anthropic, AI/ML API, Custom APIs, Local Ollama)
*   **☁️ Cloud-First Reliability**: Primary OllamaCloud (mistral-large-3:675b) with intelligent 6-layer fallback system - **no more rate limits!**
*   **🇫🇮 Perfect Finnish Language**: Optimized for Finnish with 100/100 quality scores, cultural understanding, and personality consistency
*   **⚡ Fast Response Times**: Cloud-speed responses (2-5 seconds) with 2000 token capacity for complete messages
*   **🔄 Intelligent Fallback**: Automatic provider switching based on availability, priority, and language requirements
*   **🛡️ Enterprise Reliability**: Zero downtime with multi-provider redundancy and health monitoring
*   **🎭 Multi-Bot Support**: Run multiple bot instances from a single application, each with its own personality, token, and configuration.
*   **🧠 Conversational AI**: Powered by advanced AI models with natural, human-like conversations and personality preservation.
*   **🎨 Customizable Personality**: Define each bot's personality, including its nickname, writing style, humor, and more, through external JSON files.
*   **📊 Probabilistic Response**: Each bot's response frequency is controlled by a configurable probability, preventing it from replying to every message and creating a more organic interaction.
*   **💬 Idle Chatter**: Keep conversations alive with a feature that allows each bot to send messages automatically when a channel has been inactive for a specified period.
*   **⏰ Delayed Reactions**: Bots can identify and respond to interesting but unanswered messages from the chat history, adding a unique layer of conversational depth.
*   **📩 Direct Message Support**: Each bot is fully functional in direct messages, with a separate response probability for more frequent interaction in private conversations.
*   **🖼️ Multimedia Support**: Bots can analyze and comment on images, as well as transcribe and respond to audio messages in both channels and private messages, making them versatile conversational partners.
*   **🐛 Debug Logging**: Enable detailed debug logging for development and troubleshooting to gain insight into the bot's operations.
*   **🎮 Simulation Controller**: Controls to start, stop, pause, and resume simulations for bot testing and development.
*   **🌐 Gemini AI Enhancements**: Support for generating random world configurations, validating API keys and models, and listing available models.
*   **🔄 Free AI Fallbacks**: Multiple free AI services including Ollama (local) and cloud providers as fallbacks when premium services are unavailable.
*   **⚙️ Configuration Management**: Services for initializing, auto-refreshing, and syncing application configurations.
*   **🎤 Advanced Speech-to-Text**: Supports multiple STT providers including ElevenLabs Scribe v2 and local Whisper for high-accuracy voice transcription.

## Installation

1. Clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file in the root directory and add your API keys and Discord bot tokens. The bot now uses a **multi-provider AI system** with OllamaCloud as the primary provider for optimal Finnish language quality and reliability.

   ```bash
   # Primary: OllamaCloud (mistral-large-3:675b) - Best Finnish quality
   OLLAMA_API_KEY=your_ollama_cloud_api_key
   OLLAMA_CLOUD_ENABLED=true
   OLLAMA_CLOUD_MODEL=mistral-large-3:675b
   OLLAMA_CLOUD_PRIORITY=1
   OLLAMA_CLOUD_TEMPERATURE=0.8
   OLLAMA_CLOUD_MAX_TOKENS=2000

   # Backup: Gemini (when available)
   GEMINI_API_KEY=your_gemini_api_key
   GEMINI_ENABLED=true
   GEMINI_PRIORITY=2
   GEMINI_MODEL=gemini-2.5-flash-lite
   GEMINI_TEMPERATURE=0.8
   GEMINI_MAX_TOKENS=2000

   # Local Fallback: Ultimate reliability
   USE_OLLAMA=true
   OLLAMA_PRIORITY=3
   OLLAMA_BASE_URL=http://localhost:11434
   OLLAMA_MODEL=llama3.1:8b
   OLLAMA_TEMPERATURE=0.7
   OLLAMA_MAX_TOKENS=1200

   # Discord Bot Configuration
   TOKEN_TIIAV=your_discord_bot_token_for_tiiav
   TOKEN_SEKOBOLTSI=your_discord_bot_token_for_sekoboltsi
   DISCORD_CLIENT_ID=your_discord_client_id

   # Optional: Additional Providers
   OPENAI_API_KEY=your_openai_api_key
   ANTHROPIC_API_KEY=your_anthropic_api_key
   AIML_API_KEY=your_aiml_api_key

   # Optional: ElevenLabs Agent Platform
   ELEVENLABS_API_KEY=your_elevenlabs_api_key
   ```

### 🚀 Multi-Provider AI System

The bot features an **enterprise-grade multi-provider AI system** that automatically selects the best available provider:

#### **Provider Priority (Default Configuration):**
1. **🥇 OllamaCloud (mistral-large-3:675b)** - Primary: Perfect Finnish (100/100 quality)
2. **🥈 Gemini (gemini-2.5-flash-lite)** - Backup: Excellent when available
3. **🥉 Local Ollama** - Fallback: Always available offline
4. **🤖 Others** - Additional: OpenAI, Anthropic, AI/ML API, Custom APIs

#### **Key Benefits:**
- ✅ **Zero Rate Limits**: Primary cloud provider with intelligent fallback
- ✅ **Perfect Finnish**: Optimized for Finnish language and culture
- ✅ **Fast Responses**: Cloud-speed (2-5 seconds) with 2000 token capacity
- ✅ **Maximum Reliability**: 6-layer fallback system ensures 100% uptime
- ✅ **Cost Effective**: Primary provider is free with excellent quality

#### **Getting OllamaCloud API Key:**
1. Visit [https://ollama.com/settings/keys](https://ollama.com/settings/keys)
2. Create a free account and generate an API key
3. Add `OLLAMA_API_KEY=your_key_here` to your `.env` file

#### **Provider Configuration:**
Each provider can be configured with:
- `enabled`: Enable/disable provider
- `priority`: Selection priority (1 = highest)
- `temperature`: Creativity level (0.7-0.9 recommended)
- `maxTokens`: Response length limit
- `model`: Specific model to use

4. Go to the Discord Developer Portal, select your application, and go to the "Bot" tab. Under "Privileged Gateway Intents," enable the following:
   - `MESSAGE CONTENT INTENT`
5. Create a `bots.json` file in the root directory to configure your bots. Make sure each bot has a `name` field that matches its token in the `.env` file.
   ```json
   [
     {
       "name": "TiiaV",
       "personalityFilePath": "path/to/your/personality.json",
       "targetChannelId": "YOUR_TARGET_CHANNEL_ID",
       "responseProbability": 0.20,
       "idleChatterEnabled": true,
       "delayedReactionEnabled": true,
       "useElevenLabsAgent": false,
       "elevenLabsAgentId": null,
       "elevenLabsAgentLanguage": "en"
     },
     {
       "name": "SekoBoltsi",
       "personalityFilePath": "path/to/your/personality.json",
       "targetChannelId": "YOUR_TARGET_CHANNEL_ID",
       "responseProbability": 0.20,
       "idleChatterEnabled": true,
       "delayedReactionEnabled": true,
       "useElevenLabsAgent": true,
       "elevenLabsAgentId": "agent_finnish_helper",
       "elevenLabsAgentLanguage": "fi"
     }
   ]
   ```

### ElevenLabs Agent Platform Configuration

To eliminate language barriers and improve conversational AI, you can configure bots to use ElevenLabs Agent Platform for text chat:

- `useElevenLabsAgent`: Set to `true` to enable agent platform for this bot
- `elevenLabsAgentId`: The ID of the agent to use (create agents with `/agent create`)
- `elevenLabsAgentLanguage`: Primary language for the agent (e.g., "en", "fi", "es", "fr")

**Benefits:**
- 🌍 **Language Agnostic**: Handles multiple languages seamlessly
- 🧠 **Contextual Understanding**: Maintains conversation history and context
- 🎯 **Personality-Driven**: Agents respond based on their configured personality
- 🔄 **Fallback Support**: Falls back to Gemini if agent platform is unavailable

## Usage

- To run the bot in development mode:
  ```bash
  npm start
  ```

- To build the project for production:
  ```bash
  npm run build
  ```

- To run the bot in production mode:
  ```bash
  npm run start:prod
  ```

- To list available Gemini models:
  ```bash
  npm run list-models
  ```

- To generate an invite link for your bot:
 ```bash
 npm run generate-invite
 ```

## Commands

- `!save`: Manually saves the current settings.
- `!topic <new_topic>`: Sets the channel topic.
- `!language <language>`: Sets the dominant language for the channel.
- `!setname <new_name>`: Sets the nickname for the human user.
- `!status <text>`: Sets the bot's status and the voice chat context for the current guild.

### Slash Commands

- `botMute`: Mute a bot
- `botUnmute`: Unmute a bot
- `botMsgRate`: Set message rate for a bot
- `listApps`: List all available applications
- `simStart`: Start a simulation
- `simStop`: Stop a simulation
- `simPause`: Pause a simulation
- `simResume`: Resume a simulation

### ElevenLabs Agent Commands

- `/agent create`: Create a new conversational agent
- `/agent list`: List all available agents
- `/agent set-active`: Set an agent as active for text chat responses
- `/agent clear-history`: Clear conversation history for an agent
- `/agent delete`: Delete an agent
- `/agent status`: Show agent platform status and active agent
- `/agent-gui`: Open the ElevenLabs Agent Management GUI (desktop app only)

## Desktop GUI Application

The project now includes a full Electron-based desktop GUI for managing agents and bot configurations:

### Running the GUI

```bash
# Build the project first
npm run build

# Then run the Electron GUI
npm run electron

# Or do both in one command (development mode)
npm run electron:dev

# Test GUI functionality
npm run test:electron

# View full GUI feature demo
npm run demo:full-gui
```

### GUI Features

#### 🏠 Main Control Panel
- **Unified Dashboard**: Central hub for accessing all bot management tools
- **Quick Access Buttons**: Direct links to Agent Manager, Bot Configuration, Simulation Control, and Logs
- **Status Overview**: Real-time status of all GUI windows and services
- **Menu Integration**: Keyboard shortcuts for power users (File menu, Ctrl+A, Ctrl+B, etc.)

#### 🤖 Agent Manager
- **Visual Agent Creation**: Create agents with custom personalities, languages, and system prompts
- **Agent Dashboard**: View all your agents with their configurations and status
- **Real-time Testing**: Test agent conversations directly in the GUI with live chat interface
- **Conversation History**: View and manage conversation history for each agent
- **Agent Management**: Delete agents and clear their conversation history
- **Multi-language Support**: Create agents for English, Finnish, Spanish, French, German, and more

#### ⚙️ Bot Configuration Manager
- **Bot Overview**: Visual dashboard of all configured bots with status indicators
- **Personality Editor**: Edit bot personalities, language skills, and writing styles
- **Behavior Controls**: Configure response probabilities, idle chatter, and reaction settings
- **ElevenLabs Integration**: Link bots to specific agents and configure language settings
- **Import/Export**: Backup and restore bot configurations
- **Add New Bots**: Create new bots with Discord tokens and initial configurations

#### 🎭 Simulation Control Center
- **Real-time Status**: Live simulation status with uptime tracking and statistics
- **Speed Controls**: Adjust simulation speed from 0.25x to 10x for testing different scenarios
- **Activity Monitoring**: View live simulation activity and bot interactions
- **Configuration Panel**: Customize response probabilities, message limits, and random events
- **Statistics Dashboard**: Track messages generated, active bots, and simulation uptime
- **Start/Pause/Stop Controls**: Full simulation lifecycle management

#### 📊 Logs & Analytics Dashboard
- **Real-time Metrics**: Live dashboard with message counts, bot activity, errors, and response times
- **Activity Logs**: Comprehensive logging with filtering by time range, log level, and bot
- **Performance Analytics**: Top active bots and popular channels analytics
- **System Monitoring**: Health status indicators for APIs and services
- **Export Functionality**: Export logs and analytics data for external analysis
- **Auto-refresh**: Real-time updates with manual refresh options

### Keyboard Shortcuts & Navigation

- **Ctrl+A / Cmd+A**: Open Agent Manager
- **Ctrl+B / Cmd+B**: Open Bot Configuration
- **Ctrl+S / Cmd+S**: Open Simulation Control
- **Ctrl+L / Cmd+L**: Open Logs & Analytics
- **Ctrl+Shift+A / Cmd+Shift+A**: Alternative Agent Manager shortcut

### GUI Usage Guide

#### Agent Manager
- **Creating Agents**: Click "Create Agent" and fill in personality details
- **Testing Agents**: Select an agent and use the "Test" button for live conversation
- **Managing History**: View conversation history in modal dialogs
- **Language Support**: Choose from multiple languages (EN, FI, ES, FR, DE, etc.)

#### Bot Configuration
- **Editing Settings**: Select a bot to modify personality, behavior, and ElevenLabs settings
- **Adding Bots**: Use "Add Bot" to create new bot configurations
- **Import/Export**: Backup your bot configurations for migration or recovery
- **Real-time Updates**: Changes apply immediately with visual feedback

#### Simulation Control
- **Speed Adjustment**: Use speed multiplier for different testing scenarios
- **Activity Monitoring**: Watch live simulation activity in real-time
- **Statistics Tracking**: Monitor message counts and bot activity metrics
- **Lifecycle Control**: Start, pause, and stop simulations as needed

#### Logs & Analytics
- **Filtering**: Use time range, log level, and bot filters to focus on specific data
- **Performance Monitoring**: Track response times, error rates, and bot activity
- **Export Data**: Download logs for external analysis or compliance
- **Auto-refresh**: Logs update automatically with manual refresh available

### Keyboard Shortcuts
- `Ctrl+A` / `Cmd+A`: Open Agent Manager
- `Ctrl+Shift+A` / `Cmd+Shift+A`: Open Agent Manager (alternative)
- Standard Electron shortcuts for window management

## Bot Management Commands

The bot includes CLI commands for managing bot configurations. These commands are run using `npm run manage-bots -- <command>`.

### Available Commands

- `search [query]`: Search for available personalities by name. If no query is provided, lists all available personalities.
- `add <nickname>`: Add a personality from the default configuration to the active bots configuration.
- `import`: Automatically import bots from environment variables that have matching personalities.
- `recreate-credentials`: Add missing bot credentials to the .env file based on configured bots.
- `update-personality <nickname> <new personality>`: Update a bot's personality description.
- `add-language <nickname> <language> <fluency>`: Add a language skill to a bot.
- `remove-language <nickname> <language>`: Remove a language skill from a bot.
- `remove <nickname>`: **Completely remove a bot** from all configurations, including bots.config.json, .env file, and database entries.

### Using the Remove Command Safely

The `remove` command permanently deletes a bot and all its associated data. **This action cannot be undone.**

**Before using the remove command:**

1. Ensure the bot is not currently running or active in any Discord servers.
2. Back up any important data associated with the bot if needed.
3. Confirm that removing the bot won't disrupt active conversations or server functionality.

**Usage:**
```bash
npm run manage-bots -- remove <nickname>
```

**What it does:**
- Removes the bot from `bots.config.json`
- Removes all related entries from the `.env` file (tokens, client IDs, secrets, refresh tokens)
- Removes the bot from `db.json` (both user objects and channel associations)

The command will ask for confirmation before proceeding. Type 'y' to confirm or 'N' (or any other key) to cancel.

**Example:**
```bash
npm run manage-bots -- remove MyBot
```

## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.