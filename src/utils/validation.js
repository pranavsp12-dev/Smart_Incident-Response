import { HttpError } from './httpError.js';

export function requireObject(value, label = 'Request body') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, `${label} must be a JSON object.`);
  }

  return value;
}

export function parsePositiveId(value, label = 'id') {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    throw new HttpError(400, `${label} must be a positive integer.`);
  }

  const id = BigInt(value);
  if (id < 1n || id > 9223372036854775807n) {
    throw new HttpError(400, `${label} must be a positive integer.`);
  }

  return value;
}

export function rejectUnknownFields(value, allowedFields) {
  const unknownField = Object.keys(value).find((field) => !allowedFields.includes(field));
  if (unknownField) {
    throw new HttpError(400, `Unknown field: ${unknownField}`);
  }
}
