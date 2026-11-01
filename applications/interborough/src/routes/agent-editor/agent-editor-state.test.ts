/**
 * The agent editor's form: what it offers from the catalog, how the identifier follows the name,
 * which models and tools a save may name, and what a save sends. A save carries the loaded
 * `skillDescriptors` through untouched, sends its A2A opt-in, and writes an unchanged model back
 * exactly as the file wrote it.
 */
import { describe, expect, test } from 'bun:test';

import { AGENT_EDITOR_COPY } from '../../app/copy.ts';
import type { Effort } from '../../lib/agent-definitions.ts';
import { catalogFixture, readyAgent } from '../../lib/bureau-stub.test-support.ts';
import { restrictionsOf } from './agent-editor-models.ts';
import { AgentEditorState, slugify } from './agent-editor-state.svelte.ts';

describe('slugify', () => {
  test('lowercases, joins words with single hyphens, and trims the ends', () => {
    expect(slugify('Research Assistant')).toBe('research-assistant');
    expect(slugify('  --Order   Lookup!! ')).toBe('order-lookup');
    expect(slugify('Tool: v2 (beta)')).toBe('tool-v2-beta');
  });

  test('drops accents and anything that is not a letter or digit', () => {
    expect(slugify('Café Écrivain')).toBe('cafe-ecrivain');
    expect(slugify('日本語')).toBe('');
    expect(slugify('')).toBe('');
  });

  test('stops at the identifier cap without leaving a hyphen at the end', () => {
    const long = `${'a'.repeat(63)} b`;
    const slug = slugify(long);
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug.endsWith('-')).toBe(false);
    expect(slugify('a'.repeat(100))).toBe('a'.repeat(64));
  });
});

describe('a new agent', () => {
  test('starts empty with the catalog’s first model chosen, and cannot save until it is named', () => {
    const form = AgentEditorState.create(catalogFixture());
    expect(form.mode).toBe('create');
    expect(form.model).toBe('anthropic/claude-sonnet-5');
    expect(form.hash).toBeNull();
    expect(form.canSave).toBe(false);
    form.name = 'Research Assistant';
    expect(form.canSave).toBe(true);
  });

  test('fills the identifier from the name as a slug until the identifier is edited', () => {
    const form = AgentEditorState.create(catalogFixture());
    form.name = 'Research Assistant';
    expect(form.identifier).toBe('research-assistant');
    form.name = 'Research Helper';
    expect(form.identifier).toBe('research-helper');
    form.identifier = 'helper';
    form.name = 'Something Else';
    expect(form.identifier).toBe('helper');
  });

  test('says an identifier that is not a valid file name is not valid, and will not save it', () => {
    const form = AgentEditorState.create(catalogFixture());
    form.identifier = 'Not Valid';
    expect(form.identifierError).toBe(AGENT_EDITOR_COPY.identifierInvalid);
    expect(form.canSave).toBe(false);
    form.identifier = 'a'.repeat(65);
    expect(form.identifierError).toBe(AGENT_EDITOR_COPY.identifierInvalid);
    form.identifier = '-leading';
    expect(form.canSave).toBe(false);
    form.identifier = 'valid-1';
    expect(form.identifierError).toBe('');
    expect(form.canSave).toBe(true);
  });

  test('refuses the identifier new, which is the address of the page that creates an agent', () => {
    const form = AgentEditorState.create(catalogFixture());
    form.name = 'New';
    expect(form.identifier).toBe('new');
    expect(form.identifierError).toBe(AGENT_EDITOR_COPY.identifierReserved);
    expect(form.canSave).toBe(false);
    form.name = 'New Agent';
    expect(form.identifierError).toBe('');
    expect(form.canSave).toBe(true);
    form.identifier = 'new';
    expect(form.identifierError).toBe(AGENT_EDITOR_COPY.identifierReserved);
    expect(form.canSave).toBe(false);
  });

  test('has no error for an identifier that is still empty', () => {
    const form = AgentEditorState.create(catalogFixture());
    expect(form.identifier).toBe('');
    expect(form.identifierError).toBe('');
    expect(form.canSave).toBe(false);
  });

  test('shows why the Bureau refused an identifier, until the identifier changes', () => {
    const form = AgentEditorState.create(catalogFixture());
    form.identifier = 'assistant';
    form.markIdentifierTaken('shadows-code-agent');
    expect(form.identifierError).toBe(AGENT_EDITOR_COPY.identifierTaken['shadows-code-agent']);
    form.identifier = 'assistant-2';
    expect(form.identifierError).toBe('');
    form.identifier = 'assistant';
    form.markIdentifierTaken('agent-file-exists');
    expect(form.identifierError).toBe(AGENT_EDITOR_COPY.identifierTaken['agent-file-exists']);
  });

  test('cannot save when the catalog offers no model, and chooses none', () => {
    const form = AgentEditorState.create(catalogFixture({ models: [] }));
    form.name = 'Researcher';
    expect(form.hasModels).toBe(false);
    expect(form.model).toBe('');
    expect(form.canSave).toBe(false);
  });

  test('sends its fields, no skill descriptors of its own, and its A2A opt-in', () => {
    const form = AgentEditorState.create(catalogFixture());
    form.name = '  Researcher ';
    form.description = '';
    form.instructions = 'Cite everything.';
    form.setTool('lookup-order', true);
    expect(form.toDefinition()).toEqual({
      name: 'Researcher',
      description: null,
      model: 'anthropic/claude-sonnet-5',
      tools: ['lookup-order'],
      skillDescriptors: [],
      a2a: false,
      // A limit left empty is `null`, which removes it from a file that had one.
      guardrails: null,
      stepLimit: null,
      costBudget: null,
      toolBudget: null,
      instructions: 'Cite everything.',
    });
    form.a2a = true;
    expect(form.toDefinition().a2a).toBe(true);
  });

  test('leaves the name out when it is blank, so the file takes the identifier', () => {
    const form = AgentEditorState.create(catalogFixture());
    form.identifier = 'plain';
    expect('name' in form.toDefinition()).toBe(false);
  });

  test('ignores a write to the identifier of an agent that exists', () => {
    const form = AgentEditorState.edit(readyAgent(), catalogFixture());
    form.identifier = 'renamed';
    expect(form.identifier).toBe('researcher');
  });
});

