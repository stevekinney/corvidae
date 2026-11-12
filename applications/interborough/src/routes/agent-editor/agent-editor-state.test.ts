/**
 * The agent editor's form: what it offers from the catalog, how the identifier follows the name,
 * which models and tools a save may name, and what a save sends. A save carries the loaded
 * `card` through untouched, sends its A2A opt-in, and writes an unchanged model back
 * exactly as the file wrote it.
 */
import { describe, expect, test } from 'bun:test';

import { AGENT_EDITOR_COPY } from '../../app/copy/agents.ts';
import type { Effort } from '../../lib/agent-definitions.ts';
import { catalogFixture, readyAgent } from '../../lib/bureau-stub.test-support.ts';
import { restrictionsOf } from './agent-editor-models.ts';
import { AgentEditorState, FIELD_IDS, slugify, wordCount } from './agent-editor-state.svelte.ts';

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
    expect(form.identifierError).toBe(AGENT_EDITOR_COPY.identifierTaken('assistant'));
    form.identifier = 'assistant-2';
    expect(form.identifierError).toBe('');
    form.identifier = 'assistant';
    form.markIdentifierTaken('agent-file-exists');
    expect(form.identifierError).toBe(AGENT_EDITOR_COPY.identifierTaken('assistant'));
  });

  test('says a taken identifier the name set at the name, in the name’s words (rows 42n, 14u)', () => {
    const form = AgentEditorState.create(catalogFixture());
    form.name = 'Tool runner';
    form.markIdentifierTaken('shadows-code-agent');
    expect(form.identifierFollowsName).toBe(true);
    expect(form.nameError).toBe(AGENT_EDITOR_COPY.newAgent.nameTaken('Tool runner'));
    // The refusal answers a submit, so it shows before any other message does.
    expect(form.shownErrors).toEqual({
      name: AGENT_EDITOR_COPY.newAgent.nameTaken('Tool runner'),
      identifier: '',
      model: '',
    });
    form.name = 'Tool runner 2';
    expect(form.nameError).toBe('');
  });
});

describe('a new agent’s submit', () => {
  test('shows nothing at the fields until a submit, then why each stops a save (rows 42m, W35)', () => {
    const form = AgentEditorState.create(catalogFixture({ models: [] }));
    expect(form.shownErrors).toEqual({ name: '', identifier: '', model: '' });
    form.attempt();
    expect(form.shownErrors).toEqual({
      name: AGENT_EDITOR_COPY.newAgent.nameRequired,
      identifier: '',
      model: AGENT_EDITOR_COPY.newAgent.modelRequired,
    });
    expect(form.firstProblem).toBe(FIELD_IDS.name);
    form.name = 'Researcher';
    expect(form.firstProblem).toBe(FIELD_IDS.model);
  });

  test('says at the name when it holds nothing an identifier can be made of', () => {
    const form = AgentEditorState.create(catalogFixture());
    form.name = '日本語';
    expect(form.nameError).toBe(AGENT_EDITOR_COPY.newAgent.nameNeedsLetters);
    expect(form.canSave).toBe(false);
  });

  test('turns the identifier into a field on Change and back on Reset (row 42x)', () => {
    const form = AgentEditorState.create(catalogFixture());
    form.name = 'Order Helper';
    expect(form.identifierFollowsName).toBe(true);
    form.changeIdentifier();
    expect(form.identifierFollowsName).toBe(false);
    expect(form.identifier).toBe('order-helper');
    form.identifier = 'Order Helper!';
    form.attempt();
    expect(form.shownErrors.identifier).toBe(AGENT_EDITOR_COPY.identifierInvalid);
    expect(form.shownErrors.name).toBe('');
    expect(form.firstProblem).toBe(FIELD_IDS.identifier);
    expect(form.suggestedIdentifier).toBe('order-helper');
    form.resetIdentifier();
    expect(form.identifierFollowsName).toBe(true);
    expect(form.identifier).toBe('order-helper');
    expect(form.firstProblem).toBeUndefined();
  });

  test('focuses the Model field for a model the Bureau will refuse, and still lets the save go (row 43s)', () => {
    const detail = readyAgent();
    if (detail.definition === null) throw new Error('expected a definition');
    // A copy is a new agent's form, which has the Model field; a saved agent's model is read-only.
    const form = AgentEditorState.copy(
      { ...detail.definition, model: 'anthropic/claude-haiku-5' },
      'researcher-copy',
      catalogFixture(),
      {
        restrictions: restrictionsOf({
          deployment: { deniedModels: ['claude-haiku-5'] },
          policyRevision: 1,
        }),
      },
    );
    expect(form.modelRefused).toBe(true);
    expect(form.canSave).toBe(true);
    expect(form.firstProblem).toBe(FIELD_IDS.model);
  });

  test('has only a saved agent’s name to stop a save: its model, effort and limits are read-only lines the Bureau judges', () => {
    const detail = readyAgent();
    if (detail.definition === null) throw new Error('expected a definition');
    const form = AgentEditorState.edit(
      { ...detail, definition: { ...detail.definition, model: 'anthropic/claude-haiku-5' } },
      catalogFixture(),
      {
        restrictions: restrictionsOf({
          deployment: { deniedModels: ['claude-haiku-5'] },
          policyRevision: 1,
        }),
      },
    );
    expect(form.modelRefused).toBe(true);
    expect(form.canSave).toBe(true);
    // No field on the form has that id, so a submit has nothing to focus.
    expect(form.firstProblem).toBeUndefined();
  });
});

