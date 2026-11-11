import { describe, expect, test } from 'bun:test';

import type { Skill } from '../../lib/bureau-skills.ts';
import type { ToolSourceStanding, ToolSourceTool } from '../../lib/host-tool-sources.ts';
import {
  asksLabel,
  asksTooltip,
  asksWord,
  defaultAsks,
  groupToolsBySource,
  isUntrusted,
  matchesFilter,
  matchesSkillFilter,
  matchesSourceFilter,
  matchesToolFilter,
  riskLabel,
  riskTooltip,
  skillHeading,
  skillKey,
  skillMeta,
  skillSourceLabel,
  sourceHeading,
  sourceKindLabel,
  sourceStateDescription,
  sourceStateLabel,
  sourceStateVariant,
  sourceStatusFacts,
  sourceStatusTone,
  sourceToolApproval,
  sourceToolHeading,
  sourceToolStanding,
  sourceToolTier,
  sourceToolWaitsForRestart,
  tierLabel,
  tierOf,
  tierVariant,
  toolGroup,
  toolHeading,
  toolRowSource,
  toolSourceChip,
  toolSourceLabel,
  toolSourceTooltip,
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
  title: null,
  skill: null,
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
  tools: [],
};

describe('a tool’s tier', () => {
  test('reads a tool that declares none as unclassified, never as read-only', () => {
    expect(tierOf({ ...TOOL, tier: null })).toBe('unclassified');
    expect(tierLabel('unclassified')).toBe('Not classified');
    expect(tierVariant('unclassified')).toBe('neutral');
  });

  test('has words and a badge variant for each tier', () => {
    expect(
      (['read-only', 'mutating', 'dangerous'] as const).map((tier) => [
        tierLabel(tier),
        tierVariant(tier),
      ]),
    ).toEqual([
      ['Reads only', 'success'],
      ['Changes things', 'warning'],
      ['Dangerous', 'danger'],
    ]);
  });

  test('has a muted risk word and a tooltip sentence for each tier, never a colour', () => {
    expect(
      (['read-only', 'mutating', 'dangerous', 'unclassified'] as const).map((tier) => [
        riskLabel(tier),
        riskTooltip(tier),
      ]),
    ).toEqual([
      ['Reads', 'Looks at things and changes nothing.'],
      ['Changes things', 'Changes things in what it reaches.'],
      ['Dangerous', 'Can do damage that is hard to undo.'],
      ['Not classified', 'Does not say what it does, so it is treated as one that changes things.'],
    ]);
  });
});

describe('a tool’s default asks level', () => {
  test('is Never for a read, On changes for a change or an unclassified tool, and Always for a dangerous one', () => {
    expect(defaultAsks(TOOL)).toBe('never');
    expect(defaultAsks({ ...TOOL, tier: 'mutating', defaultApproval: 'ask' })).toBe('on-changes');
    expect(defaultAsks({ ...TOOL, tier: null, defaultApproval: 'ask' })).toBe('on-changes');
    expect(defaultAsks({ ...TOOL, tier: 'dangerous', defaultApproval: 'ask' })).toBe('always');
    expect(asksLabel(TOOL)).toBe('Asks: Never');
    expect(asksLabel({ ...TOOL, tier: 'dangerous', defaultApproval: 'ask' })).toBe('Asks: Always');
  });

  test('is never Blocked, which belongs to one agent’s file, and its tooltip names the four values', () => {
    for (const tier of ['read-only', 'mutating', 'dangerous', null] as const) {
      for (const defaultApproval of ['allow', 'ask'] as const) {
        expect(defaultAsks({ ...TOOL, tier, defaultApproval })).not.toBe('blocked');
      }
    }
    expect(asksTooltip(TOOL)).toBe(
      'Runs without asking. The values are Never, On changes, Always and Blocked. A chat’s permission mode never overrides Always or Blocked.',
    );
  });
});

describe('a tool’s source chip and heading', () => {
  test('says Built in, From the server its name leads with, From the plugin, or From the skill', () => {
    expect(toolSourceChip({ ...TOOL, source: 'bureau' })).toBe('Built in');
    expect(toolSourceChip({ ...TOOL, name: 'github__create_issue' })).toBe('From github');
    expect(toolSourceChip(TOOL)).toBe('From an MCP server');
    expect(toolSourceChip({ ...TOOL, source: 'plugin', plugin: 'demo' })).toBe(
      'From the demo plugin',
    );
    expect(toolSourceChip({ ...TOOL, source: 'skill', skill: 'lookup' })).toBe(
      'From the lookup skill',
    );
    expect(toolSourceTooltip({ source: 'bureau' })).toBe(
      'Ships with Interborough, not from a plugin.',
    );
  });

  test('is the tool’s title, or its identifier read as words with the plugin or server left off', () => {
    expect(toolHeading({ name: 'issue-refund', title: 'Issue refund' })).toBe('Issue refund');
    expect(toolHeading({ name: 'bureau:discover-agents', title: null })).toBe('Discover agents');
    expect(toolHeading({ name: 'github__create_issue', title: '  ' })).toBe('Create issue');
    expect(toolHeading({ name: 'read-file', title: null })).toBe('Read file');
    expect(toolHeading({ name: 'bureau:', title: null })).toBe('bureau:');
  });
});

