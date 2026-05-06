export class AppError extends Error {
  readonly statusCode: number
  readonly code: string

  constructor(message: string, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message)
    this.name = this.constructor.name
    this.statusCode = statusCode
    this.code = code
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor)
    }
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404, 'NOT_FOUND')
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed') {
    super(message, 400, 'VALIDATION_ERROR')
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource already exists') {
    super(message, 409, 'CONFLICT')
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable') {
    super(message, 503, 'SERVICE_UNAVAILABLE')
  }
}

/**
 * Raised when a required configuration / service dependency is missing
 * (e.g., "Database not configured", "LLM provider unavailable",
 * "Pipeline service not configured"). Distinct from
 * `ServiceUnavailableError` which signals a transient outage.
 */
export class ConfigError extends AppError {
  constructor(message = 'Service is not configured') {
    super(message, 503, 'CONFIG_ERROR')
  }
}

/**
 * Specialised 404 for the file-upload (ingest) routes — keeps the
 * generic `NotFoundError` free for capture / entity / brief lookups.
 */
export class UploadNotFoundError extends AppError {
  constructor(message = 'Upload not found') {
    super(message, 404, 'UPLOAD_NOT_FOUND')
  }
}

/**
 * Origin / token failures on the destructive `POST /admin/reset-data`
 * endpoint. Distinct status (403) and code from generic auth failures
 * so audit / alerting can target reset attempts specifically.
 */
export class ResetForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403, 'RESET_FORBIDDEN')
  }
}