describe('a saved agent’s name (row 41s)', () => {
  test('is required: an emptied name stops a save, and is said at the field once a submit was tried', () => {
    const form = AgentEditorState.edit(readyAgent(), catalogFixture());
    expect(form.nameError).toBe('');
    form.name = '   ';
    expect(form.nameError).toBe(AGENT_EDITOR_COPY.edit.nameRequired);
    expect(form.canSave).toBe(false);
    expect(form.firstProblem).toBe(FIELD_IDS.name);
    // Nothing is said until a submit.
    expect(form.shownErrors.name).toBe('');
    form.attempt();
    expect(form.shownErrors.name).toBe(AGENT_EDITOR_COPY.edit.nameRequired);
    form.name = 'Researcher again';
    expect(form.nameError).toBe('');
    expect(form.canSave).toBe(true);
    expect(form.firstProblem).toBeUndefined();
  });
});

describe('the reference documents of a saved agent (row 41t)', () => {
  const documents = ['references/refund-policy.md', 'references/shipping-zones.pdf'];
  const withDocuments = (mode: 'edit' | 'copy' = 'edit') => {
    const detail = readyAgent();
    if (detail.definition === null) throw new Error('expected a definition');
    const definition = { ...detail.definition, references: documents };
    return mode === 'edit'
      ? AgentEditorState.edit({ ...detail, definition }, catalogFixture())
      : AgentEditorState.copy(definition, 'researcher-copy', catalogFixture());
  };

  test('are the file’s, and a save that removes none leaves them to the file', () => {
    const form = withDocuments();
    expect(form.referencesKept).toEqual(documents);
    expect('references' in form.toDefinition()).toBe(false);
    expect(form.changed).toBe(false);
  });

  test('lose a removed document with the next save, and the leave question names the section', () => {
    const form = withDocuments();
    form.removeReference('references/refund-policy.md');
    expect(form.referencesKept).toEqual(['references/shipping-zones.pdf']);
    expect(form.toDefinition().references).toEqual(['references/shipping-zones.pdf']);
    expect(form.changedParts).toEqual([AGENT_EDITOR_COPY.edit.references.heading]);
    // A trial runs without documents whatever the form holds.
    expect('references' in form.toTryDefinition()).toBe(false);
  });

  test('are sent as null once every one is removed, which removes the list', () => {
    const form = withDocuments();
    for (const path of documents) form.removeReference(path);
    expect(form.referencesKept).toEqual([]);
    expect(form.toDefinition().references).toBeNull();
  });

  test('ignore a path the file does not list and a path removed twice', () => {
    const form = withDocuments();
    form.removeReference('references/not-there.md');
    expect(form.referencesKept).toEqual(documents);
    expect(form.changed).toBe(false);
    form.removeReference('references/refund-policy.md');
    form.removeReference('references/refund-policy.md');
    expect(form.referencesKept).toEqual(['references/shipping-zones.pdf']);
  });

  test('are not removed from a copy, which is created with the original’s documents whole', () => {
    const form = withDocuments('copy');
    form.removeReference('references/refund-policy.md');
    expect(form.referencesKept).toEqual(documents);
    expect(form.toDefinition().references).toEqual(documents);
  });
});

