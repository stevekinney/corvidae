/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, fireEvent, render } = await import('@testing-library/svelte');
const { default: SchemaView } = await import('./schema-view.svelte');

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

describe('SchemaView', () => {
  test('renders a nested schema with required dots and links the raw document', async () => {
    const { container, getByRole } = render(SchemaView, {
      schema: refundSchema,
      label: 'Refund input',
    });

    // The region is named for what the schema describes.
    const region = getByRole('region', { name: 'Refund input' });
    expect(region).not.toBeNull();

    // One line per field: top-level fields first, nested fields in a list inside their parent.
    const topLevel = Array.from(
      container.querySelectorAll(':scope > section > ul > li > .cinder-schema-view__line'),
    );
    expect(
      topLevel.map((line) => line.querySelector('.cinder-schema-view__label')?.textContent),
    ).toEqual(['Order ID', 'Refund Amount', 'Customer']);
    const nested = container.querySelector('li li .cinder-schema-view__label');
    expect(nested?.textContent).toBe('Email');
    expect(container.querySelectorAll('li li')).toHaveLength(2);

    // Types are small monospace, descriptions sit on the same line.
    const orderLine = requiredInstance(topLevel[0], HTMLElement);
    expect(orderLine.querySelector('code.cinder-schema-view__type')?.textContent).toBe('string');
    expect(orderLine.querySelector('.cinder-schema-view__description')?.textContent).toBe(
      'The order to refund.',
    );

    // Required fields (and only those) carry a named dot.
    const dots = Array.from(container.querySelectorAll('[role="img"][aria-label="Required"]'));
    expect(dots).toHaveLength(3);
    const requiredLabels = dots.map(
      (dot) => dot.parentElement?.querySelector('.cinder-schema-view__label')?.textContent,
    );
    expect(requiredLabels).toEqual(['Order ID', 'Customer', 'Email']);

    // The raw document is behind View JSON Schema, linked to it by aria-controls.
    const toggle = getByRole('button', { name: 'View JSON Schema' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.cinder-json-viewer')).toBeNull();
    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const panelId = toggle.getAttribute('aria-controls');
    expect(panelId).not.toBeNull();
    const panel = container.querySelector(`[id="${panelId}"]`);
    const viewer = panel?.querySelector('.cinder-json-viewer');
    expect(viewer).not.toBeNull();
    // It is the document itself, not a summary of it.
    expect(viewer?.textContent).toContain('$schema');
    expect(viewer?.textContent).toContain('required');
  });

  test('never dumps the raw schema while the disclosure is closed', () => {
    const { container } = render(SchemaView, { schema: refundSchema });
    expect(container.textContent).not.toContain('$schema');
    expect(container.textContent).not.toContain('"type"');
  });

  test('the required dot is red from a status token, never a raw colour', async () => {
    const css = await Bun.file(new URL('./schema-view.css', import.meta.url)).text();
    const rule = /\.cinder-schema-view__required\s*\{([^}]*)\}/s.exec(css)?.[1] ?? '';
    expect(rule).toContain('background: var(--cinder-status-danger-solid)');
    expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
  });

  test('shows an empty message and still offers the raw document for a schema with no fields', () => {
    const { getByText, getByRole } = render(SchemaView, { schema: {} });
    expect(getByText('This schema declares no fields.')).not.toBeNull();
    expect(getByRole('button', { name: 'View JSON Schema' })).not.toBeNull();
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