describe('a tool’s source and summary', () => {
  test('say where the tool comes from', () => {
    expect(toolSourceLabel(TOOL)).toBe('MCP server');
    expect(toolSourceLabel({ ...TOOL, source: 'bureau' })).toBe('Built in');
    expect(toolSourceLabel({ ...TOOL, source: 'plugin', plugin: 'gemini' })).toBe('Plugin gemini');
    expect(toolSourceLabel({ ...TOOL, source: 'skill', skill: 'customer-lookup' })).toBe(
      'Skill customer-lookup',
    );
  });

  test('is the one-line description, or the first line of the model’s when there is none', () => {
    expect(toolSummary(TOOL)).toBe('Reads one file');
    expect(toolSummary({ ...TOOL, shortDescription: null })).toBe('Reads a file.');
    expect(toolSummary({ ...TOOL, shortDescription: '  ' })).toBe('Reads a file.');
  });
});

describe('a tool’s row', () => {
  test('names its source: Built in, or the server, plugin or skill read as words', () => {
    expect(toolRowSource({ ...TOOL, source: 'bureau' })).toBe('Built in');
    expect(toolRowSource({ ...TOOL, name: 'github__list_branches' })).toBe('Github');
    expect(toolRowSource(TOOL)).toBe('MCP server');
    expect(toolRowSource({ ...TOOL, source: 'plugin', plugin: 'gemini' })).toBe('Gemini');
    expect(toolRowSource({ ...TOOL, source: 'skill', skill: 'customer-lookup' })).toBe(
      'Customer lookup',
    );
  });

  test('says the asks level in the one word the Access tab uses', () => {
    expect(asksWord(TOOL)).toBe('Never');
    expect(asksWord({ ...TOOL, tier: 'mutating', defaultApproval: 'ask' })).toBe('On changes');
    expect(asksWord({ ...TOOL, tier: 'dangerous', defaultApproval: 'ask' })).toBe('Always');
  });

  test('matches what is typed against the name for a person and against the identifier', () => {
    const tool = { ...TOOL, name: 'github__delete_branch', title: 'Delete branch' };
    expect(matchesToolFilter(tool, 'delete branch')).toBe(true);
    expect(matchesToolFilter(tool, 'github__del')).toBe(true);
    expect(matchesToolFilter(tool, 'invoice')).toBe(false);
  });

  test('groups one key per source, and puts Built in first and the others by name', () => {
    const github = { ...TOOL, name: 'github__list_branches' };
    const notes = { ...TOOL, name: 'notes__lookup' };
    const builtIn = { ...TOOL, name: 'discover-agents', source: 'bureau' as const };
    expect(toolGroup(github)).toEqual({ key: 'host:github', label: 'Github' });
    expect(toolGroup(builtIn)).toEqual({ key: 'bureau:', label: 'Built in' });
    // Each source's tools stay in the catalog's order, and the sources are not interleaved.
    const ordered = groupToolsBySource([
      notes,
      github,
      { ...github, name: 'github__get_pull_request' },
      builtIn,
    ]);
    expect(ordered.map((tool) => tool.name)).toEqual([
      'discover-agents',
      'github__list_branches',
      'github__get_pull_request',
      'notes__lookup',
    ]);
  });
});

