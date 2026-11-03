/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, fireEvent, render } = await import('@testing-library/svelte');
const { default: SchemaView } = await import('./schema-view.svelte');
const { longValuesSchema, notifySchema, searchToolSchema, workflowSchema } =
  await import('./schema-view-test-support.ts');

afterEach(() => cleanup());

const refundSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['orderId', 'customer'],
  properties: {
    orderId: { type: 'string', description: 'The order to refund.' },
    refundAmount: { type: 'number' },
    customer: {
      type: 'object',
      required: ['email'],
      properties: {
        email: { type: 'string', description: 'Where the receipt goes.' },
        loyaltyTier: { type: 'string' },
      },
    },
  },
};

/** The rows of the grid, each as its label, its type, and whether it carries the required dot. */
function readRows(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll('[role="row"]:not(.cinder-schema-view__row--header)'),
  ).map((row) => ({
    label: row.querySelector('.cinder-schema-view__label')?.textContent,
    type: row.querySelector('.cinder-schema-view__type')?.textContent,
    required: row.querySelector('[role="img"][aria-label="Required"]') !== null,
    description: row.querySelector('.cinder-schema-view__description')?.textContent ?? '',
    depth: row.getAttribute('data-cinder-depth'),
    startsOptional: row.hasAttribute('data-cinder-group-start'),
  }));
}

