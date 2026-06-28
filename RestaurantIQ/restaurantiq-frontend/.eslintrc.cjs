/**
 * Frontend ESLint config (restored in Sprint R).
 *
 * The package already shipped the lint *script* and the plugin devDeps, but no
 * config file — so `npm run lint` failed to run at all. This restores the gate
 * with the standard Vite + React + TypeScript ruleset, tuned to the same
 * pragmatic stance as the backend: catch real problems, don't fight reviewed
 * patterns. Each relaxation carries a rationale so it is auditable.
 */
module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', 'vite.config.ts', '.eslintrc.cjs'],
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh'],
  rules: {
    // Fast-Refresh hint, not a correctness rule. The auth/restaurant context
    // modules deliberately co-locate their provider component with their hook
    // and context value — a standard React pattern. Rather than weaken the
    // strict `--max-warnings 0` gate for a non-correctness HMR optimization,
    // this rule is disabled.
    'react-refresh/only-export-components': 'off',

    // API payloads and Recharts datum shapes are dynamically typed at the
    // boundary; `any` there is a reviewed trade-off (review L6), not Sprint R.
    '@typescript-eslint/no-explicit-any': 'off',

    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
    ],
  },
};
