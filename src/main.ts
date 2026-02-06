import './init-env'; // Must be first!
import 'reflect-metadata';
import { start } from './bot-controls';
import { botDebug as logger, mainDebug } from './utils/debugLogger';

mainDebug.debug('Starting bot initialization...');
start().catch((error) => {
  logger.error('Failed to start bots:', error);
  mainDebug.error('Unhandled error in startBots:', error);
});
