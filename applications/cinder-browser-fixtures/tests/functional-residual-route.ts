import { fixtureEntry } from './editor-fixture.ts';

const entry = fixtureEntry('functional-residual');
const fixture = entry.fixtures?.find((candidate) => candidate.name === 'assertion');
if (fixture === undefined) throw new Error('Missing functional residual assertion fixture.');

const parameters = new URLSearchParams({
  fixture: fixture.name,
  fixtureContentHash: fixture.fixtureContentHash,
});
export const functionalResidualRoute = `${entry.route}?${parameters.toString()}`;
