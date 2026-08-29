import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * ESLint, flat config.
 *
 * NOT THE TYPE-CHECKED PRESET. `recommendedTypeChecked` catches more, but it
 * builds the whole program to do it, which makes `npm run lint` a second full
 * type-check that is slower than the first one and reports many of the same
 * problems. `npm run typecheck` already runs `tsc` over exactly this source
 * tree; lint is here for the things a type system does not have an opinion
 * about. Turn it on the day the two stop overlapping.
 */
export default tseslint.config(
  {
    // Dependencies and coverage output. Linting generated files reports on
    // code nobody wrote and nobody can fix.
    ignores: ['node_modules/**', 'dist/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
)