describe('the guardrails line of a saved agent’s form (row 41w)', () => {
  test('are the ids the file lists, a configured one by its id', () => {
    const detail = readyAgent();
    if (detail.definition === null) throw new Error('expected a definition');
    const form = AgentEditorState.edit(
      {
        ...detail,
        definition: {
          ...detail.definition,
          guardrails: ['acme:pii', { id: 'acme:refund-cap', configuration: { cap: 50 } }],
        },
      },
      catalogFixture(),
    );
    expect(form.guardrailIds).toEqual(['acme:pii', 'acme:refund-cap']);
    expect(AgentEditorState.edit(readyAgent(), catalogFixture()).guardrailIds).toEqual([]);
  });
});

describe('what the leave question names (rows 42o, 42p)', () => {
  test('names nothing for a form as it was built, and each part that changed, in the form’s order', () => {
    const form = AgentEditorState.create(catalogFixture());
    expect(form.changed).toBe(false);
    form.setTool('lookup-order', true);
    form.instructions = 'Answer order questions.';
    expect(form.changedParts).toEqual([
      AGENT_EDITOR_COPY.sections.instructions,
      AGENT_EDITOR_COPY.sections.tools,
    ]);
    form.instructions = '';
    form.setTool('lookup-order', false);
    expect(form.changed).toBe(false);
  });

  test('measures a copy from the copy as it was filled, not from an empty form', () => {
    const detail = readyAgent();
    if (detail.definition === null) throw new Error('expected a definition');
    const form = AgentEditorState.copy(detail.definition, 'researcher-copy', catalogFixture());
    expect(form.changed).toBe(false);
    form.identifier = 'researcher-2';
    expect(form.changedParts).toEqual([AGENT_EDITOR_COPY.identifierLabel]);
  });
});

describe('a new agent built before its catalog loaded (row 42v)', () => {
  test('offers nothing, and keeps what was typed when the catalog arrives', () => {
    const form = AgentEditorState.withoutCatalog();
    expect(form.catalogMissing).toBe(true);
    expect(form.hasModels).toBe(false);
    expect(form.toolChoices).toEqual([]);
    form.name = 'Order helper';
    form.description = 'Answers order questions';
    form.instructions = 'Be brief.';

    const next = form.withCatalog(catalogFixture());
    expect(next.catalogMissing).toBe(false);
    expect(next.name).toBe('Order helper');
    expect(next.description).toBe('Answers order questions');
    expect(next.instructions).toBe('Be brief.');
    expect(next.model).toBe('anthropic/claude-sonnet-5');
    // What changed is still measured from the empty form.
    expect(next.changedParts).toContain(AGENT_EDITOR_COPY.nameLabel);
  });
});

describe('the Asks level a new agent sets (row 41l)', () => {
  test('writes only a level that differs from the tool’s default', () => {
    const form = AgentEditorState.create(catalogFixture());
    form.name = 'Order helper';
    form.setTool('lookup-order', true);
    form.setApproval('lookup-order', 'never', 'never');
    expect('approvals' in form.toDefinition()).toBe(false);
    form.setApproval('lookup-order', 'always', 'never');
    expect(form.approvalOf('lookup-order')).toBe('always');
    expect(form.toDefinition().approvals).toEqual({ 'lookup-order': 'always' });
    form.setApproval('lookup-order', 'never', 'never');
    expect(form.approvalOf('lookup-order')).toBeUndefined();
    expect('approvals' in form.toDefinition()).toBe(false);
  });
});

describe('wordCount', () => {
  test('counts the words of Markdown, headings and backticks included (row 41i)', () => {
    expect(wordCount('')).toBe(0);
    expect(wordCount('## Role\n\nLook up orders with `lookup-order`.')).toBe(7);
  });
});

