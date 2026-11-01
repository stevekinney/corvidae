/**
 * The fields of a contributed kind's configuration (COR-1893): drawn from the JSON Schema the Bureau
 * reports, reporting each committed edit, and saying so when the kind has no fields or its schema
 * cannot be drawn.
 */
import { quietFor } from '@lostgradient/testing/wait-until';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { PLUGIN_KINDS_COPY } from '../app/copy.ts';
import ContributedConfigurationForm from './contributed-configuration-form.svelte';

afterEach(cleanup);

const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    mailbox: { type: 'string' },
    limit: { type: 'integer' },
  },
};

describe('the form of a contributed kind', () => {
  test('reports the configuration after each edit, without the dialect marker in its way', async () => {
    const received: Array<Record<string, unknown>> = [];
    const { getByLabelText } = render(ContributedConfigurationForm, {
      props: { kindId: 'inbox:message', schema: SCHEMA, onChange: (next) => received.push(next) },
    });
    await fireEvent.input(getByLabelText(/mailbox/i), { target: { value: 'support' } });
    await waitFor(() => expect(received.at(-1)).toMatchObject({ mailbox: 'support' }));
  });

  test('holds back a number that is still being typed', async () => {
    const received: Array<Record<string, unknown>> = [];
    const { container, getByLabelText } = render(ContributedConfigurationForm, {
      props: { kindId: 'inbox:message', schema: SCHEMA, onChange: (next) => received.push(next) },
    });
    await fireEvent.input(getByLabelText(/mailbox/i), { target: { value: 'a' } });
    await waitFor(() => expect(received.length).toBeGreaterThan(0));
    const reported = received.length;

    const limit = container.querySelector<HTMLInputElement>('input[inputmode="decimal"]');
    if (limit === null) throw new Error('The number field is missing.');
    await fireEvent.input(limit, { target: { value: '1e' } });
    await quietFor(100);
    expect(received).toHaveLength(reported);
    expect(received.every((value) => typeof value['limit'] !== 'string')).toBe(true);
  });

  test('says so when the kind takes no settings', () => {
    const { getByText } = render(ContributedConfigurationForm, {
      props: {
        kindId: 'inbox:message',
        schema: { type: 'object', properties: {} },
        onChange: () => undefined,
      },
    });
    expect(getByText(PLUGIN_KINDS_COPY.noFields)).toBeTruthy();
  });

  test('says so when the schema could not be written as JSON Schema', () => {
    const { getByText } = render(ContributedConfigurationForm, {
      props: { kindId: 'inbox:message', schema: null, onChange: () => undefined },
    });
    expect(getByText(PLUGIN_KINDS_COPY.fieldsUnavailable)).toBeTruthy();
  });

  test('reports the displayed value of an untouched choice, so what is saved is what is shown', async () => {
    const received: Array<Record<string, unknown>> = [];
    render(ContributedConfigurationForm, {
      props: {
        kindId: 'pager:page',
        schema: {
          type: 'object',
          properties: { urgency: { enum: ['low', 'high'] }, loud: { type: 'boolean' } },
          required: ['urgency', 'loud'],
        },
        onChange: (next) => received.push(next),
      },
    });
    await waitFor(() => expect(received.at(-1)).toEqual({ urgency: 'low', loud: false }));
  });

  test('does not report a configuration that already holds what the form shows, so opening it is not an edit', async () => {
    const received: Array<Record<string, unknown>> = [];
    const { getByLabelText } = render(ContributedConfigurationForm, {
      props: {
        kindId: 'pager:page',
        schema: {
          type: 'object',
          properties: { urgency: { enum: ['low', 'high'] } },
          required: ['urgency'],
        },
        value: { urgency: 'high' },
        onChange: (next) => received.push(next),
      },
    });
    expect((getByLabelText(/urgency/i) as HTMLSelectElement).value).toBe('"high"');
    await quietFor(100);
    expect(received).toEqual([]);
  });

  test('fills in what a held configuration lacks with what the form shows', async () => {
    const received: Array<Record<string, unknown>> = [];
    render(ContributedConfigurationForm, {
      props: {
        kindId: 'pager:page',
        schema: {
          type: 'object',
          properties: { urgency: { enum: ['low', 'high'] }, loud: { type: 'boolean' } },
          required: ['urgency', 'loud'],
        },
        value: { urgency: 'high' },
        onChange: (next) => received.push(next),
      },
    });
    await waitFor(() => expect(received.at(-1)).toEqual({ urgency: 'high', loud: false }));
  });

  test('draws the record editor for a kind whose settings are free keys, and reports its entries', async () => {
    const received: Array<Record<string, unknown>> = [];
    const { getByRole, queryByText } = render(ContributedConfigurationForm, {
      props: {
        kindId: 'pager:page',
        schema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          propertyNames: { type: 'string' },
          additionalProperties: { type: 'string' },
        },
        onChange: (next) => received.push(next),
      },
    });
    expect(queryByText(PLUGIN_KINDS_COPY.noFields)).toBeNull();
    await fireEvent.click(getByRole('button', { name: /^Add .* entry$/ }));
    const key = await waitFor(() => getByRole('textbox', { name: /key/i }));
    await fireEvent.input(key, { target: { value: 'region' } });
    const entry = getByRole('textbox', { name: /value/i });
    await fireEvent.input(entry, { target: { value: 'eu' } });
    await waitFor(() => expect(received.at(-1)).toEqual({ region: 'eu' }));
  });

  test('still says a kind takes no settings when its object is closed and empty', () => {
    const { getByText } = render(ContributedConfigurationForm, {
      props: {
        kindId: 'inbox:message',
        schema: { type: 'object', properties: {}, additionalProperties: false },
        onChange: () => undefined,
      },
    });
    expect(getByText(PLUGIN_KINDS_COPY.noFields)).toBeTruthy();
  });
});
