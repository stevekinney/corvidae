/**
 * The agent editor's form: what it offers from the catalog, how the identifier follows the name,
 * which models and tools a save may name, and what a save sends. A save carries the loaded
 * `skills` through untouched, never carries `published`, and writes an unchanged model back
 * exactly as the file wrote it.
 */
import { describe, expect, test } from 'bun:test';

import { AGENT_EDITOR_COPY } from '../../app/copy.ts';
import { catalogFixture, readyAgent } from '../../lib/bureau-stub.test-support.ts';
import {
  AgentEditorState,
  canonicalModel,
  modelOptions,
  slugify,
} from './agent-editor-state.svelte.ts';

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

describe('the catalog', () => {
  test('offers one option per model, as <provider>/<model>, once, in the catalog’s order', () => {
    const catalog = catalogFixture({
      models: [
        { provider: 'openai', model: 'gpt-4.1', aliases: [] },
        { provider: 'anthropic', model: 'claude-sonnet-5', aliases: [] },
        { provider: 'openai', model: 'gpt-4.1', aliases: [] },
      ],
    });
    expect(modelOptions(catalog)).toEqual([
      { value: 'openai/gpt-4.1', label: 'openai/gpt-4.1' },
      { value: 'anthropic/claude-sonnet-5', label: 'anthropic/claude-sonnet-5' },
    ]);
    expect(modelOptions(catalogFixture({ models: [] }))).toEqual([]);
  });

  test('resolves a model, or an alias of one, to the option it names', () => {
    const catalog = catalogFixture();
    expect(canonicalModel('anthropic/claude-sonnet-5', catalog)).toBe('anthropic/claude-sonnet-5');
    expect(canonicalModel('anthropic/sonnet', catalog)).toBe('anthropic/claude-sonnet-5');
  });

  test('resolves nothing for a model the catalog does not offer', () => {
    const catalog = catalogFixture();
    expect(canonicalModel('openai/gpt-4.1', catalog)).toBe('');
    expect(canonicalModel('anthropic/unknown', catalog)).toBe('');
    expect(canonicalModel('sonnet', catalog)).toBe('');
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

  test('sends its fields, no skills of its own, and no published key', () => {
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
      skills: [],
      instructions: 'Cite everything.',
    });
    expect(Object.keys(form.toDefinition())).not.toContain('published');
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
    expect(form.published).toBe(false);
    expect(form.canSave).toBe(true);
  });

  test('keeps a key of a skill this page does not know, and writes it back unchanged', () => {
    const detail = readyAgent();
    const skill = { id: 'cite', name: 'Cite', description: 'Cites', tags: [], futureKey: { a: 1 } };
    const form = AgentEditorState.edit(
      { ...detail, definition: detail.definition && { ...detail.definition, skills: [skill] } },
      catalogFixture(),
    );
    expect(form.toDefinition().skills).toEqual([skill]);
  });

  test('carries the loaded skills through a save unchanged, and writes an unchanged alias back as written', () => {
    const detail = readyAgent();
    const form = AgentEditorState.edit(detail, catalogFixture());
    form.instructions = 'Changed.';
    const sent = form.toDefinition();
    expect(sent.skills).toEqual(detail.definition?.skills ?? []);
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

  test('has nothing chosen when the file’s model is not one the catalog offers, and will not save', () => {
    const detail = readyAgent();
    const form = AgentEditorState.edit(
      {
        ...detail,
        definition: detail.definition && { ...detail.definition, model: 'openai/gpt-4.1' },
      },
      catalogFixture(),
    );
    expect(form.model).toBe('');
    expect(form.canSave).toBe(false);
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

  test('takes the new hash, and the new publication, after a write', () => {
    const form = AgentEditorState.edit(readyAgent(), catalogFixture());
    form.adopt({ hash: 'hash-2' }, true);
    expect(form.hash).toBe('hash-2');
    expect(form.published).toBe(true);
    form.adopt({ hash: 'hash-3' });
    expect(form.hash).toBe('hash-3');
    expect(form.published).toBe(true);
  });

  test('has no identifier error, whatever the name', () => {
    const form = AgentEditorState.edit(readyAgent(), catalogFixture());
    form.name = 'Weird Name!';
    expect(form.identifierError).toBe('');
  });
});
