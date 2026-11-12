/** The Settings words that depend on a count or on whether the server answered. */
import { describe, expect, test } from 'bun:test';

import { A2A_COPY } from './copy/a2a.ts';
import { PLUGINS_COPY } from './copy/plugins.ts';

describe('the Shared agents description', () => {
  test('names the one agent, or how many are listed', () => {
    expect(A2A_COPY.agents.description(1)).toContain('The one agent is listed');
    expect(A2A_COPY.agents.description(0)).toContain('Agents you add are listed here');
    expect(A2A_COPY.agents.description(8)).toContain('All eight agents are listed');
  });
});

describe('the Plugins load failure', () => {
  test('names the status the server answered with, or that it did not answer', () => {
    expect(PLUGINS_COPY.loadFailed.description(500)).toContain('(500)');
    expect(PLUGINS_COPY.loadFailed.description(undefined)).toContain('didn’t answer');
  });
});
