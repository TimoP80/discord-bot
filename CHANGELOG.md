# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2025-11-11

### Added

- Refactored the bot to support multiple instances, each with its own personality.
- Introduced a `bots.json` configuration file for managing bot settings.

### Changed

- The bot is now launched with a `main.ts` script that loads and runs all configured bot instances.
- Updated `README.md` to reflect the new multi-bot architecture and configuration.

## [1.0.1] - 2025-11-11

### Changed

- Updated `README.md` with a detailed features section.

## [1.0.0] - 2025-11-11

### Added

- Initial release of the Discord bot.
- Integration with Gemini for generative AI responses.
- Basic commands for starting the bot, building the project, and listing models.