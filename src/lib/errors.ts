// Domain error classes — caught by errorHandler middleware
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const BadRequest = (msg = 'Bad request', code = 'BAD_REQUEST', details?: unknown) =>
  new HttpError(400, code, msg, details);
export const Unauthorized = (msg = 'Unauthorized', code = 'UNAUTHORIZED') =>
  new HttpError(401, code, msg);
export const Forbidden = (msg = 'Forbidden', code = 'FORBIDDEN') =>
  new HttpError(403, code, msg);
export const NotFound = (msg = 'Not found', code = 'NOT_FOUND') =>
  new HttpError(404, code, msg);
export const Conflict = (msg = 'Conflict', code = 'CONFLICT') =>
  new HttpError(409, code, msg);
export const UnprocessableEntity = (msg = 'Unprocessable', code = 'UNPROCESSABLE', details?: unknown) =>
  new HttpError(422, code, msg, details);
export const TooManyRequests = (msg = 'Too many requests', code = 'RATE_LIMITED') =>
  new HttpError(429, code, msg);
export const Internal = (msg = 'Internal error', code = 'INTERNAL') =>
  new HttpError(500, code, msg);
