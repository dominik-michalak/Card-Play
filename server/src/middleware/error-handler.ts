import type { ErrorPayload } from '@cardplay/shared';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import Joi from 'joi';
import { HttpError } from '../http-error';

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new HttpError(404, 'NOT_FOUND', 'route not found'));
};

function toResponse(error: unknown): { status: number; body: { error: ErrorPayload } } {
  if (error instanceof HttpError) {
    return { status: error.status, body: { error: { code: error.code, message: error.message } } };
  }
  if (Joi.isError(error)) {
    // Joi messages name the field and rule, never the submitted value
    return {
      status: 400,
      body: {
        error: { code: 'INVALID_PAYLOAD', message: error.details.map((d) => d.message).join('; ') },
      },
    };
  }
  // body-parser errors (malformed JSON, payload too large) carry a 4xx status
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    const message = status === 413 ? 'payload too large' : 'malformed request';
    return { status, body: { error: { code: 'INVALID_PAYLOAD', message } } };
  }
  return {
    status: 500,
    body: { error: { code: 'INTERNAL_ERROR', message: 'internal server error' } },
  };
}

export function createErrorHandler(): ErrorRequestHandler {
  return (error, _req, res, _next) => {
    const { status, body } = toResponse(error);
    if (status >= 500) {
      console.error(error);
    }
    res.status(status).json(body);
  };
}