describe('the model the form chooses', () => {
  const restrictions = restrictionsOf({
    deployment: { deniedProviders: ['openai'] },
    policyRevision: 1,
  });
  const catalog = catalogFixture({
    models: [
      { provider: 'openai', model: 'gpt-4.1' },
      {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        aliases: [{ alias: 'sonnet', resolvesTo: 'claude-sonnet-5' }],
      },
    ],
  });

  /** An agent whose file writes `model`. */
  function writing(model: string) {
    const detail = readyAgent();
    if (detail.definition === null) throw new Error('expected a definition');
    detail.definition = { ...detail.definition, model };
    return detail;
  }

  test('is the first model that can be chosen for a new agent, not one the policy forbids', () => {
    expect(AgentEditorState.create(catalog).model).toBe('openai/gpt-4.1');
    expect(AgentEditorState.create(catalog, { restrictions }).model).toBe(
      'anthropic/claude-sonnet-5',
    );
  });

  test('is none, and cannot be saved, when every model is forbidden', () => {
    const form = AgentEditorState.create(catalog, {
      restrictions: restrictionsOf({
        deployment: { deniedProviders: ['openai', 'anthropic'] },
        policyRevision: 1,
      }),
    });
    form.name = 'Researcher';
    expect(form.hasModels).toBe(true);
    expect(form.model).toBe('');
    expect(form.chosenModel).toBeUndefined();
    expect(form.canSave).toBe(false);
  });

  test('stays the file’s model when the policy now forbids it, and is written back as it was', () => {
    const form = AgentEditorState.edit(writing('openai/gpt-4.1'), catalog, { restrictions });
    expect(form.model).toBe('openai/gpt-4.1');
    expect(form.chosenModel?.unavailable).toBe('provider-denied');
    expect(form.canSave).toBe(true);
    expect(form.toDefinition().model).toBe('openai/gpt-4.1');
  });

  test('stays the file’s alias, written back as the file wrote it, while the option is the model', () => {
    const form = AgentEditorState.edit(writing('anthropic/sonnet'), catalog, { restrictions });
    expect(form.model).toBe('anthropic/claude-sonnet-5');
    expect(form.toDefinition().model).toBe('anthropic/sonnet');
  });

  test('stays the file’s model when the catalog no longer lists it, and is written back unchanged', () => {
    const form = AgentEditorState.edit(writing('gemini/gemini-2.5-pro'), catalog, {
      hostProviders: [{ name: 'gemini', hasKey: false }],
    });
    expect(form.model).toBe('gemini/gemini-2.5-pro');
    expect(form.chosenModel?.unavailable).toBe('not-in-catalog');
    expect(form.canSave).toBe(true);
    expect(form.toDefinition().model).toBe('gemini/gemini-2.5-pro');
    // It joined the group of its provider, which has no key.
    expect(form.modelGroups.map((group) => [group.provider, group.connected])).toEqual([
      ['openai', true],
      ['anthropic', true],
      ['gemini', false],
    ]);
  });

  test('sends a model the person chose instead of the file’s', () => {
    const form = AgentEditorState.edit(writing('openai/gpt-4.1'), catalog, { restrictions });
    form.model = 'anthropic/claude-sonnet-5';
    expect(form.toDefinition().model).toBe('anthropic/claude-sonnet-5');
  });
});

