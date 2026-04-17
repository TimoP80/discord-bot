# Discord Bot

TypeScript Discord bot project with multi-bot personalities, multi-provider AI fallbacks, voice chat support, image generation, code attachment handling, YouTube link analysis, and an Electron desktop UI.

## Current Status

- Main runtime entrypoint: `start.cjs`
- Source entrypoint: `src/main.ts`
- Default package version: `4.1.3`
- Build output: `dist/`
- Environment file loaded at startup: `.env`

## What The Code Currently Supports

- Multiple Discord bots loaded from `bots.config.json`
- AI provider fallback logic across Gemini, OpenAI, Anthropic, local Ollama, and custom/cloud-style providers
- Slash commands for bot control, simulation control, image generation, voice chat, and agent tools
- Voice channel join/listen/respond flow with pluggable STT providers
- Image analysis and code attachment analysis
- YouTube link detection with metadata-based analysis sent by DM
- Electron windows for agent management, bot config, simulation, and logs

## Important Reality Checks

- The bot runtime looks for bot config in this order:
  - `bots.config.json` in the repo root
  - `config/bots.config.json` relative to the parent workspace
- `npm test` in `package.json` points to `test-agent-platform.js`, which is not present in this repo. Use the targeted `test-*.js` / `test-*.ts` scripts instead.
- The ElevenLabs agent commands currently use an in-memory/local service layer. They are useful for local workflow testing, but they are not a full remote agent management implementation yet.
- `src/deploy-commands.ts` deploys commands for a hard-coded bot list. If your bot names differ, update that file first.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env` in the repo root.

3. Add the Discord tokens and API keys you actually use. Minimal example:

```env
# Discord
TOKEN_TIIAV=your_discord_bot_token
TIIAV_CLIENT_ID=your_discord_application_id
TIIAV_CLIENT_SECRET=your_discord_client_secret

# Primary AI provider examples
GEMINI_API_KEY=your_gemini_key
OPENAI_API_KEY=your_openai_key
ANTHROPIC_API_KEY=your_anthropic_key

# Optional local/cloud AI providers
USE_OLLAMA=true
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.1:8b
OLLAMA_API_KEY=your_ollama_cloud_key

# Optional voice / media features
STT_PROVIDER=google
GOOGLE_SPEECH_API_KEY=your_google_speech_key
STT_LANGUAGE=en-US
ELEVENLABS_API_KEY=your_elevenlabs_key
YOUTUBE_API_KEY=your_youtube_data_api_key
MOONDREAM_API_KEY=your_moondream_key
MOONDREAM_ENABLED=false
```

4. Create `bots.config.json` in the repo root. Minimal example:

```json
{
  "users": [
    {
      "name": "TiiaV",
      "nickname": "TiiaV",
      "personality": "Friendly, conversational, and playful.",
      "responseProbability": 0.08,
      "dmResponseProbability": 1,
      "idleChatterEnabled": false,
      "delayedReactionEnabled": false,
      "followUpEnabled": false,
      "periodicMessageEnabled": true,
      "model": "gemini-3-flash-preview"
    }
  ]
}
```

5. In the Discord Developer Portal, enable:

- `MESSAGE CONTENT INTENT`
- `SERVER MEMBERS INTENT`
- `PRESENCE INTENT`
- `VOICE STATE INTENT` if you want `/voice`

6. Start the bot:

```bash
npm start
```

## Common Commands

### Runtime

```bash
npm start
npm run build
npm run prod
npm run watch
```

### Utilities

```bash
npm run list-models
npm run generate-invite
npm run deploy-commands
npm run manage-bots -- search Tiia
npm run set-model -- --help
```

### Electron UI

```bash
npm run build
npm run electron
```

## Slash Commands In The Current Source

- `/bot-mute`
- `/bot-unmute`
- `/bot-msg-rate`
- `/agent-gui`
- `/list-apps`
- `/sim-start`
- `/sim-stop`
- `/sim-pause`
- `/sim-resume`
- `/generate-image`
- `/voice join`
- `/voice leave`
- `/voice set-bot`
- `/voice toggle-listening`
- `/voice status`
- `/agent create`
- `/agent list`
- `/agent set-active`
- `/agent clear-history`
- `/agent delete`
- `/agent status`

## Voice Chat

Voice chat requires:

- `GuildVoiceStates` intent
- Discord `Connect` and `Speak` permissions
- An STT provider configured in `.env`

Supported STT provider values in the current code:

- `google`
- `openai`
- `azure`
- `whisper-local`
- `elevenlabs`

See [VOICE_CHAT_SETUP.md](/c:/CodeProjects/Discord_Sharp/TypeScript_BotCode/discord-bot/VOICE_CHAT_SETUP.md) for details.

## YouTube Links

When a message contains a YouTube URL and `YOUTUBE_API_KEY` is configured, the bot fetches video metadata and DMs the user a short analysis summary. This is not the same as the standalone Python comment bot in `youtube_comment_bot.py`.

See [YOUTUBE_BOT_README.md](/c:/CodeProjects/Discord_Sharp/TypeScript_BotCode/discord-bot/YOUTUBE_BOT_README.md).

## Notes For This Repo

- There are many historical Markdown files in this project. Not all of them describe the current runtime accurately.
- The docs above are aligned with the current TypeScript bot entrypoints and command surface as of March 29, 2026.
