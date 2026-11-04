/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';
import Ajv2020 from 'ajv/dist/2020';

// setupHappyDom() MUST run before any `@testing-library/svelte` import. testing-library
// reads `globalThis.document` / `window` at module-init (top-level, not inside test bodies),
// so we register happy-dom's globals first and then dynamic-import testing-library below.
setupHappyDom();

const { render, cleanup, fireEvent } = await import('@testing-library/svelte');
const { default: PayloadInspector } = await import('./payload-inspector.svelte');
const { default: payloadInspectorSchema } = await import('./payload-inspector.schema.ts');

beforeEach(() => document.body.replaceChildren());
afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderInspector(props: Record<string, unknown> = {}) {
  return render(PayloadInspector, props);
}

function readCss(): string {
  return readFileSync(new URL('./payload-inspector.css', import.meta.url), 'utf8');
}

describe('PayloadInspector', () => {
  describe('schema', () => {
    test('models JSON payload values as supported input', () => {
      const ajv = new Ajv2020({ strict: false });
      const validate = ajv.compile(payloadInspectorSchema);

      expect(payloadInspectorSchema.properties).toHaveProperty('value');
      expect(payloadInspectorSchema.metadata?.unsupportedProps?.map((prop) => prop.name)).toEqual([
        'formatValue',
        'linkFor',
        'onRetry',
        'parse',
      ]);

      expect(
        validate({
          value: {
            filters: {
              include: {
                branch: 'main',
              },
            },
            matrix: [['bun', 'test']],
          },
        }),
      ).toBe(true);
      expect(validate.errors).toBeNull();
    });

    test('accepts deeply nested payload arrays without a depth boundary', () => {
      const ajv = new Ajv2020({ strict: false });
      const validate = ajv.compile(payloadInspectorSchema);

      expect(
        validate({
          value: [[[[[['leaf']]]]]],
        }),
      ).toBe(true);
      expect(validate.errors).toBeNull();
    });
  });

  describe('structure', () => {
    test('renders a named, non-landmark group with the component class', () => {
      const { container } = renderInspector({ value: { key: 'value' } });
      const root = container.querySelector('.cinder-payload-inspector');
      expect(root?.tagName.toLowerCase()).toBe('div');
      expect(root?.getAttribute('role')).toBe('group');
      expect(root?.getAttribute('aria-label')).toBe('Payload');
    });

    test('draws a label at the start of the header only when given one, and names the card with it', () => {
      const { container } = renderInspector({ value: { key: 'value' }, label: 'Input' });
      const root = container.querySelector('.cinder-payload-inspector');
      expect(root?.getAttribute('aria-label')).toBe('Input');
      const label = container.querySelector('.cinder-payload-inspector__label');
      expect(label?.textContent).toBe('Input');
      expect(label?.nextElementSibling?.querySelector('[role="radiogroup"]')).not.toBeNull();
      expect(
        renderInspector({ value: { key: 'value' } }).container.querySelector(
          '.cinder-payload-inspector__label',
        ),
      ).toBeNull();
    });

    test('27c: one card for every shape: switch at the start, count and copy at the end, body under a divider', () => {
      const { container } = renderInspector({ value: { key: 'value' } });
      const header = requiredInstance(
        container.querySelector('.cinder-payload-inspector__header'),
        HTMLElement,
      );
      const switchGroup = header.firstElementChild;
      expect(switchGroup?.querySelector('[role="radiogroup"]')).not.toBeNull();
      expect(switchGroup?.textContent).toContain('Fields');
      expect(switchGroup?.textContent).toContain('JSON');
      const actions = requiredInstance(
        header.querySelector('.cinder-payload-inspector__header-actions'),
        HTMLElement,
      );
      expect(header.lastElementChild).toBe(actions);
      expect(actions.querySelector('.cinder-payload-inspector__size')?.textContent).toBe('1 field');
      expect(actions.querySelectorAll('.cinder-copy-button')).toHaveLength(1);
      expect(header.nextElementSibling?.className).toBe('cinder-payload-inspector__panel');
      expect(readCss()).toMatch(
        /\.cinder-payload-inspector__header\s*\{[^}]*border-block-end:\s*1px solid/s,
      );
      expect(readCss()).toMatch(/\.cinder-payload-inspector\s*\{[^}]*border:\s*1px solid/s);
    });

    test('renders no tabs', () => {
      const { container } = renderInspector({ value: { hello: 'world' } });
      expect(container.querySelector('[role="tablist"]')).toBeNull();
      expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
    });
  });

  describe('27a: no input', () => {
    test('draws one muted line, with no frame, switch or copy button', () => {
      const { container } = renderInspector({
        emptyLabel: 'This tool call takes no input.',
      });
      const root = requiredInstance(
        container.querySelector('.cinder-payload-inspector'),
        HTMLElement,
      );
      expect(root.textContent?.trim()).toBe('This tool call takes no input.');
      expect(root.querySelector('[role="radiogroup"]')).toBeNull();
      expect(root.querySelector('.cinder-copy-button')).toBeNull();
      expect(root.querySelector('.cinder-payload-inspector__header')).toBeNull();
      expect(readCss()).toMatch(
        /\[data-cinder-state='none'\]\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent/s,
      );
    });

    test('says "No payload" unless told otherwise', () => {
      const { container } = renderInspector({});
      expect(container.querySelector('.cinder-payload-inspector__empty')?.textContent).toBe(
        'No payload',
      );
    });
  });

  describe('27b: a single scalar', () => {
    test('shows the value alone, in monospace, under a "1 value" header, with the same value quoted in JSON', async () => {
      const { container, getByRole } = renderInspector({ value: 'order-4471' });
      expect(container.querySelector('.cinder-payload-inspector__size')?.textContent).toBe(
        '1 value',
      );
      const primitive = requiredInstance(
        container.querySelector('.cinder-payload-inspector__primitive'),
        HTMLElement,
      );
      expect(primitive.textContent?.trim()).toBe('order-4471');
      expect(container.querySelector('.cinder-payload-inspector__field-label')).toBeNull();
      expect(container.querySelector('dl')).toBeNull();
      expect(readCss()).toMatch(
        /\.cinder-payload-inspector__primitive\s*\{[^}]*font-family:\s*var\(--cinder-font-mono\)/s,
      );
      await fireEvent.click(getByRole('radio', { name: 'JSON' }));
      expect(container.querySelector('.cinder-json-viewer__value')?.textContent?.trim()).toBe(
        '"order-4471"',
      );
    });

    test.each([
      ['null', null, 'None'],
      ['a boolean', false, 'No'],
      ['a number', 42, '42'],
      ['plain text that only looks like a flag', '--force', '--force'],
      ['plain text that looks like a keyword', 'true-ish', 'true-ish'],
      ['an empty string (read as nothing)', '', 'None'],
    ])('reads %s as a scalar', (_name, value, text) => {
      const { container } = renderInspector({ value });
      expect(
        container.querySelector('.cinder-payload-inspector__primitive')?.textContent?.trim(),
      ).toBe(text);
      expect(container.querySelector('[role="alert"]')).toBeNull();
    });
  });

  describe('27d and 27e: the header count and the inline variant', () => {
    test('a few short pairs read as one line, labels regular and values bold, joined by middots', () => {
      const { container } = renderInspector({ value: { orderId: 4471, amount: '$42.00' } });
      const inline = requiredInstance(
        container.querySelector('.cinder-payload-inspector__inline'),
        HTMLElement,
      );
      expect(inline.textContent?.replaceAll(/\s+/g, ' ').trim()).toBe(
        'Order ID 4471 · Amount $42.00',
      );
      expect(
        Array.from(inline.querySelectorAll('strong')).map((value) => value.textContent?.trim()),
      ).toEqual(['4471', '$42.00']);
      expect(container.querySelector('.cinder-payload-inspector__size')?.textContent).toBe(
        '2 fields',
      );
      const css = readCss();
      expect(css).toMatch(
        /\.cinder-payload-inspector__inline\s*\{[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s,
      );
    });

    test('the JSON view shows the raw keys and the stored values', async () => {
      const { container, getByRole } = renderInspector({
        value: { orderId: 4471, amount: '$42.00' },
        initialDepth: 2,
      });
      await fireEvent.click(getByRole('radio', { name: 'JSON' }));
      const keys = Array.from(container.querySelectorAll('.cinder-json-viewer__key')).map((key) =>
        key.textContent?.trim(),
      );
      expect(keys).toEqual(['orderId:', 'amount:']);
      expect(container.querySelector('.cinder-payload-inspector__size')?.textContent).toBe(
        '2 fields',
      );
    });

    test('counts top-level keys in words and adds the size only above 1 KB', () => {
      const small = renderInspector({ value: { a: 1 } });
      expect(small.container.querySelector('.cinder-payload-inspector__size')?.textContent).toBe(
        '1 field',
      );
      cleanup();
      const large = renderInspector({ value: { a: 'x'.repeat(1400), b: 2 } });
      expect(large.container.querySelector('.cinder-payload-inspector__size')?.textContent).toBe(
        '2 fields · 1.4 KB',
      );
    });

    test('a nested label carries its own count', () => {
      const { container } = renderInspector({
        value: { notify: { email: 'ops@example.com', slack: '#refunds' }, retries: 3 },
      });
      const labels = Array.from(container.querySelectorAll('dt')).map((label) =>
        label.textContent?.replaceAll(/\s+/g, ' ').trim(),
      );
      expect(labels).toContain('Notify · 2 fields');
    });
  });

  describe('27f and 27g: many pairs and the label formatter', () => {
    const order = {
      orderId: 4471,
      amount: '$42.00',
      reason: 'Arrived damaged',
      status: 'delivered',
      customer: 'Dana Whitfield',
      currency: 'USD',
      carrier: 'Parcelly',
      shippedOn: '2026-10-24',
    };

    test('eight pairs wrap into a content-sized grid', () => {
      const { container } = renderInspector({ value: order });
      const fields = requiredInstance(container.querySelector('dl'), HTMLElement);
      expect(fields.getAttribute('data-cinder-layout')).toBe('grid');
      expect(container.querySelector('.cinder-payload-inspector__size')?.textContent).toBe(
        '8 fields',
      );
      expect(readCss()).toMatch(
        /\[data-cinder-layout='grid'\]\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(min\(100%,\s*14rem\),\s*max-content\)\)/s,
      );
    });

    test('at a phone width a pair stays on one line and the pairs sit further apart than a key from its value', () => {
      const narrow = /@media \(max-width: 30rem\) \{(.*?)\n {2}\}\n/s.exec(readCss())?.[1] ?? '';
      expect(narrow).toMatch(
        /\[data-cinder-layout='grid'\]\s*\{[^}]*row-gap:\s*var\(--cinder-space-2-5\)/s,
      );
      expect(narrow).toMatch(
        /\[data-cinder-layout='grid'\]\s*>\s*\.cinder-payload-inspector__field\s*\{[^}]*flex-wrap:\s*wrap;[^}]*gap:\s*var\(--cinder-space-0-5\)\s+var\(--cinder-space-2\)/s,
      );
      // The pair is never turned into a stacked grid, which put the key and its value further
      // apart than the value and the next key.
      expect(narrow).not.toMatch(
        /\[data-cinder-layout='grid'\]\s*>\s*[^{]*\{[^}]*display:\s*grid/s,
      );
    });

    test('keys read as sentence case with acronyms kept, and ISO dates read as dates', () => {
      const { container } = renderInspector({ value: order });
      const labels = Array.from(container.querySelectorAll('dt')).map((label) =>
        label.textContent?.trim(),
      );
      expect(labels).toEqual([
        'Order ID',
        'Amount',
        'Reason',
        'Status',
        'Customer',
        'Currency',
        'Carrier',
        'Shipped on',
      ]);
      const values = Array.from(container.querySelectorAll('dd')).map((value) =>
        value.textContent?.trim(),
      );
      expect(values).toContain('Oct 24, 2026');
      expect(values).toContain('delivered');
    });

    test('the JSON view keeps the raw keys and the stored date', async () => {
      const { container, getByRole } = renderInspector({ value: order });
      await fireEvent.click(getByRole('radio', { name: 'JSON' }));
      const text = container.querySelector('.cinder-json-viewer')?.textContent ?? '';
      expect(text).toContain('orderId:');
      expect(text).toContain('shippedOn:');
      expect(text).toContain('"2026-10-24"');
    });

    test('five pairs stay one to a row', () => {
      const { container } = renderInspector({
        value: { a: 1, b: 2, c: 3, d: 4, e: 5 },
      });
      expect(container.querySelector('dl')?.getAttribute('data-cinder-layout')).toBe('rows');
    });
  });

  describe('27i: a long string', () => {
    const notes = 'Customer wrote in twice about the damaged box. '.repeat(30);

    test('clamps to two lines with Show all, in a row of its own and never in a grid column', async () => {
      const { container, getByRole } = renderInspector({
        value: { reason: 'Arrived damaged', notes },
      });
      const text = requiredInstance(
        container.querySelector('.cinder-payload-inspector__clamp-text'),
        HTMLElement,
      );
      expect(text.hasAttribute('data-cinder-clamped')).toBe(true);
      expect(container.querySelector('dl')?.getAttribute('data-cinder-layout')).toBe('rows');
      expect(readCss()).toMatch(/\[data-cinder-clamped\]\s*\{[^}]*-webkit-line-clamp:\s*2/s);
      const showAll = getByRole('button', { name: 'Show all' });
      expect(showAll.getAttribute('aria-expanded')).toBe('false');
      await fireEvent.click(showAll);
      expect(text.hasAttribute('data-cinder-clamped')).toBe(false);
      expect(getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe('true');
    });

    test('the header names the size above 1 KB, and the JSON view escapes line breaks', async () => {
      const patch = `--- a/notes.md\n+++ b/notes.md\n@@ -1,2 +1,2 @@\n-old\n+${'new '.repeat(300)}\n`;
      const { container, getByRole } = renderInspector({
        value: { path: 'notes.md', patch },
        initialDepth: 2,
      });
      expect(container.querySelector('.cinder-payload-inspector__size')?.textContent).toMatch(
        /^2 fields · 1\.\d KB$/,
      );
      await fireEvent.click(getByRole('radio', { name: 'JSON' }));
      const value = Array.from(container.querySelectorAll('.cinder-json-viewer__value')).find(
        (candidate) => candidate.textContent?.includes('--- a/notes.md'),
      );
      expect(value?.textContent).toContain('\\n+++ b/notes.md\\n@@');
    });
  });

  describe('27j: a nested object', () => {
    const value = {
      notify: { email: 'ops@example.com', slack: '#refunds' },
      retries: 3,
      attachments: [{ name: 'photo.png' }, { kind: 'note' }],
    };

    test('renders an indented, collapsible tree: objects open, arrays closed', async () => {
      const { container, getByRole } = renderInspector({ value });
      const view = requiredInstance(
        container.querySelector('.cinder-payload-inspector__field-view'),
        HTMLElement,
      );
      expect(view.hasAttribute('data-cinder-tree')).toBe(true);
      const notify = getByRole('button', { name: /^Notify/ });
      const attachments = getByRole('button', { name: /^Attachments/ });
      expect(notify.getAttribute('aria-expanded')).toBe('true');
      expect(attachments.getAttribute('aria-expanded')).toBe('false');
      expect(notify.textContent?.replaceAll(/\s+/g, ' ').trim()).toBe('Notify · 2 fields');
      expect(attachments.textContent?.replaceAll(/\s+/g, ' ').trim()).toBe('Attachments · 2 items');
      expect(view.textContent).toContain('ops@example.com');
      expect(view.textContent).toContain('#refunds');
      expect(view.textContent).not.toContain('photo.png');
      expect(container.querySelector('.cinder-payload-inspector__size')?.textContent).toBe(
        '3 fields',
      );
      await fireEvent.click(attachments);
      expect(attachments.getAttribute('aria-expanded')).toBe('true');
      expect(view.textContent).toContain('photo.png');
      await fireEvent.click(notify);
      expect(view.textContent).not.toContain('ops@example.com');
    });

    test('keeps the same key and value styling at every level', () => {
      // A leaf value is bold at every depth, and a key is regular at every depth; the rules name
      // the leaf (`:not([data-cinder-block])`) so a nested key never inherits a value's weight.
      expect(readCss()).toMatch(
        /\[data-cinder-tree\]\s*\.cinder-payload-inspector__field:not\(\[data-cinder-block\]\)\s*>\s*\.cinder-payload-inspector__field-value\s*\{[^}]*font-weight:\s*var\(--cinder-font-semibold\)/s,
      );
    });

    test('the JSON view collapses what is nested as "… N items"', async () => {
      const { container, getByRole } = renderInspector({ value });
      await fireEvent.click(getByRole('radio', { name: 'JSON' }));
      const summaries = Array.from(container.querySelectorAll('.cinder-json-viewer__summary')).map(
        (summary) => summary.textContent,
      );
      expect(summaries).toContain('… 2 items');
    });

    test('starts an object open only above initialDepth', () => {
      const { getByRole } = renderInspector({ value, initialDepth: 0 });
      expect(getByRole('button', { name: /^Notify/ }).getAttribute('aria-expanded')).toBe('false');
    });
  });

  describe('27k: an array of scalars', () => {
    test('is a bulleted list under its key, never the index as a label', () => {
      const { container } = renderInspector({
        value: { recipients: ['dana@example.com', 'ops@example.com', 'billing@example.com'] },
      });
      const label = container.querySelector('dt');
      expect(label?.textContent?.replaceAll(/\s+/g, ' ').trim()).toBe('Recipients · 3 items');
      const items = Array.from(container.querySelectorAll('ul > li')).map((item) =>
        item.textContent?.trim(),
      );
      expect(items).toEqual(['dana@example.com', 'ops@example.com', 'billing@example.com']);
      expect(container.querySelector('.cinder-payload-inspector__size')?.textContent).toBe(
        '1 field',
      );
      expect(readCss()).toMatch(/__list\s*\{[^}]*list-style:\s*disc/s);
    });
  });

  describe('27l: an array of uniform objects', () => {
    const parts = {
      parts: [
        { type: 'text', text: 'Your refund for order 4471 is on its way.' },
        { type: 'text', text: 'It should reach your card within 5 business days.' },
        { type: 'reasoning', text: 'Order was marked delivered damaged; refund approved.' },
      ],
    };

    test('is a small table with real headers from the shared keys, under a counted label', () => {
      const { container } = renderInspector({ value: parts });
      expect(container.querySelector('dt')?.textContent?.replaceAll(/\s+/g, ' ').trim()).toBe(
        'Parts · 3 items',
      );
      const headers = Array.from(container.querySelectorAll('th')).map((cell) =>
        cell.textContent?.trim(),
      );
      expect(headers).toEqual(['Type', 'Text']);
      const rows = Array.from(container.querySelectorAll('tbody tr')).map((row) =>
        Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent?.trim()),
      );
      expect(rows).toEqual([
        ['text', 'Your refund for order 4471 is on its way.'],
        ['text', 'It should reach your card within 5 business days.'],
        ['reasoning', 'Order was marked delivered damaged; refund approved.'],
      ]);
      expect(container.querySelector('.cinder-payload-inspector__size')?.textContent).toBe(
        '1 field',
      );
    });

    test('sets a column of single tokens in monospace and prose in the page font', () => {
      const { container } = renderInspector({ value: parts });
      const first = Array.from(container.querySelectorAll('tbody tr')).map((row) =>
        Array.from(row.querySelectorAll('.cinder-payload-inspector__cell')).map((cell) =>
          cell.hasAttribute('data-cinder-token'),
        ),
      );
      expect(first).toEqual([
        [true, false],
        [true, false],
        [true, false],
      ]);
      expect(readCss()).toMatch(
        /__cell\[data-cinder-token\]\s*\{[^}]*font-family:\s*var\(--cinder-font-mono\)/s,
      );
    });

    test('names the table for assistive technology', () => {
      const { container } = renderInspector({ value: parts });
      expect(container.querySelector('caption')?.textContent).toBe('Parts, 3 items');
    });
  });

  describe('27m and 27n: a very large payload', () => {
    const items = Array.from({ length: 2140 }, (_, index) => ({
      sku: `SKU-${1000 + index * 7}`,
      qty: (index % 3) + 1,
      price: 900 + index * 35,
    }));

    test('caps the table at eight rows with a footer and Load more, under a counted label', async () => {
      const { container, getByRole } = renderInspector({ value: { items } });
      expect(container.querySelector('dt')?.textContent?.replaceAll(/\s+/g, ' ').trim()).toBe(
        'Items · 2,140 items',
      );
      expect(
        Array.from(container.querySelectorAll('th')).map((cell) => cell.textContent?.trim()),
      ).toEqual(['SKU', 'Qty', 'Price']);
      expect(container.querySelectorAll('tbody tr')).toHaveLength(8);
      expect(
        container.querySelector('.cinder-payload-inspector__table-footer')?.textContent,
      ).toContain('Showing 8 of 2,140');
      expect(container.querySelector('.cinder-payload-inspector__size')?.textContent).toMatch(
        /^1 field · \d+(\.\d)? KB$/,
      );
      expect(container.querySelector('dl')?.querySelectorAll('tbody tr')).toHaveLength(8);
      await fireEvent.click(getByRole('button', { name: 'Load more' }));
      expect(container.querySelectorAll('tbody tr')).toHaveLength(58);
      expect(
        container.querySelector('.cinder-payload-inspector__table-footer')?.textContent,
      ).toContain('Showing 58 of 2,140');
    });

    test('numbers read as stored, aligned to the end, and formatValue writes anything else by path', () => {
      const { container } = renderInspector({
        value: { items },
        formatValue: ({ path, value }: { path: string[]; value: unknown }) =>
          path.at(-1) === 'price' && typeof value === 'number'
            ? `$${(value / 100).toFixed(2)}`
            : undefined,
      });
      const firstRow = Array.from(
        container.querySelectorAll('tbody tr')[0]?.querySelectorAll('td') ?? [],
      );
      expect(firstRow.map((cell) => cell.textContent?.trim())).toEqual(['SKU-1000', '1', '$9.00']);
      expect(firstRow[1]?.getAttribute('data-cinder-align')).toBe('right');
    });

    test('formatValue never reaches the JSON view', async () => {
      const { container, getByRole } = renderInspector({
        value: { amount: 4200 },
        formatValue: () => '$42.00',
        initialDepth: 2,
      });
      expect(container.textContent).toContain('$42.00');
      await fireEvent.click(getByRole('radio', { name: 'JSON' }));
      expect(container.textContent).toContain('4200');
      expect(container.textContent).not.toContain('$42.00');
    });

    test('the JSON view truncates a very large array with "… 2,138 more"', async () => {
      const { container, getByRole } = renderInspector({
        value: { items },
        initialDepth: 3,
        maxBytes: 10_000_000,
      });
      await fireEvent.click(getByRole('radio', { name: 'JSON' }));
      expect(container.querySelector('.cinder-json-viewer__omitted')?.textContent).toBe(
        '… 2,138 more',
      );
    });
  });

  describe('27o: the JSON view itself', () => {
    test('is a flat code block with muted keys, showing the stored payload with raw keys', async () => {
      const { container, getByRole } = renderInspector({
        value: { orderId: 4471, amount: '$42.00', reason: 'Arrived damaged' },
        initialDepth: 2,
      });
      await fireEvent.click(getByRole('radio', { name: 'JSON' }));
      const viewer = requiredInstance(container.querySelector('.cinder-json-viewer'), HTMLElement);
      expect(
        Array.from(viewer.querySelectorAll('.cinder-json-viewer__key')).map((key) =>
          key.textContent?.trim(),
        ),
      ).toEqual(['orderId:', 'amount:', 'reason:']);
      expect(container.querySelector('.cinder-payload-inspector__size')?.textContent).toBe(
        '3 fields',
      );
    });
  });

  describe('27q: empty, none and yes/no', () => {
    test('reads an empty string as Empty, null as None, and booleans as Yes and No', async () => {
      const value = { orderId: 4471, giftNote: '', coupon: null, giftWrap: false, insured: true };
      const { container, getByRole } = renderInspector({ value });
      const rows = Array.from(container.querySelectorAll('dl > div')).map((row) =>
        [
          row.querySelector('dt')?.textContent?.trim(),
          row.querySelector('dd')?.textContent?.trim(),
        ].join('|'),
      );
      expect(rows).toEqual([
        'Order ID|4471',
        'Gift note|Empty',
        'Coupon|None',
        'Gift wrap|No',
        'Insured|Yes',
      ]);
      expect(container.querySelector('.cinder-payload-inspector__size')?.textContent).toBe(
        '5 fields',
      );
      const muted = Array.from(container.querySelectorAll('.cinder-payload-inspector__null'));
      expect(muted.map((node) => node.textContent)).toEqual(['Empty', 'None']);
      expect(readCss()).toMatch(/__null\s*\{[^}]*font-style:\s*italic/s);
      await fireEvent.click(getByRole('radio', { name: 'JSON' }));
      const stored = Array.from(container.querySelectorAll('.cinder-json-viewer__value')).map(
        (node) => node.textContent?.trim(),
      );
      expect(stored).toEqual(['4471', '""', 'null', 'false', 'true']);
    });
  });

  describe('27r: still streaming in', () => {
    const text = '{"orderId": 4471, "amount": "$42.00", "reason": "Arriv';

    test('shows each field as it completes and the last one as Receiving…', () => {
      const { container } = renderInspector({ value: text, streaming: true });
      const rows = Array.from(container.querySelectorAll('dl > div')).map((row) =>
        [
          row.querySelector('dt')?.textContent?.trim(),
          row.querySelector('dd')?.querySelector('.cinder-inline-loading__label')?.textContent ??
            row.querySelector('dd')?.textContent?.trim(),
        ].join(' '),
      );
      expect(rows).toEqual(['Order ID 4471', 'Amount $42.00', 'Reason Receiving…']);
      expect(container.querySelector('dl .cinder-inline-loading .cinder-spinner')).not.toBeNull();
      expect(container.querySelector('.cinder-payload-inspector__size')?.textContent).toBe(
        '2 fields so far',
      );
    });

    test('keeps Copy in place but disabled until the stream ends', () => {
      const { container } = renderInspector({ value: text, streaming: true });
      const copy = requiredInstance(
        container.querySelector('.cinder-copy-button'),
        HTMLButtonElement,
      );
      expect(copy.disabled).toBe(true);
    });

    test('the JSON view shows the partial text', async () => {
      const { container, getByRole } = renderInspector({ value: text, streaming: true });
      await fireEvent.click(getByRole('radio', { name: 'JSON' }));
      expect(container.querySelector('.cinder-code-block')?.textContent).toContain(
        '"reason": "Arriv',
      );
      expect(container.querySelector('.cinder-json-viewer')).toBeNull();
    });

    test('hides a secret that is still arriving from the partial text', async () => {
      const { container, getByRole } = renderInspector({
        value: '{"orderId": 4471, "apiKey": "sk_live_12',
        streaming: true,
      });
      await fireEvent.click(getByRole('radio', { name: 'JSON' }));
      expect(container.textContent).not.toContain('sk_live');
    });

    test('says only that it is receiving before anything is whole', () => {
      const { container } = renderInspector({ value: '{"order', streaming: true });
      expect(container.querySelector('.cinder-payload-inspector__panel')?.textContent).toContain(
        'Receiving…',
      );
      expect(container.querySelector('dl')).toBeNull();
    });

    test('is a plain payload once the stream ends', () => {
      const { container } = renderInspector({
        value: '{"orderId": 4471, "amount": "$42.00"}',
        streaming: false,
      });
      expect(container.querySelector('.cinder-payload-inspector__size')?.textContent).toBe(
        '2 fields',
      );
      expect(container.querySelector('.cinder-copy-button')?.hasAttribute('disabled')).toBe(false);
    });
  });

  describe('27s: invalid JSON', () => {
    test('shows the switch disabled, "Text", an amber line and the raw text', () => {
      const { container, getAllByRole } = renderInspector({
        value: '{ "orderId": 4471, "amount": }',
      });
      for (const option of getAllByRole('radio')) {
        expect(
          option.hasAttribute('disabled') || option.getAttribute('aria-disabled') === 'true',
        ).toBe(true);
      }
      expect(container.querySelector('.cinder-payload-inspector__size')?.textContent).toBe('Text');
      const warning = requiredInstance(
        container.querySelector('.cinder-payload-inspector__warning'),
        HTMLElement,
      );
      expect(warning.textContent?.replaceAll(/\s+/g, ' ').trim()).toBe(
        "This isn't valid JSON, so it's shown as text.",
      );
      expect(warning.nextElementSibling?.classList.contains('cinder-code-block')).toBe(true);
      expect(container.querySelector('.cinder-code-block')?.textContent).toContain(
        '"orderId": 4471',
      );
      expect(readCss()).toMatch(/__warning\s*\{[^}]*color:\s*var\(--cinder-status-warning-text\)/s);
    });

    test('copies the original text, and the button reads "Copy text"', async () => {
      const writeText = mock(async () => undefined);
      const original = navigator.clipboard;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
      try {
        const { container } = renderInspector({ value: '{ invalid json' });
        const copy = requiredInstance(
          container.querySelector('.cinder-copy-button'),
          HTMLButtonElement,
        );
        expect(copy.getAttribute('aria-label')).toBe('Copy text');
        await fireEvent.click(copy);
        expect(writeText).toHaveBeenCalledWith('{ invalid json');
      } finally {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: original });
      }
    });

    test('a custom parser that throws is invalid too', () => {
      const { container } = renderInspector({
        value: 'custom',
        parse: () => {
          throw new Error('nope');
        },
      });
      expect(container.querySelector('.cinder-payload-inspector__warning')).not.toBeNull();
    });
  });

  describe('27t: copied', () => {
    test('the icon turns into a check with the word Copied, announced to screen readers, with no toast', async () => {
      const writeText = mock(async () => undefined);
      const original = navigator.clipboard;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
      try {
        const { container } = renderInspector({ value: { orderId: 4471, amount: '$42.00' } });
        const copy = requiredInstance(
          container.querySelector('.cinder-copy-button'),
          HTMLButtonElement,
        );
        expect(copy.getAttribute('aria-label')).toBe('Copy payload');
        await fireEvent.click(copy);
        expect(writeText).toHaveBeenCalledWith(
          JSON.stringify({ orderId: 4471, amount: '$42.00' }, null, 2),
        );
        await Promise.resolve();
        expect(copy.hasAttribute('data-cinder-copied')).toBe(true);
        expect(copy.querySelector('.cinder-payload-inspector__copied')?.textContent).toBe('Copied');
        expect(document.body.querySelector('[aria-live="polite"]')).not.toBeNull();
        expect(document.body.querySelector('.cinder-toast-region')).toBeNull();
      } finally {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: original });
      }
    });

    test('reverts after two seconds', () => {
      const source = readFileSync(new URL('./payload-inspector.svelte', import.meta.url), 'utf8');
      expect(source).toContain('confirmDuration={2000}');
    });

    test('copies a JSON-encoded string payload as the original quoted input, not the unquoted parsed result', async () => {
      const writeText = mock(async () => undefined);
      const original = navigator.clipboard;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
      try {
        const { container } = renderInspector({ value: '"hello"' });
        await fireEvent.click(
          requiredInstance(container.querySelector('.cinder-copy-button'), HTMLButtonElement),
        );
        expect(writeText).toHaveBeenCalledWith('"hello"');
      } finally {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: original });
      }
    });
  });

  describe('27u and 27v: secret fields masked', () => {
    const request = { orderId: 4471, authorization: 'Bearer abc123', apiKey: 'sk_live_9f2' };

    test('hides values the caller marks secret in both views and in Copy, before layout', async () => {
      const writeText = mock(async () => undefined);
      const original = navigator.clipboard;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
      try {
        const { container, getByRole } = renderInspector({
          value: request,
          redact: ['authorization', 'apiKey'],
          initialDepth: 2,
        });
        const rows = Array.from(container.querySelectorAll('dl > div')).map((row) =>
          row.textContent?.replaceAll(/\s+/g, ' ').trim(),
        );
        expect(rows).toEqual([
          'Order ID 4471',
          'Authorization •••••••••••• Hidden',
          'API key •••••••••••• Hidden',
        ]);
        expect(container.querySelector('.cinder-payload-inspector__size')?.textContent).toBe(
          '3 fields',
        );
        expect(container.textContent).not.toContain('abc123');
        expect(container.textContent).not.toContain('sk_live');
        await fireEvent.click(getByRole('radio', { name: 'JSON' }));
        const stored = Array.from(container.querySelectorAll('.cinder-json-viewer__value')).map(
          (node) => node.textContent?.trim(),
        );
        expect(stored).toEqual(['4471', '"••••••••••••"', '"••••••••••••"']);
        expect(container.textContent).not.toContain('abc123');
        await fireEvent.click(
          requiredInstance(container.querySelector('.cinder-copy-button'), HTMLButtonElement),
        );
        const copied = (writeText.mock.calls[0] as unknown as [string])[0];
        expect(copied).not.toContain('abc123');
        expect(copied).not.toContain('sk_live');
        expect(copied).toContain('••••••••••••');
      } finally {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: original });
      }
    });

    test('masks a JSON string payload in Copy instead of copying the original text', async () => {
      const writeText = mock(async () => undefined);
      const original = navigator.clipboard;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
      try {
        const { container } = renderInspector({ value: JSON.stringify(request) });
        await fireEvent.click(
          requiredInstance(container.querySelector('.cinder-copy-button'), HTMLButtonElement),
        );
        expect((writeText.mock.calls[0] as unknown as [string])[0]).not.toContain('sk_live');
      } finally {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: original });
      }
    });

    test('guesses from the key name only when no schema is known', () => {
      const guessed = renderInspector({ value: request });
      expect(guessed.container.textContent).not.toContain('abc123');
      expect(guessed.container.textContent).toContain('4471');
      cleanup();
      const known = renderInspector({ value: request, redact: [] });
      expect(known.container.textContent).toContain('abc123');
    });

    test('masks a secret nested in an array or a table cell', () => {
      const { container } = renderInspector({
        value: {
          accounts: [
            { name: 'a', token: 'tok-1' },
            { name: 'b', token: 'tok-2' },
          ],
        },
        redact: ['accounts.*.token'],
      });
      expect(container.textContent).not.toContain('tok-1');
      expect(container.textContent).toContain('Hidden');
    });
  });

  describe('27w and 27x: a long key and a long unbroken value', () => {
    const longKey = `order_notes_exception${'_exceptionally_long_key'.repeat(80)}`;
    const value = {
      [longKey]: 'Left at the door',
      orderId: 4471,
      trackingCode: 'Qm9keU9mVGhlTWVzc2FnZQ'.repeat(40),
    };

    test('truncates a long key to one line and gives it a focusable label that carries a tooltip', () => {
      const { container } = renderInspector({ value });
      const key = requiredInstance(
        container.querySelector('.cinder-payload-inspector__long-key'),
        HTMLElement,
      );
      expect(key.getAttribute('tabindex')).toBe('0');
      expect(key.closest('.cinder-tooltip-wrapper')).not.toBeNull();
      expect(readCss()).toMatch(
        /__long-key\s*\{[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s,
      );
      expect(container.querySelector('.cinder-payload-inspector__size')?.textContent).toMatch(
        /^3 fields/,
      );
    });

    test('a long key asks for at most 10rem of the shared key column, so it never pushes every value away', () => {
      expect(readCss()).toMatch(/__long-key\s*\{[^}]*max-inline-size:\s*10rem/s);
    });

    test('breaks a long unbroken value anywhere instead of overflowing sideways', () => {
      expect(readCss()).toMatch(/__field-value\s*\{[^}]*overflow-wrap:\s*anywhere/s);
    });

    test('the JSON view abbreviates the long key and value with ellipses', async () => {
      const { container, getByRole } = renderInspector({ value, initialDepth: 2 });
      await fireEvent.click(getByRole('radio', { name: 'JSON' }));
      const keys = Array.from(container.querySelectorAll('.cinder-json-viewer__key')).map(
        (node) => node.textContent ?? '',
      );
      expect(keys[0]?.endsWith('…:')).toBe(true);
      expect(keys[0]?.length).toBeLessThan(50);
      const values = Array.from(container.querySelectorAll('.cinder-json-viewer__value')).map(
        (node) => node.textContent ?? '',
      );
      expect(values.some((text) => text.endsWith('…"') && text.length < 220)).toBe(true);
    });

    test('masks a secret long key before it is truncated or wrapped', () => {
      const { container } = renderInspector({
        value: { [`api_key_${'x'.repeat(60)}`]: 'sk_live_secret' },
      });
      expect(container.textContent).not.toContain('sk_live_secret');
      expect(container.textContent).toContain('Hidden');
    });
  });

  describe('27y: an array of mixed objects', () => {
    test('draws no table: each item is its own block of fields, headed "Item N of M"', () => {
      const { container } = renderInspector({
        value: {
          history: [
            { type: 'refund', orderId: 4471, amount: '$42.00' },
            { type: 'note', text: 'Customer called about the photo', author: 'Dana Whitfield' },
            { type: 'email', to: 'dana@example.com' },
          ],
        },
      });
      expect(container.querySelector('table')).toBeNull();
      expect(container.querySelector('dt')?.textContent?.replaceAll(/\s+/g, ' ').trim()).toBe(
        'History · 3 items',
      );
      const titles = Array.from(
        container.querySelectorAll('.cinder-payload-inspector__item-title'),
      ).map((title) => title.textContent);
      expect(titles).toEqual(['Item 1 of 3', 'Item 2 of 3', 'Item 3 of 3']);
      const blocks = Array.from(container.querySelectorAll('.cinder-payload-inspector__item')).map(
        (item) =>
          Array.from(item.querySelectorAll('dl > div')).map((row) =>
            row.textContent?.replaceAll(/\s+/g, ' ').trim(),
          ),
      );
      // One rule runs down the inline start of every item, and the title is small, so at a phone
      // width "Item 2 of 3" never reads as another key.
      expect(readCss()).toMatch(
        /__items\s*\{[^}]*padding-inline-start:[^}]*border-inline-start:\s*2px solid var\(--cinder-border-muted\)/s,
      );
      expect(readCss()).toMatch(/__item-title\s*\{[^}]*font-size:\s*var\(--cinder-text-xs\)/s);
      expect(blocks).toEqual([
        ['Type refund', 'Order ID 4471', 'Amount $42.00'],
        ['Type note', 'Text Customer called about the photo', 'Author Dana Whitfield'],
        ['Type email', 'To dana@example.com'],
      ]);
    });
  });

  describe('28h: over the size limit', () => {
    const big = { blob: 'x'.repeat(4096) };

    test('renders nothing, no switch, the size alone with one Copy button, and a sentence naming both sizes', () => {
      const { container } = renderInspector({ value: big, maxBytes: 1024 });
      expect(container.querySelector('[role="radiogroup"]')).toBeNull();
      expect(container.querySelector('.cinder-payload-inspector__size')?.textContent).toBe('4 KB');
      expect(container.querySelectorAll('.cinder-copy-button')).toHaveLength(1);
      expect(
        container
          .querySelector('.cinder-payload-inspector__notice')
          ?.textContent?.replaceAll(/\s+/g, ' ')
          .trim(),
      ).toBe(
        "This payload is 4 KB, over the 1 KB shown here. It isn't rendered, so the page stays fast.",
      );
      expect(container.querySelector('.cinder-payload-inspector__field')).toBeNull();
      expect(container.querySelector('.cinder-json-viewer')).toBeNull();
    });

    test('names the shipped limit as 1 MB', () => {
      const { container } = renderInspector({ value: { blob: 'x'.repeat(1_100_000) } });
      expect(container.querySelector('.cinder-payload-inspector__notice')?.textContent).toMatch(
        /over the 1 MB shown here/,
      );
      expect(container.querySelector('.cinder-payload-inspector__size')?.textContent).toBe('1 MB');
    });

    test('offers a Download JSON button that saves the payload under the given name', async () => {
      const clicked: string[] = [];
      const originalCreate = URL.createObjectURL;
      const originalRevoke = URL.revokeObjectURL;
      URL.createObjectURL = () => 'blob:payload';
      URL.revokeObjectURL = () => undefined;
      const originalCreateElement = document.createElement.bind(document);
      document.createElement = (tag: string) => {
        const element = originalCreateElement(tag);
        if (tag === 'a') {
          element.click = () => {
            clicked.push(`${element.getAttribute('href')} ${element.getAttribute('download')}`);
          };
        }
        return element;
      };
      try {
        const { getByRole } = renderInspector({
          value: big,
          maxBytes: 1024,
          downloadFilename: 'result.json',
        });
        await fireEvent.click(getByRole('button', { name: 'Download JSON' }));
        expect(clicked).toEqual(['blob:payload result.json']);
      } finally {
        document.createElement = originalCreateElement;
        URL.createObjectURL = originalCreate;
        URL.revokeObjectURL = originalRevoke;
      }
    });
  });

  describe('28i: the payload fails to load', () => {
    test('keeps the header, hides the switch, disables Copy and shows a red error line with Try again', async () => {
      const onRetry = mock(() => undefined);
      const { container, getByRole } = renderInspector({ failed: true, onRetry });
      expect(container.querySelector('.cinder-payload-inspector__header')).not.toBeNull();
      expect(container.querySelector('[role="radiogroup"]')).toBeNull();
      expect(
        requiredInstance(container.querySelector('.cinder-copy-button'), HTMLButtonElement)
          .disabled,
      ).toBe(true);
      const error = requiredInstance(
        container.querySelector('.cinder-payload-inspector__error'),
        HTMLElement,
      );
      expect(error.textContent?.replaceAll(/\s+/g, ' ').trim()).toBe(
        "Couldn't load the full result. Try again",
      );
      expect(error.querySelector('svg')).not.toBeNull();
      expect(readCss()).toMatch(/__error\s*\{[^}]*color:\s*var\(--cinder-status-danger-text\)/s);
      await fireEvent.click(getByRole('button', { name: 'Try again' }));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    test('says what the caller says and omits Try again when nothing can retry', () => {
      const { container } = renderInspector({ failed: true, failedMessage: 'The run was pruned.' });
      expect(container.querySelector('.cinder-payload-inspector__error')?.textContent).toContain(
        'The run was pruned.',
      );
      expect(container.querySelector('.cinder-payload-inspector__error button')).toBeNull();
    });

    test('wins over a value that is also passed', () => {
      const { container } = renderInspector({ failed: true, value: { a: 1 } });
      expect(container.querySelector('dl')).toBeNull();
    });
  });

  describe('28j: a table at 375 px', () => {
    test('stays a table in its own scroll box with an edge fade, and the card never scrolls sideways', () => {
      const { container } = renderInspector({
        value: {
          parts: [
            { type: 'text', text: 'Your refund for order 4471 is on its way.' },
            { type: 'reasoning', text: 'Order was marked delivered damaged; refund approved.' },
          ],
        },
      });
      const scroll = requiredInstance(container.querySelector('.cinder-table-scroll'), HTMLElement);
      expect(scroll.classList.contains('cinder-_scroll-fade-inline-end')).toBe(true);
      expect(scroll.querySelector('table')).not.toBeNull();
      expect(readCss()).toMatch(/__table-element\s*\{[^}]*min-inline-size:\s*22rem/s);
      expect(readCss()).toMatch(/__panel\s*\{[^}]*overflow:\s*auto/s);
    });

    test('keeps a monospaced token column on one line, so a narrow table scrolls instead of breaking words', () => {
      expect(readCss()).toMatch(/__cell\[data-cinder-token\]\s*\{[^}]*white-space:\s*nowrap/s);
    });
  });

  describe('truncated payload', () => {
    test('shows Truncated badge in header when truncated=true', () => {
      const { container } = renderInspector({ value: { key: 'value' }, truncated: true });
      const badges = Array.from(container.querySelectorAll('.cinder-badge'));
      expect(badges.some((badge) => badge.textContent?.trim() === 'Truncated')).toBe(true);
    });
  });

  describe('unserializable values', () => {
    test('shows an explanatory message, no switch and no copy for BigInt values', () => {
      const { container } = renderInspector({ value: { amount: 9007199254740993n } });
      expect(container.textContent).toContain("can't be serialized as JSON");
      expect(container.querySelector('.cinder-json-viewer')).toBeNull();
      expect(container.querySelector('[role="radiogroup"]')).toBeNull();
      expect(container.querySelectorAll('.cinder-copy-button')).toHaveLength(0);
    });

    test('shows the same for circular values', () => {
      const circular: Record<string, unknown> = { name: 'root' };
      circular['self'] = circular;
      const { container } = renderInspector({ value: circular });
      expect(container.textContent).toContain("can't be serialized as JSON");
    });
  });

  describe('object and array payloads', () => {
    test('renders a payload holding an invalid Date in the Fields view', () => {
      const { container } = renderInspector({ value: { at: new Date('not a date') } });
      expect(container.textContent).toContain('Invalid Date');
    });

    test('renders a Date as a date', () => {
      const { container } = renderInspector({ value: { at: new Date('2026-10-24T10:00:00Z') } });
      expect(container.textContent).toContain('Oct 24, 2026');
    });

    test('renders objects and arrays as a JSON tree in the JSON view', () => {
      expect(
        renderInspector({ value: { key: 'value' }, view: 'json' }).container.querySelector(
          '.cinder-json-viewer',
        ),
      ).not.toBeNull();
      cleanup();
      expect(
        renderInspector({ value: [1, 2, 3], view: 'json' }).container.querySelector(
          '.cinder-json-viewer',
        ),
      ).not.toBeNull();
    });

    test('a root array counts its items and lists them', () => {
      const { container } = renderInspector({ value: ['a', 'b'] });
      expect(container.querySelector('.cinder-payload-inspector__size')?.textContent).toBe(
        '2 items',
      );
      expect(container.querySelectorAll('ul > li')).toHaveLength(2);
    });

    test('forwards initialDepth to the JSON tree', () => {
      const { container } = renderInspector({
        value: { webhook: { payload: { id: 'evt_123' } } },
        initialDepth: 2,
        view: 'json',
      });
      const webhookNode = container.querySelector<HTMLElement>(
        '[role="treeitem"][aria-label="webhook: object, 1 item"]',
      );
      const payloadNode = container.querySelector<HTMLElement>(
        '[role="treeitem"][aria-label="payload: object, 1 item"]',
      );
      expect(webhookNode?.getAttribute('aria-expanded')).toBe('true');
      expect(payloadNode?.getAttribute('aria-expanded')).toBe('false');
    });

    test('renders exactly one copy button', () => {
      const { container } = renderInspector({ value: { hello: 'world' } });
      expect(container.querySelectorAll('.cinder-copy-button')).toHaveLength(1);
    });

    test('parses a serialized JSON object or array string', () => {
      const object = renderInspector({ value: '{"hello":"world"}', view: 'json' });
      expect(object.container.textContent).toContain('hello');
      cleanup();
      const array = renderInspector({ value: '[1,2,3]', view: 'json' });
      expect(array.container.querySelector('.cinder-json-viewer')).not.toBeNull();
    });

    test('applies a custom parse function to string values', () => {
      const { container } = renderInspector({
        value: 'custom-format-data',
        parse: (_raw: string) => ({ parsed: true }),
        view: 'json',
      });
      expect(container.textContent).toContain('parsed');
    });
  });

  describe('CSS snapshot', () => {
    test('uses the components layer and composes the primitives it renders', () => {
      const css = readCss();
      expect(css).toContain('@layer cinder.components');
      for (const sheet of [
        'badge',
        'button',
        'code-block',
        'copy-button',
        'inline-loading',
        'json-viewer',
        'segmented-control',
        'source-diff-viewer',
        'table',
        'tooltip',
      ]) {
        expect(css).toContain(`@import '../${sheet}/${sheet}.css';`);
      }
    });

    test('keeps inspector chrome unselectable while diagnostic and payload detail stays selectable', () => {
      const css = readCss();
      expect(css).toMatch(/\.cinder-payload-inspector\s*\{[^}]*user-select:\s*none/s);
      expect(css).toMatch(/\.cinder-payload-inspector__notice\s*\{[^}]*user-select:\s*text/s);
      expect(css).toMatch(/\.cinder-payload-inspector__primitive\s*\{[^}]*user-select:\s*text/s);
      expect(css).toMatch(
        /\.cinder-payload-inspector__panel \.cinder-json-viewer\s*\{[^}]*user-select:\s*text/s,
      );
    });
  });
});

describe('PayloadInspector fields and JSON views', () => {
  const payload = {
    orderId: 'ord_8f2a3b',
    customer: { fullName: 'Ada Lovelace', email: 'ada@example.com' },
    lines: [{ sku: 'p_001', quantity: 2 }],
    paid: true,
    note: null,
    amount: 89.93,
  };

  test('25i: defaults to Fields, labels as words, and switches to JSON', async () => {
    const { container, getByRole } = renderInspector({ value: payload });
    expect(container.querySelector('.cinder-json-viewer')).toBeNull();
    const labels = Array.from(
      container.querySelectorAll('.cinder-payload-inspector__field-label'),
    ).map((label) => label.textContent?.replaceAll(/\s+/g, ' ').trim());
    expect(labels).toContain('Order ID');
    expect(labels).toContain('Full name');
    expect(labels).not.toContain('orderId');
    expect(container.querySelector('[role="tree"]')).toBeNull();

    const fieldsOption = getByRole('radio', { name: 'Fields' });
    const jsonOption = getByRole('radio', { name: 'JSON' });
    expect(fieldsOption.getAttribute('aria-checked')).toBe('true');
    expect(jsonOption.getAttribute('aria-checked')).toBe('false');

    await fireEvent.click(jsonOption);
    expect(container.querySelector('[role="tree"]')).not.toBeNull();
    expect(container.querySelector('.cinder-payload-inspector__field-label')).toBeNull();
    expect(jsonOption.getAttribute('aria-checked')).toBe('true');

    await fireEvent.click(fieldsOption);
    expect(container.querySelector('.cinder-json-viewer')).toBeNull();
  });

  test('formats values: IDs in small monospace, objects as a tree, booleans as Yes and No', () => {
    const { container } = renderInspector({ value: payload });
    const identifier = container.querySelector('code.cinder-payload-inspector__identifier');
    expect(identifier?.textContent).toBe('ord_8f2a3b');
    const rows = Array.from(container.querySelectorAll('.cinder-payload-inspector__field'));
    const rowFor = (label: string) =>
      rows.find(
        (row) =>
          row
            .querySelector(':scope > .cinder-payload-inspector__field-label')
            ?.textContent?.replaceAll(/\s+/g, ' ')
            .trim() === label,
      );
    expect(rowFor('Customer · 2 fields')?.querySelector('dl')).not.toBeNull();
    expect(rowFor('Email')?.textContent).toContain('ada@example.com');
    expect(rowFor('Lines · 1 item')).not.toBeNull();
    expect(rowFor('Paid')?.textContent).toContain('Yes');
    expect(rowFor('Note')?.textContent).toContain('None');
  });

  test('links a value to what it names when linkFor gives an address', () => {
    const seen: string[] = [];
    const { container } = renderInspector({
      value: payload,
      linkFor: ({ path, key, value }: { path: string[]; key: string; value: unknown }) => {
        seen.push(path.join('.'));
        return key === 'orderId' ? `/orders/${String(value)}` : undefined;
      },
    });
    const links = container.querySelectorAll('a.cinder-payload-inspector__link');
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe('/orders/ord_8f2a3b');
    expect(links[0]?.textContent).toBe('ord_8f2a3b');
    expect(seen).toContain('customer.email');
  });

  test('a link keeps pairs on their own rows instead of the inline line', () => {
    const { container } = renderInspector({
      value: { run: 'abc', agent: 'Tool runner' },
      linkFor: ({ key }: { key: string }) => (key === 'run' ? '/runs/abc' : undefined),
    });
    expect(container.querySelector('.cinder-payload-inspector__inline')).toBeNull();
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/runs/abc');
  });

  test('keeps the copy button in the header, copying the whole payload', () => {
    const { container } = renderInspector({ value: payload, label: 'Arguments' });
    const header = container.querySelector('.cinder-payload-inspector__header');
    expect(header?.querySelectorAll('.cinder-copy-button')).toHaveLength(1);
    expect(header?.querySelector('.cinder-copy-button')?.getAttribute('aria-label')).toBe(
      'Copy Arguments',
    );
    expect(container.querySelectorAll('.cinder-copy-button')).toHaveLength(1);
  });

  test('summarises entries past the per-list cap and points at the JSON view', () => {
    const wide = Object.fromEntries(
      Array.from({ length: 130 }, (_, index) => [`key${index}`, index]),
    );
    const { container } = renderInspector({ value: wide });
    expect(container.querySelectorAll('.cinder-payload-inspector__field')).toHaveLength(100);
    expect(container.querySelector('.cinder-payload-inspector__more')?.textContent).toContain(
      '30 more not shown',
    );
  });

  test('shows an empty object and an empty array as such', () => {
    const { container } = renderInspector({ value: { none: {} } });
    expect(container.textContent).toContain('No fields');
    cleanup();
    const list = renderInspector({ value: { items: [], other: 1 } });
    expect(list.container.textContent).toContain('No items');
  });

  test('stops at maxDepth instead of nesting without end', () => {
    const { container } = renderInspector({
      value: { a: { b: { c: { d: 1 } } } },
      maxDepth: 2,
      initialDepth: 9,
    });
    expect(container.textContent).toContain('Too deep to show here.');
  });
});

describe('PayloadInspector: a patch value', () => {
  const patch = [
    '--- a/release-notes.md',
    '+++ b/release-notes.md',
    '@@ -12,3 +12,5 @@',
    ' # Release notes',
    '-Refunds are sent at once.',
    '+Refunds now ask for approval before money moves.',
    '+Large refunds go to a person.',
    '+Nothing is sent without a note.',
    ' Thanks for reading.',
    '',
  ].join('\n');

  test('goes through the diff viewer with its count beside the label and a Show all link', () => {
    const { container, getByRole } = render(PayloadInspector, {
      value: { path: 'release-notes.md', patch },
      label: 'Input',
    });
    const field = requiredInstance(container.querySelector('[data-cinder-patch]'), HTMLElement);
    const label = requiredInstance(field.querySelector('dt'), HTMLElement);
    expect(label.textContent?.replaceAll(/\s+/g, ' ').trim()).toBe('Patch +3 −1');
    expect(label.querySelector('[aria-label="3 added, 1 removed"]')).not.toBeNull();
    const lines = Array.from(field.querySelectorAll('.cinder-source-diff-viewer__line-code')).map(
      (code) => code.textContent?.trim(),
    );
    expect(lines).toEqual([
      '- Refunds are sent at once.',
      '+ Refunds now ask for approval before money moves.',
    ]);
    expect(getByRole('button', { name: 'Show all 9 lines' })).not.toBeNull();
    expect(container.querySelectorAll('[data-cinder-patch]')).toHaveLength(1);
    const path = requiredInstance(
      container.querySelector('.cinder-payload-inspector__identifier'),
      HTMLElement,
    );
    expect(path.textContent).toBe('release-notes.md');
  });

  test('text that only looks like a diff stays plain text', () => {
    const { container } = render(PayloadInspector, {
      value: { note: '- first thing\n- second thing\n+ a plus sign' },
    });
    expect(container.querySelector('[data-cinder-patch]')).toBeNull();
    expect(container.querySelector('.cinder-source-diff-viewer')).toBeNull();
  });
});

describe('PayloadInspector tree styling', () => {
  test('bolds only a leaf value, so nested keys read like top-level keys', () => {
    const css = readCss();

    expect(css).not.toMatch(
      /\[data-cinder-tree\]\s+\.cinder-payload-inspector__field-value\s*\{[^}]*font-weight/,
    );
    expect(css).toMatch(
      /\[data-cinder-tree\]\s+\.cinder-payload-inspector__field:not\(\[data-cinder-block\]\)\s*>\s*\.cinder-payload-inspector__field-value\s*\{[^}]*semibold/,
    );
    expect(css).toMatch(
      /\[data-cinder-tree\]\s+\.cinder-payload-inspector__field-label\s*\{[^}]*font-weight: var\(--cinder-font-normal\)/,
    );
  });

  test('sizes the key column to its longest key, capped, and shares it across rows', () => {
    const css = readCss();

    expect(css).toMatch(
      /__fields\[data-cinder-layout='rows'\]\s*\{[^}]*grid-template-columns: fit-content\(40%\) minmax\(0, 1fr\)/,
    );
    expect(css).toMatch(/> \.cinder-payload-inspector__field\s*\{[^}]*subgrid/);
  });

  test('draws the selected view as a quiet accent tint with accent text', () => {
    const css = readCss();
    const selected =
      /__header \.cinder-segmented-control-option\[data-cinder-selected\][^{]*\{([^}]*)\}/.exec(
        css,
      );

    expect(selected?.[1]).toContain('var(--cinder-accent-text)');
    expect(selected?.[1]).toContain('transparent 88%');
    expect(selected?.[1]).not.toContain('accent-contrast');
  });
});
