import { DirectTransport, TransportService } from './TransportService';
import { logger } from '../logging/logger';
import { config } from '../config';

/**
 * Andromeda CFW is a connectivity/transport component only. It is intentionally
 * NOT part of the MVP: NETWORK_MODE=direct is the default and fully supported
 * path. The WorkerTransport placeholder keeps the interface stable so switching
 * modes later is configuration-only.
 */
export class WorkerTransport implements TransportService {
  readonly name = 'worker';

  constructor(private readonly fallback: TransportService = new DirectTransport(logger)) {}

  async request<T>(options: any): Promise<any> {
    throw new Error(
      'WorkerTransport is not enabled in this build. Set NETWORK_MODE=direct, or implement the Andromeda worker adapter before using it.'
    );
  }
}

export function createTransport(): TransportService {
  if (config.networkMode === 'worker') {
    logger.warn('NETWORK_MODE=worker selected but WorkerTransport is not implemented; failing fast.');
    return new WorkerTransport();
  }
  return new DirectTransport(logger);
}