describe('an agent that exists', () => {
  test('is filled from its file, with the alias resolved to the option it names', () => {
    const form = AgentEditorState.edit(readyAgent(), catalogFixture());
    expect(form.mode).toBe('edit');
    expect(form.identifier).toBe('researcher');
    expect(form.name).toBe('Researcher');
    expect(form.description).toBe('Finds and cites sources');
    expect(form.model).toBe('anthropic/claude-sonnet-5');
    expect(form.tools).toEqual(['lookup-order']);
    expect(form.instructions).toBe('You are a careful researcher.');
    expect(form.hash).toBe('hash-1');
    expect(form.a2a).toBe(false);
    expect(form.canSave).toBe(true);
  });

  test('keeps a key of a skill this page does not know, and writes it back unchanged', () => {
    const detail = readyAgent();
    const skill = { id: 'cite', name: 'Cite', description: 'Cites', tags: [], futureKey: { a: 1 } };
    const form = AgentEditorState.edit(
      {
        ...detail,
        definition: detail.definition && { ...detail.definition, skillDescriptors: [skill] },
      },
      catalogFixture(),
    );
    expect(form.toDefinition().skillDescriptors).toEqual([skill]);
  });

  test('carries the loaded skills through a save unchanged, and writes an unchanged alias back as written', () => {
    const detail = readyAgent();
    const form = AgentEditorState.edit(detail, catalogFixture());
    form.instructions = 'Changed.';
    const sent = form.toDefinition();
    expect(sent.skillDescriptors).toEqual(detail.definition?.skillDescriptors ?? []);
    expect(sent.model).toBe('anthropic/sonnet');
    expect(sent.instructions).toBe('Changed.');
  });

  test('carries the loaded models list through a save with an unrelated edit, unchanged', () => {
    const detail = readyAgent();
    const models = ['anthropic/sonnet', 'openai/gpt-4.1'];
    const form = AgentEditorState.edit(
      { ...detail, definition: detail.definition && { ...detail.definition, models } },
      catalogFixture(),
    );
    form.description = 'Described again.';
    const sent = form.toDefinition();
    expect(sent.models).toEqual(models);
    expect(sent.description).toBe('Described again.');
  });

  test('saves an agent that lists no models with none', () => {
    const form = AgentEditorState.edit(readyAgent(), catalogFixture());
    form.description = 'Described again.';
    expect('models' in form.toDefinition()).toBe(false);
    expect('models' in AgentEditorState.create(catalogFixture()).toDefinition()).toBe(false);
  });

  test('writes the chosen model once it is changed', () => {
    const form = AgentEditorState.edit(readyAgent(), catalogFixture());
    form.model = 'anthropic/claude-haiku-5';
    expect(form.toDefinition().model).toBe('anthropic/claude-haiku-5');
  });

  test('keeps a missing description as null and offers only the tools the catalog lists', () => {
    const detail = readyAgent();
    const form = AgentEditorState.edit(
      {
        ...detail,
        definition: detail.definition && {
          ...detail.definition,
          description: null,
          tools: ['lookup-order', 'gone'],
        },
      },
      catalogFixture(),
    );
    expect(form.description).toBe('');
    expect(form.toDefinition().description).toBeNull();
    expect(form.toDefinition().tools).toEqual(['lookup-order']);
  });

  test('refuses an agent with no definition or no hash, which has nothing to edit', () => {
    expect(() => AgentEditorState.edit(readyAgent({ definition: null }), catalogFixture())).toThrow(
      TypeError,
    );
    expect(() => AgentEditorState.edit(readyAgent({ hash: null }), catalogFixture())).toThrow(
      TypeError,
    );
  });

  test('ticks and clears tools without repeating one', () => {
    const form = AgentEditorState.edit(readyAgent(), catalogFixture());
    expect(form.hasTool('lookup-order')).toBe(true);
    form.setTool('lookup-order', true);
    expect(form.tools).toEqual(['lookup-order']);
    form.setTool('lookup-order', false);
    expect(form.hasTool('lookup-order')).toBe(false);
    form.setTool('lookup-order', true);
    expect(form.tools).toEqual(['lookup-order']);
  });

  test('is filled with the A2A opt-in its file states, and sends it back', () => {
    const detail = readyAgent();
    const form = AgentEditorState.edit(
      { ...detail, definition: detail.definition && { ...detail.definition, a2a: true } },
      catalogFixture(),
    );
    expect(form.a2a).toBe(true);
    expect(form.toDefinition().a2a).toBe(true);
  });

  test('has no identifier error, whatever the name', () => {
    const form = AgentEditorState.edit(readyAgent(), catalogFixture());
    form.name = 'Weird Name!';
    expect(form.identifierError).toBe('');
  });
});

