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
  test('draws Tools, Runs, Memory, Storage and Advanced, and leaves out what other sections hold', () => {
    const sections = generalSections(KEYS, none, false);
    expect(sections.map((section) => section.id)).toEqual([
      'tools',
      'runs',
      'memory',
      'storage',
      'advanced',
    ]);
    const shown = sections.flatMap((section) => section.keys);
    expect(shown.filter((key) => key.startsWith('retention.'))).toEqual([]);
    expect(shown.filter((key) => key.startsWith('decisions.'))).toEqual([]);
    expect(shown.filter((key) => key.startsWith('a2a.'))).toEqual([]);
    expect(shown).not.toContain('modelPolicy');
    expect(sections[0]?.keys).toEqual(['tools.humanInput', 'tools.wakeup']);
  });

  test('keeps the two designed run settings visible and puts undrawn settings in Advanced', () => {
    const sections = generalSections(KEYS, none, false);
    const runs = sections.find((section) => section.id === 'runs');
    const advanced = sections.find((section) => section.id === 'advanced');
    expect(runs?.keys).toEqual(['engine.workflowClaimRenewInterval', 'engine.maxConcurrentRuns']);
    expect(advanced?.keys).toContain('tools.decide');
    expect(advanced?.keys).toContain('engine.history');
  });

  test('puts a new unmatched General key in Advanced and omits an empty disclosure', () => {
    const withExtra = generalSections([...KEYS, 'future.setting'], none, false);
    expect(withExtra.find((section) => section.id === 'advanced')?.keys).toContain(
      'future.setting',
    );
    expect(
      generalSections(['tools.humanInput', 'engine.maxConcurrentRuns'], none, false).find(
        (section) => section.id === 'advanced',
      ),
    ).toBeUndefined();
  });

  test('holds every memory setting under Memory, after Runs, and none of them under Runs (EM6-01)', () => {
    const sections = generalSections(KEYS, none, false);
    const memory = sections.find((section) => section.id === 'memory');
    expect(memory?.keys).toEqual(KEYS.filter((key) => key.startsWith('memory.')));
    expect(memory?.keys).toContain('memory.embedder');
    expect(sections.find((section) => section.id === 'runs')?.keys).not.toContain(
      'memory.embedder',
    );
  });

  test('moves what the deployment locks into the Remote deployment card in remote mode', () => {
    const locked = (key: string) => key === 'engine.maxConcurrentRuns' || key === 'durable';
    const sections = generalSections(KEYS, locked, true);
    expect(sections.map((section) => section.id)).toEqual([
      'tools',
      'runs',
      'memory',
      'remote',
      'advanced',
    ]);
    const remote = sections.find((section) => section.id === 'remote');
    expect([...(remote?.keys ?? [])].sort()).toEqual(['durable', 'engine.maxConcurrentRuns']);
    const runs = sections.find((section) => section.id === 'runs');
    expect(runs?.keys).not.toContain('durable');
  });

  test('keeps a locked advanced setting in its local disclosure', () => {
    const sections = generalSections(KEYS, (key) => key === 'durable', false);
    expect(sections.find((section) => section.id === 'advanced')?.keys).toContain('durable');
  });
});
