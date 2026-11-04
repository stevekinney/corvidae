/**
 * The showcase development host's pieces (`showcase.ts`): the flag, the home it defaults to, the
 * sample world's workflow files, and what a showcase host is started with.
 */
import { describe, expect, test } from 'bun:test';

import {
  SHOWCASE_ORDER_REFUND_FILE,
  SHOWCASE_ORDER_REFUND_VALID_FILE,
  SHOWCASE_RELEASE_NOTES_FILE,
  SHOWCASE_TRIAGE_INBOX_FILE,
} from '../../fixtures/showcase-content.ts';
import { SHOWCASE_AGENT_IDENTIFIERS } from './showcase-agents.ts';
import {
  SHOWCASE_ALERTS,
  SHOWCASE_FLAG,
  SHOWCASE_STORAGE_WARNING_BYTES,
  showcaseEnvironment,
  showcaseHookFetch,
  showcaseHostOptions,
  splitShowcaseFlag,
} from './showcase.ts';

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

describe('the sample world workflow files', () => {
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

  test('Triage inbox is paused, with Inbox triage as its trigger, and Order refund cannot be read past line 11', () => {
    expect(JSON.parse(SHOWCASE_TRIAGE_INBOX_FILE.text)).toMatchObject({
      name: 'triage-inbox',
      paused: true,
      trigger: {
        kind: 'schedule',
        name: 'Inbox triage',
        spec: '0 8 * * *',
        timezone: 'America/Chicago',
      },
    });
    expect(() => JSON.parse(SHOWCASE_ORDER_REFUND_FILE.text)).toThrow();
    const lines = SHOWCASE_ORDER_REFUND_FILE.text.split('\n');
    expect(lines[10]).toBe('      "input": { "agent": "tool-runner"');
    expect(lines[11]).toBe('        "message": "Issue the approved refund." } }');
  });

  test('Order refund’s last good version carries the Weekly refund audit schedule, and differs from the broken file only by the comma on line 11', () => {
    expect(JSON.parse(SHOWCASE_ORDER_REFUND_VALID_FILE.text)).toMatchObject({
      name: 'order-refund',
      trigger: {
        kind: 'schedule',
        name: 'Weekly refund audit',
        spec: '0 11 * * 1',
        timezone: 'America/Chicago',
      },
    });
    const valid = SHOWCASE_ORDER_REFUND_VALID_FILE.text.split('\n');
    const broken = SHOWCASE_ORDER_REFUND_FILE.text.split('\n');
    expect(broken).toHaveLength(valid.length);
    const differing = valid.flatMap((line, index) => (line === broken[index] ? [] : [index + 1]));
    expect(differing).toEqual([11]);
    expect(valid[10]).toBe(`${broken[10]},`);
  });
});

describe('showcaseHostOptions', () => {
  test('registers the six built-in agents and the stub provider', () => {
    const options = showcaseHostOptions();
    // Workflow author holds Bureau's own tools, so it is built from them once the Bureau has made them.
    expect([
      ...Object.keys(options.extraAgents?.agents ?? {}),
      ...Object.keys(options.extraAgents?.withBureauTools ?? {}),
    ]).toEqual([...SHOWCASE_AGENT_IDENTIFIERS]);
    expect(options.resolveProviderGenerateFor).toBeFunction();
  });

  test('loads Guardrails, Ollama and Voyage beside the workspace’s plugins', () => {
    const names = (showcaseHostOptions().plugins ?? []).map((entry) => entry.descriptor.name);
    expect(names).toEqual([
      'anthropic',
      'openai',
      'gemini',
      'typesafe',
      'inspectors',
      'demo',
      'workspace',
      'guardrails',
      'ollama',
      'voyage',
    ]);
  });

  test('registers the goal checks as validators', () => {
    const validators = showcaseHostOptions().extraAgents?.validators ?? [];
    expect(validators.map((validator) => validator.identity.name)).toEqual([
      'reply-says-hello',
      'notes-mention-the-staging-fix',
      'summary-lists-every-refund-waiting-for-approval',
    ]);
  });

  test('fires a storage alert over 1 GB, with no periodic size report to resolve it', () => {
    const options = showcaseHostOptions();
    expect(SHOWCASE_STORAGE_WARNING_BYTES).toBe(1024 ** 3);
    expect(options.alerts).toBe(SHOWCASE_ALERTS);
    expect(SHOWCASE_ALERTS.rules).toEqual([
      { metric: 'storage.size', threshold: SHOWCASE_STORAGE_WARNING_BYTES, action: 'webhook' },
    ]);
    expect(SHOWCASE_ALERTS.webhooks).toBeUndefined();
    expect(options.storageSizeReportIntervalMilliseconds).toBe(0);
  });

  test('delivers hooks through a fetch that answers 200 itself and posts nowhere', async () => {
    expect(showcaseHostOptions().hookFetch).toBe(showcaseHookFetch);
    const response = await showcaseHookFetch('https://events.pagerduty.com/v2/enqueue', {
      method: 'POST',
      body: '{}',
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });
});