describe('SchemaView', () => {
  test('renders Field, Type and Description as one table with a header row', () => {
    const { container, getByRole, getAllByRole } = render(SchemaView, {
      schema: refundSchema,
      label: 'Refund input',
    });

    // The region is named for what the schema describes, and holds one table.
    expect(getByRole('region', { name: 'Refund input' })).not.toBeNull();
    expect(getByRole('table', { name: 'Refund input' })).not.toBeNull();
    expect(getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'Field',
      'Type',
      'Description',
    ]);
    // Every row has the three cells the header names.
    const rows = Array.from(
      container.querySelectorAll('[role="row"]:not(.cinder-schema-view__row--header)'),
    );
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.querySelectorAll('[role="rowheader"], [role="cell"]')).toHaveLength(3);
    }
  });

  test('lists required fields first, marks them with a dot, and indents nested fields', () => {
    const { container } = render(SchemaView, { schema: refundSchema });
    expect(readRows(container)).toEqual([
      {
        label: 'Order ID',
        type: 'text',
        required: true,
        description: 'The order to refund.',
        depth: '0',
        startsOptional: false,
      },
      {
        label: 'Customer',
        type: 'group of fields',
        required: true,
        description: '',
        depth: '0',
        startsOptional: false,
      },
      {
        label: 'Email',
        type: 'text',
        required: true,
        description: 'Where the receipt goes.',
        depth: '1',
        startsOptional: false,
      },
      {
        label: 'Loyalty tier',
        type: 'text',
        required: false,
        description: '',
        depth: '1',
        startsOptional: false,
      },
      {
        label: 'Refund amount',
        type: 'number',
        required: false,
        description: '',
        depth: '0',
        startsOptional: true,
      },
    ]);
  });

  test('never writes the word required in a row: the dot is the mark', () => {
    const { container } = render(SchemaView, { schema: workflowSchema });
    const dots = container.querySelectorAll('[role="img"]');
    for (const dot of Array.from(dots)) expect(dot.textContent).toBe('');
    const visible = Array.from(container.querySelectorAll('[role="row"]'))
      .map((row) => row.textContent)
      .join(' ');
    // The ID description says "Required when there is no title"; no row adds the word itself.
    expect(visible.match(/required/gi)).toHaveLength(1);
  });

  test('puts a single hairline between the required rows and the rest, with nested rows carrying dots', () => {
    const { container } = render(SchemaView, { schema: workflowSchema });
    const rows = readRows(container);
    expect(rows.map((row) => row.label)).toEqual([
      'Steps',
      'Name',
      'Title',
      'Kind',
      'Handler',
      'Trigger',
      'If schedule: Cron',
      'If schedule: Time zone',
      'If schedule: Catch up',
      'If signal: Signal name',
      'Title',
      'Description',
      'ID',
      'Input schema',
      'Output schema',
      'Paused',
    ]);
    expect(rows.filter((row) => row.startsOptional)).toHaveLength(1);
    expect(rows[10]?.startsOptional).toBe(true);
    expect(rows.filter((row) => row.required).map((row) => row.label)).toEqual([
      'Steps',
      'Name',
      'Kind',
      'Trigger',
      'If schedule: Cron',
      'If signal: Signal name',
    ]);
    expect(rows.map((row) => row.type)).toEqual([
      'list of steps',
      'text',
      'text',
      'one of: activity, wait',
      'text',
      'one of: schedule, signal, manual',
      'text',
      'text',
      'yes or no',
      'text',
      'text',
      'text',
      'text',
      'JSON schema',
      'JSON schema',
      'yes or no',
    ]);
  });

  test('has no hairline when every field is required or none is, and no group headers', () => {
    const { container } = render(SchemaView, { schema: notifySchema });
    expect(readRows(container).some((row) => row.startsOptional)).toBe(false);
    const optionalOnly = render(SchemaView, {
      schema: { properties: { a: { type: 'string' }, b: { type: 'string' } } },
    });
    expect(readRows(optionalOnly.container).some((row) => row.startsOptional)).toBe(false);
  });

  test('says where a nested row sits for a screen reader without changing its label', () => {
    const { container } = render(SchemaView, { schema: workflowSchema });
    const nested = container.querySelectorAll('[data-cinder-depth="1"]');
    const first = requiredInstance(nested[0], HTMLElement);
    expect(first.querySelector('.cinder-sr-only')?.textContent).toBe('Steps › ');
    expect(first.querySelector('.cinder-schema-view__label')?.textContent).toBe('Name');
    const branch = requiredInstance(
      container.querySelector('[data-cinder-depth="1"]:nth-of-type(7)'),
      HTMLElement,
    );
    expect(branch.querySelector('.cinder-sr-only')?.textContent).toBe('Trigger › ');
  });

  test('shows the first paragraph with a More link only where there is more to say', () => {
    const { container } = render(SchemaView, { schema: workflowSchema });
    const rows = Array.from(
      container.querySelectorAll('[role="row"]:not(.cinder-schema-view__row--header)'),
    );
    const withMore = rows
      .filter((row) => row.querySelector('.cinder-schema-view__toggle') !== null)
      .map((row) => row.querySelector('.cinder-schema-view__label')?.textContent);
    // Top-level Steps, Trigger, Title, Description, ID and Input schema; no nested row; neither
    // Output schema nor Paused.
    expect(withMore).toEqual(['Steps', 'Trigger', 'Title', 'Description', 'ID', 'Input schema']);
    const steps = requiredInstance(rows[0], HTMLElement);
    expect(steps.querySelector('.cinder-schema-view__description')?.textContent).toBe(
      'The work to do, in order.',
    );
  });

  test('More expands the model-facing text in place and turns into Less', async () => {
    const { container, getByRole } = render(SchemaView, { schema: workflowSchema });
    const more = getByRole('button', { name: 'More about Steps' });
    expect(more.textContent).toBe('More');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    const text = requiredInstance(
      container.querySelector(`[id="${more.getAttribute('aria-controls')}"]`),
      HTMLElement,
    );
    expect(text.textContent).toBe('The work to do, in order.');

    await fireEvent.click(more);
    expect(more.textContent).toBe('Less');
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(text.textContent).toBe(
      'The work to do, in order. Each step is an activity or a wait. Steps run top to bottom.',
    );
    // It stays in the description cell, beside the link.
    expect(more.parentElement).toBe(text.parentElement);
    expect(more.parentElement?.getAttribute('role')).toBe('cell');

    // Only that row opened.
    expect(getByRole('button', { name: 'More about Trigger' }).getAttribute('aria-expanded')).toBe(
      'false',
    );

    await fireEvent.click(more);
    expect(more.textContent).toBe('More');
    expect(text.textContent).toBe('The work to do, in order.');
  });

  test('a field with no model-facing text has no More link', () => {
    const { queryByRole } = render(SchemaView, { schema: searchToolSchema });
    expect(queryByRole('button', { name: /more about/i })).toBeNull();
  });

  test('lists a choice by its branches, labelled "If <choice>: <field>"', () => {
    const { container } = render(SchemaView, {
      schema: notifySchema,
      caption:
        'A branch’s fields indent under their choice and read “If <choice>: <field>”. Only the chosen branch’s required dots apply.',
    });
    const rows = readRows(container);
    expect(rows.map((row) => [row.label, row.type, row.required, row.description])).toEqual([
      ['Notify', 'one of: email, slack, webhook', true, 'Where the summary goes.'],
      ['If email: Address', 'text', true, 'Who receives it.'],
      ['If slack: Channel', 'text', true, 'The channel name, such as #refunds.'],
      ['If webhook: URL', 'text', true, 'Called with the summary as JSON.'],
      ['If webhook: Secret', 'text', false, 'Sent as a header. Never shown again.'],
    ]);
    expect(rows.slice(1).every((row) => row.depth === '1')).toBe(true);
    expect(container.querySelector('.cinder-schema-view__caption')?.textContent).toContain(
      'Only the chosen branch’s required dots apply.',
    );
  });

  test('a long label truncates to one line with the full label as its tooltip, dot after it', () => {
    const { container } = render(SchemaView, { schema: longValuesSchema });
    const field = requiredInstance(
      container.querySelector('.cinder-schema-view__field'),
      HTMLElement,
    );
    const label = requiredInstance(field.querySelector('.cinder-schema-view__label'), HTMLElement);
    expect(label.title).toBe(label.textContent);
    expect(label.textContent?.length).toBeGreaterThan(40);
    // The dot is a sibling after the label, so truncating the label never removes it.
    expect(label.nextElementSibling?.getAttribute('aria-label')).toBe('Required');
  });

  test('a value with no spaces is the cell’s text, which the stylesheet lets break anywhere', async () => {
    const { container } = render(SchemaView, { schema: longValuesSchema });
    const types = Array.from(container.querySelectorAll('.cinder-schema-view__type')).map(
      (type) => type.textContent,
    );
    expect(types[1]).toContain('QmVkS3Jvbm9z');
    const css = await Bun.file(new URL('./schema-view.css', import.meta.url)).text();
    const cell = /\.cinder-schema-view__cell\s*\{([^}]*)\}/s.exec(css)?.[1] ?? '';
    expect(cell).toContain('overflow-wrap: anywhere');
    const grid = /\.cinder-schema-view__grid\s*\{([^}]*)\}/s.exec(css)?.[1] ?? '';
    // Every track may shrink to nothing, so no cell can widen the grid past its frame.
    expect(grid).not.toMatch(/minmax\((?!0,)/);
  });

  test('restacks the columns on a narrow view by its own width, not the viewport', async () => {
    const css = await Bun.file(new URL('./schema-view.css', import.meta.url)).text();
    const root = /\.cinder-schema-view\s*\{([^}]*)\}/s.exec(css)?.[1] ?? '';
    expect(root).toContain('container-type: inline-size');
    expect(css).toMatch(/@container \(max-inline-size: 30rem\)/);
    expect(css).not.toMatch(/@media \([^)]*(?:max|min)-width/);
    const narrow = css.slice(css.indexOf('@container'));
    expect(narrow).toContain("'field kind'");
    expect(narrow).toContain("'about about'");
  });

  test('never dumps the raw schema while the disclosure is closed', () => {
    const { container } = render(SchemaView, { schema: refundSchema });
    expect(container.textContent).not.toContain('$schema');
    expect(container.textContent).not.toContain('"type"');
  });

  test('links the raw schema document, named JSON schema, to its disclosure', async () => {
    const { container, getByRole } = render(SchemaView, { schema: refundSchema });
    const toggle = getByRole('button', { name: 'JSON schema' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.cinder-json-viewer')).toBeNull();
    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const panelId = toggle.getAttribute('aria-controls');
    expect(panelId).not.toBeNull();
    const viewer = container
      .querySelector(`[id="${panelId}"]`)
      ?.querySelector('.cinder-json-viewer');
    expect(viewer).not.toBeNull();
    // It is the document itself, not a summary of it, and in the order the file wrote it.
    expect(viewer?.textContent).toContain('$schema');
    expect(viewer?.textContent).toContain('required');
  });

  test('the raw schema keeps the file order although the rows put required fields first', async () => {
    const before = Object.keys(workflowSchema.properties);
    const { container, getByRole } = render(SchemaView, { schema: workflowSchema });
    // Reading the schema for the grid never reorders the document the viewer shows.
    expect(Object.keys(workflowSchema.properties)).toEqual(before);
    expect(before.indexOf('title')).toBeLessThan(before.indexOf('steps'));
    await fireEvent.click(getByRole('button', { name: 'JSON schema' }));
    const keys = Array.from(container.querySelectorAll('.cinder-json-viewer__key')).map(
      (key) => key.textContent,
    );
    const topLevel = ['$schema:', 'type:', 'required:', 'properties:'];
    expect(keys.filter((key) => topLevel.includes(key ?? ''))).toEqual(topLevel);
  });

  test('the required dot is red from a status token, never a raw colour', async () => {
    const css = await Bun.file(new URL('./schema-view.css', import.meta.url)).text();
    const rule = /\.cinder-schema-view__required\s*\{([^}]*)\}/s.exec(css)?.[1] ?? '';
    expect(rule).toContain('background: var(--cinder-status-danger-solid)');
    expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
  });

  test('a schema with no fields is one line in a bordered box, with the raw document still offered', () => {
    const { container, getByText, getByRole, queryByRole } = render(SchemaView, { schema: {} });
    expect(
      getByText('This schema takes no fields, so there is nothing to fill in.').className,
    ).toBe('cinder-schema-view__empty');
    expect(queryByRole('table')).toBeNull();
    expect(container.querySelector('[role="row"]')).toBeNull();
    expect(getByRole('button', { name: 'JSON schema' })).not.toBeNull();
  });

  test('a custom empty label replaces the default', () => {
    const { getByText } = render(SchemaView, { schema: null, emptyLabel: 'No input.' });
    expect(getByText('No input.')).not.toBeNull();
  });

  test('says when nested fields are cut at maxDepth', () => {
    const { container } = render(SchemaView, {
      schema: {
        properties: {
          outer: { properties: { inner: { properties: { deep: { type: 'string' } } } } },
        },
      },
      maxDepth: 1,
    });
    expect(container.textContent).toContain('Nested fields are not shown here.');
    expect(container.textContent).not.toContain('Deep');
  });

  test('forwards attributes and merges the class onto the root', () => {
    const { container } = render(SchemaView, {
      schema: refundSchema,
      class: 'custom',
      'data-testid': 'schema',
    } as Parameters<typeof render>[1]);
    const root = container.querySelector('.cinder-schema-view');
    expect(root?.classList.contains('custom')).toBe(true);
    expect(root?.getAttribute('data-testid')).toBe('schema');
  });
});

describe('SchemaView on a tool page', () => {
  test('the tool input is the shared grid: a required Search text and an optional Limit', () => {
    const { container } = render(SchemaView, { schema: searchToolSchema, label: 'Inputs' });
    expect(readRows(container)).toEqual([
      {
        label: 'Search text',
        type: 'text',
        required: true,
        description: 'Matches against agent names and descriptions.',
        depth: '0',
        startsOptional: false,
      },
      {
        label: 'Limit',
        type: 'number',
        required: false,
        description: 'How many agents to return. Defaults to 10.',
        depth: '0',
        startsOptional: true,
      },
    ]);
  });
});
