# Discord Bot

A Discord bot using Gemini for generative AI responses.

## Features

*   **Conversational AI:** Powered by the Gemini 2.5 Pro model, the bot engages in natural, human-like conversations.
*   **Customizable Personality:** Define the bot's personality, including its nickname, writing style, humor, and more, through an external JSON file.
*   **Probabilistic Response:** The bot's response frequency is controlled by a configurable probability, preventing it from replying to every message and creating a more organic interaction.
*   **Idle Chatter:** Keep conversations alive with a feature that allows the bot to send messages automatically when a channel has been inactive for a specified period.
*   **Delayed Reactions:** The bot can identify and respond to interesting but unanswered messages from the chat history, adding a unique layer of conversational depth.
*   **Direct Message Support:** The bot is fully functional in direct messages, with a separate response probability for more frequent interaction in private conversations.
*   **Multimedia Support:** The bot can analyze and comment on images, as well as transcribe and respond to audio messages, making it a versatile conversational partner.
*   **Debug Logging:** Enable detailed debug logging for development and troubleshooting to gain insight into the bot's operations.

## Installation

1. Clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file in the root directory and add the following environment variables:
   ```
   DISCORD_BOT_TOKEN=your_discord_bot_token
   GEMINI_API_KEY=your_gemini_api_key
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