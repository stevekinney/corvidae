/**
 * The showcase development host's pieces (`showcase.ts`): the flag, the home it defaults to, and
 * what it writes into that home so the demo plugin is on and the model picker has models.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SHOWCASE_ORDER_REFUND_FILE,
  SHOWCASE_RELEASE_NOTES_FILE,
  SHOWCASE_TRIAGE_INBOX_FILE,
  SHOWCASE_WORKFLOW_FILES,
} from '../../fixtures/showcase-content.ts';
import { SHOWCASE_AGENT_IDENTIFIERS } from './showcase-agents.ts';
import {
  prepareShowcaseHome,
  SHOWCASE_FLAG,
  SHOWCASE_MODELS,
  showcaseEnvironment,
  showcaseHostOptions,
  splitShowcaseFlag,
} from './showcase.ts';

const scratch = await mkdtemp(join(tmpdir(), 'interborough-showcase-test-'));
afterAll(() => rm(scratch, { recursive: true, force: true }));

describe('splitShowcaseFlag', () => {
  test('finds the flag anywhere and leaves the other arguments in order', () => {
    expect(splitShowcaseFlag([])).toEqual({ showcase: false, rest: [] });
    expect(splitShowcaseFlag(['--plugin', '/a', SHOWCASE_FLAG, '--plugin', '/b'])).toEqual({
      showcase: true,
      rest: ['--plugin', '/a', '--plugin', '/b'],
    });
  });
});

describe('showcaseEnvironment', () => {
  test('defaults the home to tmp/interborough-showcase in the repository, and keeps the rest', () => {
    const environment = showcaseEnvironment({ INTERBOROUGH_PORT: '7000' }, '/repository');
    expect(environment['INTERBOROUGH_HOME']).toBe('/repository/tmp/interborough-showcase');
    expect(environment['INTERBOROUGH_PORT']).toBe('7000');
    expect(showcaseEnvironment({ INTERBOROUGH_HOME: '' }, '/repository')['INTERBOROUGH_HOME']).toBe(
      '/repository/tmp/interborough-showcase',
    );
  });

  test('ignores a set INTERBOROUGH_HOME, so a real home is never rewritten', () => {
    const environment = showcaseEnvironment(
      { INTERBOROUGH_HOME: '/Users/me/.interborough' },
      '/repository',
    );
    expect(environment['INTERBOROUGH_HOME']).toBe('/repository/tmp/interborough-showcase');
  });

  test('uses INTERBOROUGH_SHOWCASE_HOME when it names a directory', () => {
    const environment = showcaseEnvironment(
      {
        INTERBOROUGH_HOME: '/Users/me/.interborough',
        INTERBOROUGH_SHOWCASE_HOME: '/scratch/showcase',
      },
      '/repository',
    );
    expect(environment['INTERBOROUGH_HOME']).toBe('/scratch/showcase');
  });
});

describe('prepareShowcaseHome', () => {
  test('turns the demo plugin on and gives the anthropic provider its models, and is safe to repeat', async () => {
    const home = join(scratch, 'home');
    await prepareShowcaseHome(home);
    await prepareShowcaseHome(home);
    const document = JSON.parse(await readFile(join(home, 'configuration.json'), 'utf8')) as {
      plugins: Record<string, { enabled?: boolean; configuration?: { models: string[] } }>;
    };
    expect(document.plugins['demo']?.enabled).toBe(true);
    expect(document.plugins['anthropic']?.configuration?.models).toEqual([...SHOWCASE_MODELS]);
  });
});

describe('the sample world workflow files', () => {
  test('are written into the home, byte for byte', async () => {
    const home = join(scratch, 'workflow-files');
    await prepareShowcaseHome(home);
    for (const file of SHOWCASE_WORKFLOW_FILES) {
      expect(await readFile(join(home, 'workflows', `${file.id}.json`), 'utf8')).toBe(file.text);
    }
  });

  test('Release notes is the one file in the extended format the Code tab shows', () => {
    const file = JSON.parse(SHOWCASE_RELEASE_NOTES_FILE.text) as {
      name: string;
      title: string;
      description: string;
      trigger: Record<string, unknown>;
      inputSchema: { required: string[]; properties: Record<string, Record<string, unknown>> };
      outputSchema: { required: string[] };
      steps: Record<string, unknown>[];
    };
    expect(file.name).toBe('release-notes');
    expect(file.title).toBe('Release notes');
    expect(file.description).toBe('Collects merged changes into a draft.');
    expect(file.trigger).toEqual({
      kind: 'schedule',
      name: 'Release notes digest',
      spec: '0 11 * * 5',
      timezone: 'America/Chicago',
      overlap: 'skip',
      catchUp: false,
      input: { branch: 'main' },
    });
    // The board's `input` and `output`, under the keys the file format keeps (decisions.md).
    expect(file.inputSchema.required).toEqual(['branch']);
    expect(file.inputSchema.properties['since']?.['format']).toBe('date');
    expect(file.outputSchema.required).toEqual(['notes']);
    expect(file.steps.map((step) => step['title'])).toEqual([
      'Find the last release',
      'Collect merged changes',
      'Draft the notes',
      'Wait for approval',
    ]);
    expect(file.steps.at(-1)).toEqual({
      title: 'Wait for approval',
      kind: 'await-signal',
      signal: 'notes-approved',
    });
  });

  test('Triage inbox is paused, and Order refund cannot be read past line 11', () => {
    expect(JSON.parse(SHOWCASE_TRIAGE_INBOX_FILE.text)).toMatchObject({
      name: 'triage-inbox',
      paused: true,
    });
    expect(() => JSON.parse(SHOWCASE_ORDER_REFUND_FILE.text)).toThrow();
    const lines = SHOWCASE_ORDER_REFUND_FILE.text.split('\n');
    expect(lines[10]).toBe('      "input": { "agent": "tool-runner"');
    expect(lines[11]).toBe('        "message": "Issue the approved refund." } }');
  });
});

describe('showcaseHostOptions', () => {
  test('registers the six built-in agents and the stub provider', () => {
    const options = showcaseHostOptions();
    expect(Object.keys(options.extraAgents?.agents ?? {})).toEqual([...SHOWCASE_AGENT_IDENTIFIERS]);
    expect(options.resolveProviderGenerate).toBeFunction();
  });
});
