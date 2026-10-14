/**
 * `bun run --filter=@lostgradient/cinder validate:consumer` (COR-486).
 *
 * Runs the token consumer fixtures: first the browserless proof (a saved Cinder Theme v1
 * envelope validates, evaluates in six contexts, and produces the deployment CSS through the
 * public `@lostgradient/cinder/tokens/runtime` subpath), then the Chromium computed-style
 * parity check against a clean page that has only Cinder's token stylesheet plus the exported
 * theme.
 *
 * This is deliberately not part of `test` or `validate`: the second half needs Playwright's
 * Chromium, which the default graph does not require. The browserless half also runs in the
 * default suite (`scripts/tokens/consumer-fixture.test.ts`). The published-tarball scenario
 * belongs to the public mirror; this runs against the workspace source subpath.
 */

import { runConsumerChecks } from '../fixtures/tokens-consumer/check.mjs';
import { checkPreviewParity } from '../fixtures/tokens-consumer/theme-preview-check.ts';

const { maps, css } = runConsumerChecks();
console.log(
  `[validate:consumer] saved envelope: 6 contexts, ${Object.keys(maps['light/default'] ?? {}).length} properties, ${css.length} bytes of CSS`,
);

const { checked, mismatches } = await checkPreviewParity();
if (mismatches.length > 0) {
  console.error(`[validate:consumer] ${mismatches.length} of ${checked} computed values differ:`);
  for (const line of mismatches.slice(0, 25)) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`[validate:consumer] ${checked} computed values match across 6 contexts and 4 scopes`);