describe('a new agent’s definition', () => {
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
      card: [],
      a2a: false,
      // A limit left empty is `null`, which removes it from a file that had one.
      guardrails: null,
      limits: { steps: null, cost: null, tools: null },
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

  test('preserves child-agent grants through an edit definition', () => {
    const form = AgentEditorState.edit(
      readyAgent({ definition: { ...readyAgent().definition!, children: ['researcher'] } }),
      catalogFixture(),
    );
    expect(form.toDefinition().children).toEqual(['researcher']);
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
        definition: detail.definition && { ...detail.definition, card: [skill] },
      },
      catalogFixture(),
    );
    expect(form.toDefinition().card).toEqual([skill]);
  });

  test('carries the loaded skills through a save unchanged, and writes an unchanged alias back as written', () => {
    const detail = readyAgent();
    const form = AgentEditorState.edit(detail, catalogFixture());
    form.instructions = 'Changed.';
    const sent = form.toDefinition();
    expect(sent.card).toEqual(detail.definition?.card ?? []);
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
          limits: {
            steps: 12,
            cost: { run: 1.5, chat: 4, warn: [0.5, 0.9] },
            tools: { calls: 30, seconds: 90 },
          },
        },
      },
      catalogFixture(),
    );
  };

  test('fills the fields from the file and writes them back, warn included', () => {
    const form = withLimits();
    expect(form.guardrails).toBe('acme:tripwire\nacme:pii');
    expect(form.stepLimit).toBe('12');
    expect(form.spendPerRun).toBe('1.5');
    expect(form.toolSeconds).toBe('90');
    expect(form.limitErrors).toEqual({});
    expect(form.toDefinition()).toMatchObject({
      guardrails: ['acme:tripwire', 'acme:pii'],
      limits: {
        steps: 12,
        cost: { run: 1.5, chat: 4, warn: [0.5, 0.9] },
        tools: { calls: 30, seconds: 90 },
      },
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
      limits: { steps: null, cost: null, tools: null },
    });
    form.toolCalls = '5';
    expect(form.toDefinition().limits?.tools).toEqual({ calls: 5 });
  });

  test('names each field that holds something the Bureau would refuse, and cannot try them (a saved agent’s form shows no field for them, so a save goes to the Bureau)', () => {
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
    expect(form.canTry).toBe(false);
    expect(form.canSave).toBe(true);
  });

  // COR-2118 — the field edits ids; a guardrail the file configures keeps its configuration.
  test('shows a configured guardrail by its id and saves its configuration back', () => {
    const detail = readyAgent();
    if (detail.definition === null) throw new Error('expected a definition');
    const configured = { id: 'acme:grounding', configuration: { threshold: 0.95 } };
    const form = AgentEditorState.edit(
      { ...detail, definition: { ...detail.definition, guardrails: ['acme:pii', configured] } },
      catalogFixture(),
    );
    expect(form.guardrails).toBe('acme:pii\nacme:grounding');
    expect(form.toDefinition().guardrails).toEqual(['acme:pii', configured]);

    form.guardrails = 'acme:grounding\nacme:tripwire';
    expect(form.toDefinition().guardrails).toEqual([configured, 'acme:tripwire']);
    form.guardrails = 'acme:tripwire';
    expect(form.toDefinition().guardrails).toEqual(['acme:tripwire']);
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

  /** An agent whose file writes `effort` on `model`. */
  function writing(effort: Effort | null, model: string) {
    const detail = readyAgent();
    if (detail.definition === null) throw new Error('expected a definition');
    detail.definition = { ...detail.definition, model, effort };
    return AgentEditorState.edit(detail, catalog);
  }

  test('starts as none, offers the tiers the model supports from least to most, and sends nothing', () => {
    const form = AgentEditorState.edit(readyAgent({ id: 'researcher' }), catalogFixture({}));
    expect(form.effort).toBe('');
    expect('effort' in form.toDefinition()).toBe(false);

    const sonnet = writing(null, 'anthropic/claude-sonnet-5');
    expect(sonnet.effortChoices).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect('effort' in sonnet.toDefinition()).toBe(false);
    expect(sonnet.effortError).toBe('');
    expect(sonnet.canSave).toBe(true);
  });

  test('is filled from the file and sent back, and a new agent sends the one that is chosen', () => {
    const form = writing('high', 'anthropic/claude-sonnet-5');
    expect(form.effort).toBe('high');
    expect(form.toDefinition().effort).toBe('high');
    expect(form.toTryDefinition().effort).toBe('high');

    const created = AgentEditorState.create(catalog);
    created.effort = 'medium';
    expect(created.toDefinition().effort).toBe('medium');
  });

  test('sends null once the person clears an effort the file had, which removes it', () => {
    const form = writing('high', 'anthropic/claude-sonnet-5');
    form.effort = '';
    expect(form.toDefinition().effort).toBeNull();
  });

  test('sends nothing for a new agent that never chose one, even after it chose and cleared', () => {
    const created = AgentEditorState.create(catalog);
    created.effort = 'low';
    created.effort = '';
    expect('effort' in created.toDefinition()).toBe(false);
  });

  test('keeps the effort when the new model supports it, with no notice', () => {
    const form = writing('low', 'anthropic/claude-sonnet-5');
    form.model = 'anthropic/claude-haiku-5';
    expect(form.effort).toBe('low');
    expect(form.effortNotice).toBe('');
  });

  test('clears an effort the new model does not support, says so, and drops the notice once another is chosen', () => {
    const form = writing('xhigh', 'anthropic/claude-sonnet-5');
    form.model = 'anthropic/claude-haiku-5';
    expect(form.effort).toBe('');
    expect(form.effortNotice).toBe(
      AGENT_EDITOR_COPY.effort.cleared('Extra high', 'anthropic/claude-haiku-5'),
    );
    expect(form.toDefinition().effort).toBeNull();
    form.effort = 'low';
    expect(form.effortNotice).toBe('');
  });

  test('offers none for a model with no effort control, and clears what it cannot do', () => {
    const form = writing('high', 'anthropic/claude-sonnet-5');
    form.model = 'openai/gpt-4.1';
    expect(form.effortChoices).toEqual([]);
    expect(form.effort).toBe('');
    expect(form.effortNotice).not.toBe('');
  });

  test('forgets a notice when the model changes again', () => {
    const form = writing('xhigh', 'anthropic/claude-sonnet-5');
    form.model = 'anthropic/claude-haiku-5';
    form.model = 'anthropic/claude-sonnet-5';
    expect(form.effortNotice).toBe('');
  });

  test('refuses to save an effort the model of a new agent’s form does not support, and saves once another is chosen', () => {
    const detail = readyAgent();
    if (detail.definition === null) throw new Error('expected a definition');
    // A copy is a new agent's form, whose effort field is on the page.
    const form = AgentEditorState.copy(
      { ...detail.definition, model: 'anthropic/claude-sonnet-5', effort: 'max' },
      'researcher-copy',
      catalog,
    );
    expect(form.effort).toBe('max');
    expect(form.effortError).toBe(
      AGENT_EDITOR_COPY.effort.unsupported('Maximum', 'anthropic/claude-sonnet-5'),
    );
    expect(form.canSave).toBe(false);
    expect(form.canTry).toBe(false);
    form.effort = 'high';
    expect(form.effortError).toBe('');
    expect(form.canSave).toBe(true);
  });

  test('leaves a saved agent’s effort the Bureau to judge: its form shows no field for it', () => {
    const form = writing('max', 'anthropic/claude-sonnet-5');
    expect(form.effortError).not.toBe('');
    expect(form.canSave).toBe(true);
    expect(form.canTry).toBe(false);
    expect(form.firstProblem).toBeUndefined();
    expect(form.toDefinition().effort).toBe('max');
  });

  test('leaves the effort of a model the catalog lacks as the file wrote it', () => {
    const form = writing('low', 'anthropic/retired-model');
    expect(form.effortChoices).toEqual([]);
    expect(form.effort).toBe('low');
    expect(form.effortError).toBe('');
    form.model = 'anthropic/claude-haiku-5';
    expect(form.effort).toBe('low');
    form.model = 'anthropic/retired-model';
    expect(form.effort).toBe('low');
  });
});