describe('the guardrails and limits', () => {
  const withLimits = () => {
    const detail = readyAgent();
    if (detail.definition === null) throw new Error('expected a definition');
    return AgentEditorState.edit(
      {
        ...detail,
        definition: {
          ...detail.definition,
          guardrails: ['acme:tripwire', 'acme:pii'],
          stepLimit: 12,
          costBudget: { perRunUsd: 1.5, perChatUsd: 4, warnAt: [0.5, 0.9] },
          toolBudget: { maxCalls: 30, maxDurationSeconds: 90 },
        },
      },
      catalogFixture(),
    );
  };

  test('fills the fields from the file and writes them back, warnAt included', () => {
    const form = withLimits();
    expect(form.guardrails).toBe('acme:tripwire\nacme:pii');
    expect(form.stepLimit).toBe('12');
    expect(form.spendPerRun).toBe('1.5');
    expect(form.toolSeconds).toBe('90');
    expect(form.limitErrors).toEqual({});
    expect(form.toDefinition()).toMatchObject({
      guardrails: ['acme:tripwire', 'acme:pii'],
      stepLimit: 12,
      costBudget: { perRunUsd: 1.5, perChatUsd: 4, warnAt: [0.5, 0.9] },
      toolBudget: { maxCalls: 30, maxDurationSeconds: 90 },
    });
  });

  test('clears a limit by emptying its field, and drops a budget with no limit left in it', () => {
    const form = withLimits();
    form.guardrails = '';
    form.stepLimit = ' ';
    form.spendPerChat = '';
    form.spendPerRun = '';
    form.toolCalls = '';
    form.toolSeconds = '';
    expect(form.toDefinition()).toMatchObject({
      guardrails: null,
      stepLimit: null,
      costBudget: null,
      toolBudget: null,
    });
    form.toolCalls = '5';
    expect(form.toDefinition().toolBudget).toEqual({ maxCalls: 5 });
  });

  test('names each field that holds something the Bureau would refuse, and cannot save', () => {
    const form = withLimits();
    form.guardrails = 'tripwire';
    form.stepLimit = '1001';
    form.spendPerRun = '0';
    form.spendPerChat = '-1';
    form.toolCalls = '2.5';
    form.toolSeconds = 'soon';
    expect(Object.keys(form.limitErrors).toSorted()).toEqual([
      'guardrails',
      'spendPerChat',
      'spendPerRun',
      'stepLimit',
      'toolCalls',
      'toolSeconds',
    ]);
    expect(form.canSave).toBe(false);
  });

  test('refuses a chat limit when there is no run limit under it', () => {
    const form = withLimits();
    form.spendPerRun = '';
    expect(form.limitErrors.spendPerChat).toBe(AGENT_EDITOR_COPY.limits.errors.chatNeedsRun);
    form.spendPerChat = '';
    expect(form.limitErrors).toEqual({});
    expect(form.canSave).toBe(true);
  });
});

