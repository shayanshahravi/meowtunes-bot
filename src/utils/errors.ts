export class MeowTunesError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode?: number,
    public readonly retryable = false
  ) {
    super(message);
    this.name = 'MeowTunesError';
  }

  static unauthorized(message = 'Authentication required'): MeowTunesError {
    return new MeowTunesError(message, 'UNAUTHORIZED', 401, false);
  }

  static tokenExpired(): MeowTunesError {
    return new MeowTunesError('Token expired', 'TOKEN_EXPIRED', 401, false);
  }

  static rateLimited(retryAfter?: number): MeowTunesError {
    const err = new MeowTunesError('Rate limited', 'RATE_LIMITED', 429, true);
    (err as any).retryAfter = retryAfter;
    return err;
  }

  static notFound(resource: string): MeowTunesError {
    return new MeowTunesError(`${resource} not found`, 'NOT_FOUND', 404, false);
  }

  static invalidMedia(message: string): MeowTunesError {
    return new MeowTunesError(message, 'INVALID_MEDIA', 400, false);
  }

  static transient(message: string): MeowTunesError {
    return new MeowTunesError(message, 'TRANSIENT', undefined, true);
  }

  static internal(message: string): MeowTunesError {
    return new MeowTunesError(message, 'INTERNAL', 500, true);
  }
}