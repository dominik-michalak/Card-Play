import Joi from 'joi';

const MAX_PASSWORD_BYTES = 72; // bcrypt ignores everything after 72 bytes

const password = Joi.string()
  .min(8)
  .custom((value: string, helpers) =>
    Buffer.byteLength(value, 'utf8') > MAX_PASSWORD_BYTES ? helpers.error('string.max') : value,
  )
  .messages({ 'string.max': '"password" must be at most 72 bytes' })
  .required();

const email = Joi.string().trim().max(254).email().required();

export const registerSchema = Joi.object({
  username: Joi.string()
    .pattern(/^[A-Za-z0-9_]{3,20}$/)
    .required()
    .messages({
      'string.pattern.base': '"username" must be 3-20 letters, digits or underscores',
    }),
  email,
  password,
});

export const loginSchema = Joi.object({
  email,
  // no complexity rules on login, only a sane size
  password: Joi.string().max(MAX_PASSWORD_BYTES).required(),
});

export type RegisterInput = { username: string; email: string; password: string };
export type LoginInput = { email: string; password: string };