describe('the default effort', () => {
  const catalog = catalogFixture({
    models: [
      {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        // Listed out of order: the select offers the tiers from least to most.
        effort: { portable: ['high', 'low', 'medium', 'xhigh'] },
      },
      { provider: 'anthropic', model: 'claude-haiku-5', effort: { portable: ['low', 'medium'] } },
      { provider: 'openai', model: 'gpt-4.1', effort: { portable: [] } },
    ],
  });

  /** An agent whose file writes `defaultEffort` on `model`. */
  function writing(defaultEffort: Effort | null, model: string) {
    const detail = readyAgent();
    if (detail.definition === null) throw new Error('expected a definition');
    detail.definition = { ...detail.definition, model, defaultEffort };
    return AgentEditorState.edit(detail, catalog);
  }

  test('starts as none, offers the tiers the model supports from least to most, and sends nothing', () => {
    const form = AgentEditorState.edit(readyAgent({ id: 'researcher' }), catalogFixture({}));
    expect(form.defaultEffort).toBe('');
    expect('defaultEffort' in form.toDefinition()).toBe(false);

    const sonnet = writing(null, 'anthropic/claude-sonnet-5');
    expect(sonnet.effortChoices).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect('defaultEffort' in sonnet.toDefinition()).toBe(false);
    expect(sonnet.effortError).toBe('');
    expect(sonnet.canSave).toBe(true);
  });

  test('is filled from the file and sent back, and a new agent sends the one that is chosen', () => {
    const form = writing('high', 'anthropic/claude-sonnet-5');
    expect(form.defaultEffort).toBe('high');
    expect(form.toDefinition().defaultEffort).toBe('high');
    expect(form.toTryDefinition().defaultEffort).toBe('high');

    const created = AgentEditorState.create(catalog);
    created.defaultEffort = 'medium';
    expect(created.toDefinition().defaultEffort).toBe('medium');
  });

  test('sends null once the person clears an effort the file had, which removes it', () => {
    const form = writing('high', 'anthropic/claude-sonnet-5');
    form.defaultEffort = '';
    expect(form.toDefinition().defaultEffort).toBeNull();
  });

  test('sends nothing for a new agent that never chose one, even after it chose and cleared', () => {
    const created = AgentEditorState.create(catalog);
    created.defaultEffort = 'low';
    created.defaultEffort = '';
    expect('defaultEffort' in created.toDefinition()).toBe(false);
  });

  test('keeps the effort when the new model supports it, with no notice', () => {
    const form = writing('low', 'anthropic/claude-sonnet-5');
    form.model = 'anthropic/claude-haiku-5';
    expect(form.defaultEffort).toBe('low');
    expect(form.effortNotice).toBe('');
  });

  test('clears an effort the new model does not support, says so, and drops the notice once another is chosen', () => {
    const form = writing('xhigh', 'anthropic/claude-sonnet-5');
    form.model = 'anthropic/claude-haiku-5';
    expect(form.defaultEffort).toBe('');
    expect(form.effortNotice).toBe(
      AGENT_EDITOR_COPY.effort.cleared('Extra high', 'anthropic/claude-haiku-5'),
    );
    expect(form.toDefinition().defaultEffort).toBeNull();
    form.defaultEffort = 'low';
    expect(form.effortNotice).toBe('');
  });

  test('offers none for a model with no effort control, and clears what it cannot do', () => {
    const form = writing('high', 'anthropic/claude-sonnet-5');
    form.model = 'openai/gpt-4.1';
    expect(form.effortChoices).toEqual([]);
    expect(form.defaultEffort).toBe('');
    expect(form.effortNotice).not.toBe('');
  });

  test('forgets a notice when the model changes again', () => {
    const form = writing('xhigh', 'anthropic/claude-sonnet-5');
    form.model = 'anthropic/claude-haiku-5';
    form.model = 'anthropic/claude-sonnet-5';
    expect(form.effortNotice).toBe('');
  });

  test('refuses to save an effort the file’s own model does not support, and saves once another is chosen', () => {
    const form = writing('max', 'anthropic/claude-sonnet-5');
    expect(form.defaultEffort).toBe('max');
    expect(form.effortError).toBe(
      AGENT_EDITOR_COPY.effort.unsupported('Maximum', 'anthropic/claude-sonnet-5'),
    );
    expect(form.canSave).toBe(false);
    expect(form.canTry).toBe(false);
    form.defaultEffort = 'high';
    expect(form.effortError).toBe('');
    expect(form.canSave).toBe(true);
  });

  test('leaves the effort of a model the catalog lacks as the file wrote it', () => {
    const form = writing('low', 'anthropic/retired-model');
    expect(form.effortChoices).toEqual([]);
    expect(form.defaultEffort).toBe('low');
    expect(form.effortError).toBe('');
    form.model = 'anthropic/claude-haiku-5';
    expect(form.defaultEffort).toBe('low');
    form.model = 'anthropic/retired-model';
    expect(form.defaultEffort).toBe('low');
  });
});

