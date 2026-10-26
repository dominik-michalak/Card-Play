import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist', 'node_modules', 'docs', 'rules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
);
