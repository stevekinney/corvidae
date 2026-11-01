import { describe, expect, test } from 'bun:test';

import type { Skill } from '../../lib/bureau-skills.ts';
import type { ToolSourceStanding, ToolSourceTool } from '../../lib/host-tool-sources.ts';
import {
  approvalLabel,
  isUntrusted,
  matchesFilter,
  skillKey,
  skillSourceLabel,
  sourceKindLabel,
  sourceStateDescription,
  sourceStateLabel,
  sourceStateVariant,
  sourceToolStanding,
  sourceToolTier,
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

describe('a tool source', () => {
  const SOURCE_TOOL: ToolSourceTool = {
    name: 'notes__lookup',
    tool: 'lookup',
    acceptsSecrets: false,
    savedAcceptsSecrets: false,
    tier: 'read-only',
  };

  test('asks first for every tool that is not read-only, and for one that declares nothing', () => {
    expect(sourceToolStanding(SOURCE_TOOL)).toBe('runs');
    expect(sourceToolStanding({ ...SOURCE_TOOL, tier: 'mutating' })).toBe('asks-first');
    expect(sourceToolStanding({ ...SOURCE_TOOL, tier: 'dangerous' })).toBe('asks-first');
    expect(sourceToolStanding({ ...SOURCE_TOOL, tier: null })).toBe('asks-first');
    // A tier this build does not know is read as none, never as read-only.
    expect(sourceToolStanding({ ...SOURCE_TOOL, tier: 'read-only-ish' })).toBe('asks-first');
  });

  test('reads a tier it does not know as unclassified', () => {
    expect(sourceToolTier(SOURCE_TOOL)).toBe('read-only');
    expect(sourceToolTier({ ...SOURCE_TOOL, tier: 'something-new' })).toBe('unclassified');
    expect(sourceToolTier({ ...SOURCE_TOOL, tier: null })).toBe('unclassified');
  });

  test('has words and a badge for each state, and for each kind', () => {
    const states: ToolSourceStanding['state'][] = [
      'loaded',
      'failed',
      'needs-authorization',
      'pending-restart',
    ];
    expect(states.map(sourceStateVariant)).toEqual(['success', 'danger', 'warning', 'info']);
    for (const state of states) {
      expect(sourceStateLabel(state)).not.toBe('');
      expect(sourceStateDescription(state)).not.toBe('');
    }
    const source = { kind: 'openapi' } as ToolSourceStanding;
    expect(sourceKindLabel(source)).toBe('OpenAPI service');
    expect(sourceKindLabel({ ...source, kind: 'mcp' })).toBe('MCP server');
  });
});