describe('the tool approvals the Access tab sets', () => {
  const withApprovals = (approvals: Record<string, 'never' | 'always'> | null) => {
    const detail = readyAgent();
    if (detail.definition === null) throw new Error('expected a definition');
    return AgentEditorState.edit(
      { ...detail, definition: { ...detail.definition, toolApproval: approvals } },
      catalogFixture(),
    );
  };

  test('sends none when the file had none, so an update keeps the file’s value', () => {
    expect('toolApproval' in withApprovals(null).toDefinition()).toBe(false);
  });

  test('writes them back for a tool that is still chosen', () => {
    expect(withApprovals({ 'lookup-order': 'always' }).toDefinition().toolApproval).toEqual({
      'lookup-order': 'always',
    });
  });

  test('drops the approval of a tool the person cleared, which the Bureau would refuse to keep', () => {
    const form = withApprovals({ 'lookup-order': 'always' });
    form.setTool('lookup-order', false);
    expect(form.toDefinition().tools).toEqual([]);
    expect(form.toDefinition().toolApproval).toBeNull();
  });
});

describe('the tools the form shows', () => {
  const catalog = catalogFixture({
    tools: [
      { name: 'a-read', description: 'Reads.', shortDescription: null, tier: null },
      {
        name: 'b-change',
        description: 'Changes.',
        shortDescription: null,
        tier: 'mutating',
        defaultApproval: 'ask',
      },
      { name: 'c-read', description: 'Reads too.', shortDescription: null },
    ],
  });
  const withTools = (
    tools: string[],
    toolApproval: Record<string, 'always' | 'never' | 'blocked'> | null,
  ) => {
    const detail = readyAgent();
    if (detail.definition === null) throw new Error('expected a definition');
    return AgentEditorState.edit(
      { ...detail, definition: { ...detail.definition, tools, toolApproval } },
      catalog,
    );
  };

  test('lists the chosen tools in the catalog’s order, leaving out a tool the catalog dropped', () => {
    const form = withTools(['c-read', 'gone', 'a-read'], null);
    expect(form.chosenTools.map((tool) => tool.name)).toEqual(['a-read', 'c-read']);
    form.setTool('b-change', true);
    expect(form.chosenTools.map((tool) => tool.name)).toEqual(['a-read', 'b-change', 'c-read']);
  });

  test('says what the file states about a tool, and nothing for a name it does not state', () => {
    const form = withTools(['a-read'], { 'a-read': 'always' });
    expect(form.approvalOf('a-read')).toBe('always');
    expect(form.approvalOf('b-change')).toBeUndefined();
    expect(form.approvalOf('constructor')).toBeUndefined();
    expect(AgentEditorState.create(catalog).approvalOf('a-read')).toBeUndefined();
  });

  test('marks a tool that asks first by the file’s word or the tier’s default', () => {
    const form = withTools(['a-read', 'b-change', 'c-read'], {
      'a-read': 'always',
      'c-read': 'blocked',
    });
    const standing = (name: string) =>
      form.standingOf(form.toolChoices.find((tool) => tool.name === name)!);
    expect(standing('a-read')).toBe('asks-first');
    expect(standing('b-change')).toBe('asks-first');
    expect(standing('c-read')).toBe('blocked');
  });

  test('marks a tool with no tier as asking first under never, as the runtime asks', () => {
    const form = withTools(['a-read', 'b-change'], { 'a-read': 'never', 'b-change': 'never' });
    const standing = (name: string) =>
      form.standingOf(form.toolChoices.find((tool) => tool.name === name)!);
    expect(standing('a-read')).toBe('asks-first');
    expect(standing('b-change')).toBe('runs');
  });

  test('keeps the approval of a tool that is cleared and ticked again before the save', () => {
    const form = withTools(['b-change'], { 'b-change': 'never' });
    form.setTool('b-change', false);
    expect(form.toDefinition().toolApproval).toBeNull();
    form.setTool('b-change', true);
    expect(form.toDefinition().toolApproval).toEqual({ 'b-change': 'never' });
    expect(form.standingOf(form.chosenTools[0]!)).toBe('runs');
  });
});
