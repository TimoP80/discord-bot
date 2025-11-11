# Discord Bot

A Discord bot using Gemini for generative AI responses, with support for running multiple bot instances, each with its own unique personality.

## Features

*   **Multi-Bot Support:** Run multiple bot instances from a single application, each with its own personality, token, and configuration.
*   **Conversational AI:** Powered by the Gemini 2.5 Pro model, the bot engages in natural, human-like conversations.
*   **Customizable Personality:** Define each bot's personality, including its nickname, writing style, humor, and more, through external JSON files.
*   **Probabilistic Response:** Each bot's response frequency is controlled by a configurable probability, preventing it from replying to every message and creating a more organic interaction.
*   **Idle Chatter:** Keep conversations alive with a feature that allows each bot to send messages automatically when a channel has been inactive for a specified period.
*   **Delayed Reactions:** Bots can identify and respond to interesting but unanswered messages from the chat history, adding a unique layer of conversational depth.
*   **Direct Message Support:** Each bot is fully functional in direct messages, with a separate response probability for more frequent interaction in private conversations.
*   **Multimedia Support:** Bots can analyze and comment on images, as well as transcribe and respond to audio messages, making them versatile conversational partners.
*   **Debug Logging:** Enable detailed debug logging for development and troubleshooting to gain insight into the bot's operations.

## Installation

1. Clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file in the root directory and add your Gemini API key:
   ```
   GEMINI_API_KEY=your_gemini_api_key
   ```
4. Create a `bots.json` file in the root directory to configure your bots. You can add multiple bot configurations to the array. See the example below:
   ```json
   [
     {
       "token": "YOUR_DISCORD_BOT_TOKEN",
       "personalityFilePath": "path/to/your/personality.json",
       "targetChannelId": "YOUR_TARGET_CHANNEL_ID",
       "responseProbability": 0.20,
       "idleChatterEnabled": true,
       "delayedReactionEnabled": true
     }
   ]
   ```

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

## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.