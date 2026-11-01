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
});
