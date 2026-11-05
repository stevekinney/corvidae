import { expect, test } from 'bun:test';

import { runInstalledRelease } from './test-installed-release.ts';

const ACCEPTED_ARCHIVE =
  '/Users/stevekinney/Developer/corvidae/tmp/chef/COR-2039/retained-42e63370f/interborough-0.0.0-test-darwin-arm64.tar.gz';

test('runs the retained installed release journey from the archive', async () => {
  const evidence = await runInstalledRelease(['--archive', ACCEPTED_ARCHIVE]);
  expect(evidence).toMatch(/installed-release-.*\.json$/);
}, 240_000);
