import { environmentalist } from '@lostgradient/environmentalist';
import { z } from 'zod';

const schema = z.object({
  // Visual-baseline tooling (visual-baselines.md). BASELINE_DOCKER and
  // BASELINE_PLAYWRIGHT_VERSION are baked into the renderer image; the others are
  // passed by the Docker wrapper into the container.
  baselineDocker: z.string().optional().meta({ env: 'BASELINE_DOCKER' }),
  baselineHostGid: z.string().optional().meta({ env: 'BASELINE_HOST_GID' }),
  baselineHostUid: z.string().optional().meta({ env: 'BASELINE_HOST_UID' }),
  baselinePlaywrightVersion: z.string().optional().meta({ env: 'BASELINE_PLAYWRIGHT_VERSION' }),
  baselineSourceSha: z.string().optional().meta({ env: 'BASELINE_SOURCE_SHA' }),
  browserFixtureManifest: z.string().optional().meta({ env: 'BROWSER_FIXTURE_MANIFEST' }),
  browserFixtureUrl: z.string().optional().meta({ env: 'BROWSER_FIXTURE_URL' }),
  cinderTestComponents: z.string().optional().meta({ env: 'CINDER_TEST_COMPONENTS' }),
  cinderUpdateSeamAudit: z
    .string()
    .optional()
    .transform((value) => value === '1')
    .meta({ env: 'CINDER_UPDATE_SEAM_AUDIT' }),
  curatedHighlighterOutputDirectory: z
    .string()
    .optional()
    .meta({ env: 'CURATED_HIGHLIGHTER_OUTPUT_DIRECTORY' }),
  fixtureHostMode: z.string().optional().meta({ env: 'FIXTURE_HOST_MODE' }),
  tmpdir: z.string().optional().meta({ env: 'TMPDIR' }),
});

function selectedEnvironment(): Record<string, string> {
  const names = [
    'BASELINE_DOCKER',
    'BASELINE_HOST_GID',
    'BASELINE_HOST_UID',
    'BASELINE_PLAYWRIGHT_VERSION',
    'BASELINE_SOURCE_SHA',
    'BROWSER_FIXTURE_MANIFEST',
    'BROWSER_FIXTURE_URL',
    'CINDER_TEST_COMPONENTS',
    'CINDER_UPDATE_SEAM_AUDIT',
    'CURATED_HIGHLIGHTER_OUTPUT_DIRECTORY',
    'FIXTURE_HOST_MODE',
    'TMPDIR',
  ];
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

/** Resolve browser fixture process configuration at the point of use. */
export function environmentConfiguration() {
  return environmentalist.sync({
    name: 'corvidae-browser-fixtures',
    schema,
    env: selectedEnvironment(),
    sources: ['env', 'defaults'],
    argv: [],
    coerce: false,
  });
}
