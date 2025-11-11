# Discord Bot

A Discord bot using Gemini for generative AI responses.

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