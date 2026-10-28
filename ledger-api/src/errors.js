'use strict';

/**
 * Every error response has the same shape:
 * {
 *   "error": {
 *     "code": "INSUFFICIENT_BALANCE",
 *     "message": "Human readable explanation",
 *     "details": [ { "field": "amount", "message": "..." } ]   // optional
 *   }
 * }
 */
class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const errors = {
  validation: (details, message = 'Request validation failed') =>
    new ApiError(400, 'VALIDATION_ERROR', message, details),
  invalidPagination: (details) =>
    new ApiError(400, 'INVALID_PAGINATION', 'Invalid pagination parameters', details),
  invalidBody: (message = 'Request body must be valid JSON') =>
    new ApiError(400, 'INVALID_REQUEST_BODY', message),
  accountNotFound: (id) =>
    new ApiError(404, 'ACCOUNT_NOT_FOUND', `Account '${id}' was not found`),
  transactionNotFound: (id) =>
    new ApiError(404, 'TRANSACTION_NOT_FOUND', `Transaction '${id}' was not found`),
  insufficientBalance: (available, requested) =>
    new ApiError(422, 'INSUFFICIENT_BALANCE', 'Insufficient balance for this debit', [
      { field: 'amount', message: `Available balance is ${available}, requested ${requested}` },
    ]),
  duplicate: (message, existing) => {
    const err = new ApiError(409, 'DUPLICATE_TRANSACTION', message);
    err.existing = existing;
    return err;
  },
  methodNotAllowed: (message) => new ApiError(405, 'METHOD_NOT_ALLOWED', message),
  routeNotFound: (method, path) =>
    new ApiError(404, 'ROUTE_NOT_FOUND', `Route ${method} ${path} does not exist`),
};

module.exports = { ApiError, errors };
