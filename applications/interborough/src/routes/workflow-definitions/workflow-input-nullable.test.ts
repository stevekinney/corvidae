/**
 * The input of a workflow whose optional fields are `.nullable().optional()`, as Zod writes them
 * (COR-2774): the form starts every such field as `null`, which the schema accepts, so the run can
 * start without filling in what is optional, and a person can set a field back to `null`.
 */
import { schemaFormInitialDraft } from '@lostgradient/cinder';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { firstMissingField, formSchemaOf } from './run-setup-model.ts';
import WorkflowInput from './workflow-input.svelte';

afterEach(cleanup);

const PROBE = {
  type: 'object',
  properties: {
    label: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
    flag: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
    opts: {
      anyOf: [
        {
          type: 'object',
          properties: { a: { type: 'string', minLength: 1 } },
          required: ['a'],
        },
        { type: 'null' },
      ],
    },
  },
};

type Handle = { request: (context: string) => void };

function mount(schema: unknown) {
  const received: unknown[] = [];
  const view = render(WorkflowInput<string>, {
    props: { schema, onInput: (input: unknown) => void received.push(input) },
  });
  return { ...view, received, input: view.component as unknown as Handle };
}

describe('the run setup input with nullable optional fields', () => {
  test('starts every one of them as null, as it did before the form drew them', () => {
    const schema = formSchemaOf(PROBE);
    if (schema === undefined) throw new Error('The form has no schema.');
    expect(schemaFormInitialDraft(schema)).toEqual({ label: null, flag: null, opts: null });
  });

  test('starts a run with nothing filled in, sending null for each', async () => {
    const { input, received } = mount(PROBE);
    input.request('start');
    await waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toEqual({ label: null, flag: null, opts: null });
  });

  test('draws a yes or no, a group and a list with controls of their own, and no code editor', async () => {
    const schema = {
      ...PROBE,
      properties: {
        ...PROBE.properties,
        tags: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
      },
    };
    const { container, getAllByRole, getByRole } = mount(schema);
    expect(container.querySelector('.cinder-json-editor')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
    // Flag is Not set, Yes, No; Options is Not set and Set; each starts on Not set.
    expect(getAllByRole('radio', { name: 'Not set' })).toHaveLength(2);
    expect(getByRole('radio', { name: 'Yes' })).toBeTruthy();
    expect(getByRole('radio', { name: 'Set' })).toBeTruthy();
    expect(container.textContent).toContain('Not set');
  });

  test('sends what a yes or no and a group are set to, and null again when they are not set', async () => {
    const { input, received, getByRole, getAllByRole } = mount(PROBE);
    await fireEvent.click(getByRole('radio', { name: 'Yes' }));
    await fireEvent.click(getByRole('radio', { name: 'Set' }));
    await fireEvent.input(getByRole('textbox', { name: /^A/ }), { target: { value: 'x' } });
    input.request('start');
    await waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toEqual({ label: null, flag: true, opts: { a: 'x' } });

    const [flagNotSet, groupNotSet] = getAllByRole('radio', { name: 'Not set' });
    await fireEvent.click(flagNotSet!);
    await fireEvent.click(groupNotSet!);
    input.request('start');
    await waitFor(() => expect(received).toHaveLength(2));
    expect(received[1]).toEqual({ label: null, flag: null, opts: null });
  });

  test('sets a text field back to null when its text is cleared', async () => {
    const { input, received, getByRole } = mount(PROBE);
    const label = getByRole('textbox', { name: /label/i });
    await fireEvent.input(label, { target: { value: 'weekly' } });
    await fireEvent.input(label, { target: { value: '' } });
    input.request('start');
    await waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({ label: null });
  });

  test('does not call a required field missing for being null when its schema allows null', async () => {
    const schema = {
      type: 'object',
      properties: {
        count: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
        name: { type: 'string' },
      },
      required: ['count', 'name'],
    };
    expect(firstMissingField(schema, { count: null, name: 'x' })).toBeUndefined();
    expect(firstMissingField(schema, { count: null, name: '' })?.key).toBe('name');
    const { input, received } = mount({
      type: 'object',
      properties: { count: schema.properties.count },
      required: ['count'],
    });
    input.request('start');
    await waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toEqual({ count: null });
  });
});
