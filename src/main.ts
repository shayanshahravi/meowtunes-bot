import bot from './bot';
import { logger } from './logging/logger';

bot.launch()
  .then(() => logger.info('Bot launched — polling started'))
  .catch((err: Error) => {
    logger.error('Failed to launch bot', { error: err.message });
    process.exit(1);
  });
