/**
 * The arrangement of Settings › General (`general-sections.ts`): which settings sit under which
 * heading, and where the ones a deployment owns go in remote mode.
 */
import { SETTING_KEYS } from '@lostgradient/bureau';
import { describe, expect, test } from 'bun:test';

import { generalSections } from './general-sections.ts';

const KEYS: readonly string[] = SETTING_KEYS;
const none = () => false;

describe('generalSections', () => {
  test('draws Tools, Runs and Storage, and leaves out what other sections hold', () => {
    const sections = generalSections(KEYS, none, false);
    expect(sections.map((section) => section.id)).toEqual(['tools', 'runs', 'storage']);
    const shown = sections.flatMap((section) => section.keys);
    expect(shown.filter((key) => key.startsWith('retention.'))).toEqual([]);
    expect(shown.filter((key) => key.startsWith('decisions.'))).toEqual([]);
    expect(shown.filter((key) => key.startsWith('a2a.'))).toEqual([]);
    expect(shown).not.toContain('modelPolicy');
    expect(sections[0]?.keys).toEqual(['tools.humanInput', 'tools.wakeup', 'tools.decide']);
  });

  test('puts every engine setting under Runs, the claim interval first, then the run limit', () => {
    const keys = [...KEYS, 'engine.maxConcurrentRuns'];
    const runs = generalSections(keys, none, false).find((section) => section.id === 'runs');
    expect(runs?.keys.slice(0, 2)).toEqual([
      'engine.workflowClaimRenewInterval',
      'engine.maxConcurrentRuns',
    ]);
    expect(runs?.keys.filter((key) => key.startsWith('engine.')).length).toBeGreaterThan(2);
  });

  test('moves what the deployment locks into the Remote deployment card in remote mode', () => {
    const locked = (key: string) => key === 'engine.maxConcurrentRuns' || key === 'durable';
    const keys = [...KEYS, 'engine.maxConcurrentRuns'];
    const sections = generalSections(keys, locked, true);
    expect(sections.map((section) => section.id)).toEqual(['tools', 'runs', 'remote']);
    const remote = sections.find((section) => section.id === 'remote');
    expect([...(remote?.keys ?? [])].sort()).toEqual(['durable', 'engine.maxConcurrentRuns']);
    const runs = sections.find((section) => section.id === 'runs');
    expect(runs?.keys).not.toContain('durable');
  });

  test('keeps a locked setting in its section on a local host', () => {
    const sections = generalSections(KEYS, (key) => key === 'durable', false);
    expect(sections.find((section) => section.id === 'runs')?.keys).toContain('durable');
  });
});
