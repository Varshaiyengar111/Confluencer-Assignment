'use strict';

const { errors } = require('./errors');
const { toMinor, hasAtMostTwoDecimals, MAX_MINOR } = require('./money');

const TX_TYPES = ['credit', 'debit'];
const MAX_NAME = 100;
const MAX_REF = 100;
const MAX_DESC = 255;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function requireObject(body) {
  if (!isPlainObject(body)) throw errors.invalidBody('Request body must be a JSON object');
}

function checkUnknownFields(body, allowed, details) {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) details.push({ field: key, message: 'Unknown field' });
  }
}

function checkRequiredString(body, field, max, details) {
  const v = body[field];
  if (v === undefined || v === null) {
    details.push({ field, message: `${field} is required` });
  } else if (typeof v !== 'string') {
    details.push({ field, message: `${field} must be a string` });
  } else if (v.trim().length === 0) {
    details.push({ field, message: `${field} must not be empty` });
  } else if (v.trim().length > max) {
    details.push({ field, message: `${field} must be at most ${max} characters` });
  }
}

function checkOptionalString(body, field, max, details) {
  const v = body[field];
  if (v === undefined || v === null) return;
  if (typeof v !== 'string') details.push({ field, message: `${field} must be a string` });
  else if (v.length > max) details.push({ field, message: `${field} must be at most ${max} characters` });
}

function checkAmount(body, details) {
  const v = body.amount;
  if (v === undefined || v === null) {
    details.push({ field: 'amount', message: 'amount is required' });
  } else if (typeof v !== 'number' || !Number.isFinite(v)) {
    details.push({ field: 'amount', message: 'amount must be a number' });
  } else if (v <= 0) {
    details.push({ field: 'amount', message: 'amount must be greater than 0' });
  } else if (!hasAtMostTwoDecimals(v)) {
    details.push({ field: 'amount', message: 'amount must have at most 2 decimal places' });
  } else if (toMinor(v) > MAX_MINOR) {
    details.push({ field: 'amount', message: 'amount is too large' });
  }
}

function validateCreateAccount(body) {
  requireObject(body);
  const details = [];
  checkUnknownFields(body, ['name'], details);
  checkRequiredString(body, 'name', MAX_NAME, details);
  if (details.length) throw errors.validation(details);
  return { name: body.name.trim() };
}

function validateCreateTransaction(body) {
  requireObject(body);
  const details = [];
  checkUnknownFields(body, ['type', 'amount', 'description', 'reference_id'], details);

  if (body.type === undefined || body.type === null) {
    details.push({ field: 'type', message: 'type is required' });
  } else if (!TX_TYPES.includes(body.type)) {
    details.push({ field: 'type', message: `type must be one of: ${TX_TYPES.join(', ')}` });
  }
  checkAmount(body, details);
  checkRequiredString(body, 'reference_id', MAX_REF, details);
  checkOptionalString(body, 'description', MAX_DESC, details);

  if (details.length) {
    // Surface a specific code for the two most common cases the spec calls out.
    const onlyType = details.every((d) => d.field === 'type');
    const onlyAmount = details.every((d) => d.field === 'amount');
    if (onlyType) throw Object.assign(errors.validation(details, 'Invalid transaction type'), { code: 'INVALID_TRANSACTION_TYPE' });
    if (onlyAmount) throw Object.assign(errors.validation(details, 'Invalid amount'), { code: 'INVALID_AMOUNT' });
    throw errors.validation(details);
  }
  return {
    type: body.type,
    amount: toMinor(body.amount),
    description: body.description ?? null,
    reference_id: body.reference_id.trim(),
  };
}

function validateCreateTransfer(body) {
  requireObject(body);
  const details = [];
  checkUnknownFields(body, ['from_account_id', 'to_account_id', 'amount', 'description', 'reference_id'], details);
  checkRequiredString(body, 'from_account_id', 64, details);
  checkRequiredString(body, 'to_account_id', 64, details);
  checkAmount(body, details);
  checkRequiredString(body, 'reference_id', MAX_REF, details);
  checkOptionalString(body, 'description', MAX_DESC, details);
  if (
    typeof body.from_account_id === 'string' &&
    body.from_account_id === body.to_account_id
  ) {
    details.push({ field: 'to_account_id', message: 'Cannot transfer to the same account' });
  }
  if (details.length) throw errors.validation(details);
  return {
    from_account_id: body.from_account_id,
    to_account_id: body.to_account_id,
    amount: toMinor(body.amount),
    description: body.description ?? null,
    reference_id: body.reference_id.trim(),
  };
}

function parsePositiveInt(raw, field, details) {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw) || !/^\d+$/.test(String(raw))) {
    details.push({ field, message: `${field} must be a positive integer` });
    return undefined;
  }
  const n = Number(raw);
  if (n < 1) details.push({ field, message: `${field} must be at least 1` });
  return n;
}

function validatePagination(query) {
  const details = [];
  const page = parsePositiveInt(query.page, 'page', details) ?? 1;
  const limit = parsePositiveInt(query.limit, 'limit', details) ?? DEFAULT_LIMIT;
  if (!details.length && limit > MAX_LIMIT) {
    details.push({ field: 'limit', message: `limit must be at most ${MAX_LIMIT}` });
  }
  if (details.length) throw errors.invalidPagination(details);
  return { page, limit };
}

module.exports = {
  validateCreateAccount,
  validateCreateTransaction,
  validateCreateTransfer,
  validatePagination,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
