/**
 * Backend ESLint config (restored in Sprint R).
 *
 * Intent: this is a *quality gate*, not a style crusade. It is tuned to catch
 * real correctness/maintainability problems (unused vars, unreachable code,
 * accidental shadowing) while not flagging large swaths of deliberate, reviewed
 * code. Rules that would fight intentional patterns in this codebase are relaxed
 * with a one-line rationale so the relaxation is auditable rather than silent.
 *
 * ESLint 8 / .eslintrc (classic) is used to match the frontend's pinned tooling.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  env: { node: true, es2022: true, jest: true },
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  ignorePatterns: ['dist/', 'node_modules/', 'coverage/'],
  rules: {
    // The data layer (PostgREST embeds, raw payloads from Square/DoorDash) is
    // genuinely dynamically shaped; `any` there is a reviewed trade-off, not an
    // accident. Tightening this is tracked in the review as L6, not Sprint R.
    '@typescript-eslint/no-explicit-any': 'off',

    // Structured operational logs are intentionally written to stderr via
    // console.error (see requestLogger / scheduler). Banning console would flag
    // ~147 deliberate log sites, so it stays off.
    'no-console': 'off',

    // Use the TS-aware unused-vars rule; allow leading-underscore throwaways
    // (e.g. unused middleware `next`, destructured-and-ignored fields).
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
    ],
  },
  overrides: [
    {
      // Jest hoists `jest.mock(path, factory)` above imports, so the factory
      // cannot reference an ESM import — it must `require()` the mock inline.
      // That is the documented Jest pattern, not a lint smell, so allow it in
      // test files only.
      files: ['**/__tests__/**/*.ts', '**/*.test.ts'],
      rules: { '@typescript-eslint/no-var-requires': 'off' },
    },
  ],
};