describe('the tool approvals the Access tab sets', () => {
  const withApprovals = (approvals: Record<string, 'never' | 'always'> | null) => {
    const detail = readyAgent();
    if (detail.definition === null) throw new Error('expected a definition');
    return AgentEditorState.edit(
      { ...detail, definition: { ...detail.definition, approvals: approvals } },
      catalogFixture(),
    );
  };

  test('sends none when the file had none, so an update keeps the file’s value', () => {
    expect('approvals' in withApprovals(null).toDefinition()).toBe(false);
  });

  test('writes them back for a tool that is still chosen', () => {
    expect(withApprovals({ 'lookup-order': 'always' }).toDefinition().approvals).toEqual({
      'lookup-order': 'always',
    });
  });

  test('drops the approval of a tool the person cleared, which the Bureau would refuse to keep', () => {
    const form = withApprovals({ 'lookup-order': 'always' });
    form.setTool('lookup-order', false);
    expect(form.toDefinition().tools).toEqual([]);
    expect(form.toDefinition().approvals).toBeNull();
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
    approvals: Record<string, 'always' | 'never' | 'blocked'> | null,
  ) => {
    const detail = readyAgent();
    if (detail.definition === null) throw new Error('expected a definition');
    return AgentEditorState.edit(
      { ...detail, definition: { ...detail.definition, tools, approvals } },
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
    expect(form.toDefinition().approvals).toBeNull();
    form.setTool('b-change', true);
    expect(form.toDefinition().approvals).toEqual({ 'b-change': 'never' });
    expect(form.standingOf(form.chosenTools[0]!)).toBe('runs');
  });
});
