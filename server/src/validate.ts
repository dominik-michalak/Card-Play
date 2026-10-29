import type { Schema } from 'joi';

export function validate<T>(schema: Schema, input: unknown): T {
  // a missing body (wrong content type) is validated as {} and fails on required fields
  const { error, value } = schema.validate(input ?? {}, { abortEarly: false });
  if (error) {
    throw error;
  }
  return value as T;
}
