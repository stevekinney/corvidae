import { describe, expect, test } from 'bun:test';

import type { Skill } from '../../lib/bureau-skills.ts';
import {
  approvalLabel,
  isUntrusted,
  matchesFilter,
  skillKey,
  skillSourceLabel,
  tierDescription,
  tierLabel,
  tierOf,
  tierVariant,
  toolSourceLabel,
  toolSummary,
  trustLabel,
  unavailableText,
  type CatalogTool,
} from './capability-presentation.ts';

const TOOL: CatalogTool = {
  name: 'read-file',
  description: 'Reads a file.\nThe second line tells the model more.',
  shortDescription: 'Reads one file',
  inputSchema: null,
  tier: 'read-only',
  defaultApproval: 'allow',
  source: 'host',
  plugin: null,
  users: [],
};

const SKILL: Skill = {
  name: 'summarize',
  description: 'Summarizes.',
  source: { id: 'home', kind: 'user', location: '/skills', plugin: null },
  trust: 'trusted',
  trustReason: 'Listed in the configuration.',
  available: true,
  unavailableReason: null,
  allowedTools: [],
};

describe('a tool’s tier', () => {
  test('reads a tool that declares none as unclassified, never as read-only', () => {
    expect(tierOf({ ...TOOL, tier: null })).toBe('unclassified');
    expect(tierLabel('unclassified')).toBe('Not classified');
    expect(tierVariant('unclassified')).toBe('neutral');
  });

  test('has words, a sentence and a badge variant for each tier', () => {
    expect(
      (['read-only', 'mutating', 'dangerous'] as const).map((tier) => [
        tierLabel(tier),
        tierDescription(tier),
        tierVariant(tier),
      ]),
    ).toEqual([
      ['Reads only', 'It looks at things and changes nothing.', 'success'],
      ['Changes things', 'It changes things.', 'warning'],
      ['Dangerous', 'It can do damage that is hard to undo.', 'danger'],
    ]);
  });
});

describe('a tool’s approval, source and summary', () => {
  test('say what an agent’s call does by default and where the tool comes from', () => {
    expect(approvalLabel(TOOL)).toBe('Runs without asking');
    expect(approvalLabel({ ...TOOL, defaultApproval: 'ask' })).toBe('Asks you first');
    expect(toolSourceLabel(TOOL)).toBe('MCP server');
    expect(toolSourceLabel({ ...TOOL, source: 'bureau' })).toBe('Built in');
    expect(toolSourceLabel({ ...TOOL, source: 'plugin', plugin: 'gemini' })).toBe('Plugin gemini');
  });

  test('is the one-line description, or the first line of the model’s when there is none', () => {
    expect(toolSummary(TOOL)).toBe('Reads one file');
    expect(toolSummary({ ...TOOL, shortDescription: null })).toBe('Reads a file.');
    expect(toolSummary({ ...TOOL, shortDescription: '  ' })).toBe('Reads a file.');
  });
});

describe('a skill’s trust and availability', () => {
  test('marks every skill whose source is not trusted, a revoked one included', () => {
    expect(isUntrusted(SKILL)).toBe(false);
    expect(isUntrusted({ ...SKILL, trust: 'untrusted' })).toBe(true);
    expect(isUntrusted({ ...SKILL, trust: 'revoked' })).toBe(true);
    expect(trustLabel({ ...SKILL, trust: 'untrusted' })).toBe('Not trusted');
    expect(trustLabel({ ...SKILL, trust: 'revoked' })).toBe('Trust revoked');
  });

  test('says why an unavailable skill is refused, in the host’s words for a reason it does not know', () => {
    expect(unavailableText(SKILL)).toBeUndefined();
    const refused = { ...SKILL, available: false };
    expect(unavailableText({ ...refused, unavailableReason: 'source-untrusted' })).toBe(
      'Its source is not trusted, so agents are refused it.',
    );
    expect(unavailableText({ ...refused, unavailableReason: 'something-new' })).toBe(
      'something-new',
    );
    expect(unavailableText({ ...refused, unavailableReason: 'constructor' })).toBe('constructor');
    expect(unavailableText({ ...refused, unavailableReason: null })).toBe(
      'An agent cannot use this skill yet.',
    );
  });

  test('keys a skill by its source and name, so two sources can hold one name', () => {
    expect(skillKey(SKILL)).toBe('home/summarize');
    expect(skillKey({ ...SKILL, source: { ...SKILL.source, id: 'workspace' } })).toBe(
      'workspace/summarize',
    );
    expect(skillSourceLabel(SKILL)).toBe('User');
    expect(skillSourceLabel({ ...SKILL, source: { ...SKILL.source, kind: 'built-in' } })).toBe(
      'Built in',
    );
  });
});

describe('the filter', () => {
  test('matches a name containing what was typed, ignoring case and the space around it', () => {
    expect(matchesFilter('Read-File', ' file ')).toBe(true);
    expect(matchesFilter('read-file', '')).toBe(true);
    expect(matchesFilter('read-file', 'write')).toBe(false);
  });
});
