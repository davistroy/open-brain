// @ts-check
// ESLint 9 flat config — migrated from .eslintrc.json (Phase G.2 / A130)
// eslint-config-next v16 requires ESLint >=9 and ships flat-config exports.

import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTs,

  // Mirror default ignores from eslint-config-next (explicit for clarity)
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts']),

  // Custom project rules — preserved from .eslintrc.json
  {
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@open-brain/shared', '@open-brain/shared/*'],
              message:
                'web-next redeclares types locally (D109). Importing @open-brain/shared drags pg/openai/drizzle-orm into the Next.js bundle. Use lib/types.ts instead — drift-guard enforces parity.',
            },
          ],
        },
      ],

      // --- New react-hooks v5 rules shipped with eslint-config-next@16 ---
      // These rules were NOT active under ESLint 8 + eslint-config-next@15.
      // Downgraded to warn so the migration unblocks CI; pre-existing violations
      // are tracked for systematic cleanup in a follow-up pass (A130-followup).
      //
      // react-hooks/static-components: components created during render
      'react-hooks/static-components': 'warn',
      // react-hooks/immutability: mutation of props/external variables
      'react-hooks/immutability': 'warn',
      // react-hooks/refs: ref.current access during render
      'react-hooks/refs': 'warn',
      // react-hooks/set-state-in-effect: setState called synchronously in effect
      'react-hooks/set-state-in-effect': 'warn',

      // Respect TypeScript convention: parameters/vars prefixed with _ are intentionally unused
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
]);
