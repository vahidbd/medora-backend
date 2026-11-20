/**
 * Services throw these; plugins/error-handler.ts turns them into replies with
 * one envelope: { error: { code, message, details? } }. Messages are shown to
 * people, so they are plain words with no table, column or patient detail.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class NotFoundError extends AppError {
  constructor(thing: string) {
    super(404, 'not_found', `${thing} not found`);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Sign in to carry on', code = 'unauthorized') {
    super(401, code, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You don't have permission to do that", code = 'forbidden') {
    super(403, code, message);
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, code = 'bad_request') {
    super(400, code, message);
  }
}

/** A rule of the business says no: the request was understood, but can't be done as asked. */
export class BusinessRuleError extends AppError {
  constructor(message: string, code = 'business_rule') {
    super(409, code, message);
  }
}

export class TooManyRequestsError extends AppError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(429, 'too_many_requests', 'Too many attempts. Wait a moment and try again.');
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
