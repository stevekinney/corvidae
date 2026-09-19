import { fixtureEntry } from './editor-fixture.ts';

const entry = fixtureEntry('theme-surfaces');
const fixture = entry.fixtures?.find((candidate) => candidate.name === 'assertion');
if (fixture === undefined) throw new Error('Missing theme surfaces assertion fixture.');

const parameters = new URLSearchParams({
  fixture: fixture.name,
  fixtureContentHash: fixture.fixtureContentHash,
});

export const themeFixtureRoute = `${entry.route}?${parameters.toString()}`;
