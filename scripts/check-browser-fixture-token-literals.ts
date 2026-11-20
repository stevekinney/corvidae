import { checkBrowserFixtureLiterals } from '../internal/component-tooling/scripts/check-browser-fixture-token-literals.ts';

if (import.meta.main) await checkBrowserFixtureLiterals({ strict: true });