describe('a skill’s name and line', () => {
  test('reads the identifier as words, and matches by either', () => {
    expect(skillHeading({ name: 'release-notes' })).toBe('Release notes');
    expect(matchesSkillFilter({ ...SKILL, name: 'release-notes' }, 'release notes')).toBe(true);
    expect(matchesSkillFilter({ ...SKILL, name: 'release-notes' }, 'release-')).toBe(true);
    expect(matchesSkillFilter({ ...SKILL, name: 'release-notes' }, 'invoice')).toBe(false);
  });

  test('says what it holds, where it is from and when it loads, with no separator mark', () => {
    expect(skillMeta({ ...SKILL, source: { ...SKILL.source, kind: 'built-in' } })).toEqual([
      'Instructions only',
      'Built in',
      'Loaded when relevant',
    ]);
    expect(skillMeta({ ...SKILL, tools: ['find_customer', 'merge_customers'] })[0]).toBe(
      'Instructions and 2 tools',
    );
    expect(skillMeta({ ...SKILL, tools: ['find_customer'] })[0]).toBe('Instructions and 1 tool');
    expect(skillMeta(SKILL).join('')).not.toContain(String.fromCodePoint(0xb7));
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
    expect(sourceKindLabel(source)).toBe('OpenAPI spec');
    expect(sourceKindLabel({ ...source, kind: 'mcp' })).toBe('MCP server');
  });

  test('is named by what the host saved, and by its identifier when it saved nothing (rows 31o, 32k)', () => {
    expect(sourceHeading({ id: 'github', name: 'GitHub' })).toBe('GitHub');
    expect(sourceHeading({ id: 'github', name: null })).toBe('github');
    expect(sourceHeading({ id: 'github', name: '  ' })).toBe('github');
    expect(sourceHeading({ id: 'github' })).toBe('github');
    expect(matchesSourceFilter({ id: 'gh', name: 'GitHub' }, 'hub')).toBe(true);
    expect(matchesSourceFilter({ id: 'gh', name: 'GitHub' }, 'gh')).toBe(true);
    expect(matchesSourceFilter({ id: 'gh', name: 'GitHub' }, 'jira')).toBe(false);
  });

  test('draws the dot of each state, a source waiting for a restart as the hollow one', () => {
    expect(sourceStatusTone('loaded')).toBe('success');
    expect(sourceStatusTone('failed')).toBe('danger');
    expect(sourceStatusTone('needs-authorization')).toBe('warning');
    expect(sourceStatusTone('pending-restart')).toBe('pending');
  });

  test('lists how it signs in, when it was last tested and what it is, in that order (row 32k)', () => {
    const now = Date.parse('2026-11-11T10:00:00.000Z');
    const tested = '2026-11-11T09:00:00.000Z';
    expect(
      sourceStatusFacts({ kind: 'openapi', credentials: ['key'], lastTested: tested }, now),
    ).toEqual(['Credential stored', 'last tested 1 h ago', 'OpenAPI spec']);
    // An OAuth source says so, whether or not it holds tokens; one with nothing stored and no test says only what it is.
    expect(sourceStatusFacts({ kind: 'mcp', credentials: [], authorized: false }, now)).toEqual([
      'OAuth sign-in',
      'MCP server',
    ]);
    expect(sourceStatusFacts({ kind: 'mcp', credentials: [] }, now)).toEqual(['MCP server']);
    // A time that is not a time is left out.
    expect(
      sourceStatusFacts({ kind: 'mcp', credentials: [], lastTested: 'yesterday' }, now),
    ).toEqual(['MCP server']);
  });

  test('names a tool for a person and gives it the Default asks level its tier gives (rows 32l, 32r)', () => {
    expect(sourceToolHeading({ tool: 'list_invoices' })).toBe('List invoices');
    expect(sourceToolApproval(SOURCE_TOOL)).toBe('never');
    expect(sourceToolApproval({ ...SOURCE_TOOL, tier: 'mutating' })).toBe('on-changes');
    expect(sourceToolApproval({ ...SOURCE_TOOL, tier: 'dangerous' })).toBe('always');
    // A tool that declares nothing asks on changes, never Never.
    expect(sourceToolApproval({ ...SOURCE_TOOL, tier: null })).toBe('on-changes');
    // The level the host reports is the one shown, the owner's pick included.
    expect(sourceToolApproval({ ...SOURCE_TOOL, tier: 'dangerous', approval: 'never' })).toBe(
      'never',
    );
  });

  test('has a setting waiting for a restart when the saved switch or checkbox differs from the running one', () => {
    expect(sourceToolWaitsForRestart(SOURCE_TOOL)).toBe(false);
    expect(sourceToolWaitsForRestart({ ...SOURCE_TOOL, savedAcceptsSecrets: true })).toBe(true);
    expect(sourceToolWaitsForRestart({ ...SOURCE_TOOL, enabled: true, savedEnabled: false })).toBe(
      true,
    );
    expect(sourceToolWaitsForRestart({ ...SOURCE_TOOL, enabled: false, savedEnabled: false })).toBe(
      false,
    );
    // A host that reports nothing about it reads the tool as on, and nothing waits.
    expect(sourceToolWaitsForRestart({ ...SOURCE_TOOL, savedEnabled: true })).toBe(false);
  });
});
