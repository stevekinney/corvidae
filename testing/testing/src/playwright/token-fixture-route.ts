import { fixtureEntry } from './editor-fixture.ts';

const entry = fixtureEntry('token-computation');
const fixture = entry.fixtures?.find((candidate) => candidate.name === 'assertion');
if (fixture === undefined) throw new Error('Missing token computation assertion fixture.');

const parameters = new URLSearchParams({
  fixture: fixture.name,
  fixtureContentHash: fixture.fixtureContentHash,
});
export const tokenFixtureRoute = `${entry.route}?${parameters.toString()}`;
