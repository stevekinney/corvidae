/** What Settings › Plugins says about a plugin, from what the host reports. */
import { describe, expect, test } from 'bun:test';

import { PLUGINS_COPY } from '../../../app/copy.ts';
import type { PluginStanding } from '../../../lib/host-plugins.ts';
import {
  contributionGroups,
  disableImpacts,
  inUseSentence,
  referenceTotals,
  sourceKind,
  sourceWord,
  standingCounts,
  statusOf,
} from './plugin-presentation.ts';
import { problemView } from './plugin-problems.ts';
import { contribution, installFakePluginHost, snapshotOf } from './plugins-host.test-support.ts';

function standing(fixture: Parameters<typeof installFakePluginHost>[0][number]): PluginStanding {
  const host = installFakePluginHost([fixture]);
  const result = snapshotOf(host).plugins[0]!;
  host.restore();
  return result;
}

describe('statusOf', () => {
  test('words the loaded status', () => {
    expect(statusOf(standing({ name: 'a' }), true)).toEqual({
      label: PLUGINS_COPY.status.running,
      dot: 'success',
    });
    expect(statusOf(standing({ name: 'a', status: 'needs-setup' }), true).dot).toBe('warning');
    expect(statusOf(standing({ name: 'a', enabled: false }), false).dot).toBe('neutral');
    expect(statusOf(standing({ name: 'a', status: 'skipped' }), true)).toEqual({
      label: PLUGINS_COPY.status.notLoaded,
      dot: 'danger',
    });
  });

  test('reads a choice the running host has not loaded as what it will be after a restart', () => {
    expect(statusOf(standing({ name: 'a' }), false).label).toBe(
      PLUGINS_COPY.status.disabledAfterRestart,
    );
    expect(statusOf(standing({ name: 'a', enabled: false }), true).label).toBe(
      PLUGINS_COPY.status.enabledAfterRestart,
    );
    const stored = { ...standing({ name: 'a' }), restartRequired: true };
    expect(statusOf(stored, true).label).toBe(PLUGINS_COPY.status.changesAfterRestart);
  });
});

describe('sources', () => {
  test('words each source', () => {
    expect(sourceWord('built-in')).toBe(PLUGINS_COPY.source.builtIn);
    expect(sourceWord('folder')).toBe(PLUGINS_COPY.source.folder);
    expect(sourceWord('package')).toBe(PLUGINS_COPY.source.package);
    expect(sourceKind('built-in')).toBe(PLUGINS_COPY.sourceKind.builtIn);
    expect(sourceKind('folder')).toBe(PLUGINS_COPY.sourceKind.folder);
    expect(sourceKind('package')).toBe(PLUGINS_COPY.sourceKind.package);
  });
});

describe('what a plugin adds and what names it', () => {
  const plugin = standing({
    name: 'linear',
    contributions: [
      contribution('tool', 'linear:a', { agents: 1 }),
      contribution('tool', 'linear:b', { agents: 2, schedules: 1 }),
      contribution('mystery', 'linear:c', { waitingRuns: 4 }),
    ],
  });

  test('groups by kind in order and keeps a kind it has no word for', () => {
    expect(contributionGroups(plugin)).toEqual([
      { kind: 'tool', label: 'Tools', ids: ['linear:a', 'linear:b'] },
      { kind: 'mystery', label: 'mystery', ids: ['linear:c'] },
    ]);
  });

  test('sums the references and says them', () => {
    expect(referenceTotals(plugin)).toEqual({ agents: 3, schedules: 1, waitingRuns: 4 });
    expect(inUseSentence(plugin)).toBe('3 agents, 1 schedule, 4 waiting runs name what it adds.');
    expect(inUseSentence(standing({ name: 'a' }))).toBe(PLUGINS_COPY.inUse.nothing);
    expect(inUseSentence(standing({ name: 'a', enabled: false }))).toBe(
      PLUGINS_COPY.inUse.disabled,
    );
    expect(inUseSentence(standing({ name: 'a', status: 'skipped' }))).toBe(
      PLUGINS_COPY.inUse.notRunning,
    );
  });

  test('lists what depends on it for the disable dialog, naming only the contributions that count', () => {
    const impacts = disableImpacts(plugin);
    expect(impacts.map((impact) => impact.key)).toEqual(['agents', 'schedules', 'waitingRuns']);
    expect(impacts[0]?.sentence).toContain('linear:a, linear:b');
    expect(impacts[1]?.sentence).toContain('linear:b');
    expect(impacts[1]?.sentence).not.toContain('linear:a');
    expect(impacts[2]?.sentence).toContain('linear:c');
    expect(disableImpacts(standing({ name: 'a' }))).toEqual([]);
  });

  test('agrees the verb with a count of one', () => {
    const one = standing({
      name: 'a',
      contributions: [contribution('tool', 'a:x', { agents: 1, schedules: 1, waitingRuns: 1 })],
    });
    expect(disableImpacts(one).map((impact) => impact.sentence)).toEqual([
      'uses a:x and shows as unavailable.',
      'starts runs through a:x. It stays listed and does nothing until it is back.',
      'waits on a:x. It shows as unavailable instead of resuming.',
    ]);
  });
});

describe('standingCounts', () => {
  test('counts running, needing setup and disabled', () => {
    const host = installFakePluginHost([
      { name: 'a' },
      { name: 'b', status: 'needs-setup' },
      { name: 'c', enabled: false },
      { name: 'd', status: 'skipped' },
    ]);
    const snapshot = snapshotOf(host);
    host.restore();
    expect(standingCounts(snapshot)).toEqual({ running: 1, needSetup: 1, disabled: 1 });
  });
});

describe('problemView', () => {
  test('gives each code its status, title, body and action', () => {
    expect(
      problemView({ code: 'secret-missing', key: 'k-api-key', contributions: ['k:a'] }),
    ).toEqual({
      status: { label: 'Needs setup', dot: 'warning' },
      title: 'A secret isn’t saved yet',
      body: 'k-api-key isn’t saved, so k:a is unavailable. Save it and it works at once; no restart.',
      action: { kind: 'secret', label: 'Add the key', key: 'k-api-key' },
    });
    expect(problemView({ code: 'reference-unresolved', file: 'x:t', id: 'x:y' })).toMatchObject({
      status: { label: 'Loaded, 1 file skipped', dot: 'warning' },
      body: 'x:t lists x:y, which no loaded plugin adds. The agent is unavailable until the name matches.',
      action: { kind: 'link', label: 'Open the file', href: '/agents/x%3At/edit' },
    });
    expect(problemView({ code: 'development-source', path: '/code/linear' })).toMatchObject({
      status: { label: 'Development', dot: 'accent' },
      action: { kind: 'copy', label: 'Open the folder', text: '/code/linear' },
    });
    for (const code of ['setup-failed', 'load-failed']) {
      expect(problemView({ code, message: 'it broke' })).toMatchObject({
        status: { label: 'Not loaded', dot: 'danger' },
        body: 'it broke',
      });
    }
    expect(problemView({ code: 'after-start-failed', message: 'it broke' }).status.dot).toBe(
      'warning',
    );
    expect(
      problemView({ code: 'mcp-app-failed', app: 'panel', message: 'no entry' }),
    ).toMatchObject({
      status: { label: 'Loaded, a page was not built', dot: 'warning' },
      body: 'The page panel is not served. no entry',
    });
  });

  test('reads an empty field as the whole configuration, and a model list as its own problem', () => {
    expect(problemView({ code: 'configuration-invalid', field: '', message: 'bad' }).body).toBe(
      'bad',
    );
    expect(
      problemView({ code: 'configuration-invalid', field: 'models', message: 'bad' }).title,
    ).toBe('A model list names a model nobody offers');
    expect(
      problemView({ code: 'configuration-invalid', field: 'modelsX', message: 'bad' }).title,
    ).toBe('A setting is invalid');
  });

  test('has no button for a problem with nothing to go to', () => {
    expect(problemView({ code: 'secret-missing', contributions: [] }).action).toBeUndefined();
    expect(problemView({ code: 'reference-unresolved', id: 'x:y' }).action).toBeUndefined();
    expect(problemView({ code: 'development-source' }).action).toBeUndefined();
  });

  test('keeps a code it has no words for, and reads missing fields as empty', () => {
    expect(problemView({ code: 'new-thing' }).body).toBe('Reported as new-thing.');
    expect(problemView({ code: 'name-clash', name: 'x' }).body).toBe(
      'The built-in x plugin and the built-in x plugin are both named x. The built-in x plugin loaded; rename the other.',
    );
    expect(problemView({ code: 'secret-missing', key: 'k' }).body).toBe(
      'k isn’t saved, so what this plugin adds is unavailable. Save it and it works at once; no restart.',
    );
  });
});
