/**
 * COR-2771: CSS chooses Table's stacked form by a size container query, from rules generated out of
 * `table-stack-rules.ts`. These hold `table.css` to that module, prove no layout waits on the
 * attributes script sets, and check the `<style>` a custom `stackBelow` brings.
 */
import { describe, expect, test } from 'bun:test';

import { declarationsFor } from '@lostgradient/component-tooling/test/css.ts';
import { parse } from 'postcss';

import {
  CARD_STACK_BELOW,
  CONTROL_STACK_BELOW,
  stackStyle,
  stylesheetCoversLength,
  stylesheetStackRules,
} from './table-stack-rules.ts';
import { containerRules, DEFAULT_QUERIES, stackDeclarations } from './table-stack.test-support.ts';

const tableCss = await Bun.file(new URL('./table.css', import.meta.url)).text();
const dataTableCss = await Bun.file(
  new URL('../data-table/data-table.css', import.meta.url),
).text();

describe('Table stacked forms in CSS', () => {
  test('table.css holds exactly the rules table-stack-rules.ts generates', () => {
    const generated = containerRules(stylesheetStackRules());
    expect(generated.length).toBeGreaterThan(40);
    expect(containerRules(tableCss)).toEqual(generated);
  });

  test('no layout declaration waits on the attributes script sets', () => {
    for (const css of [tableCss, dataTableCss]) {
      const gated: string[] = [];
      parse(css).walkRules((rule) => {
        if (/\[data-cinder-(stacked|stack-card)\]/.test(rule.selector)) gated.push(rule.selector);
      });
      expect(gated).toEqual([]);
    }
  });

  test('the size container is the table container, for a table that can stack', () => {
    const container = declarationsFor(
      tableCss,
      ".cinder-table-container:is( [data-cinder-fit], :has(.cinder-table__cell[data-cinder-controls]) ):not([data-cinder-stack-below='false'])",
    );
    expect(container.get('container')).toBe('cinder-table / inline-size');
  });

  test('the defaults stay 26rem for flat rows and 640px for the control layout', () => {
    expect(CARD_STACK_BELOW).toBe('26rem');
    expect(CONTROL_STACK_BELOW).toBe('640px');
    const queries = new Set(containerRules(tableCss).map(([query]) => query));
    expect(queries).toEqual(new Set([DEFAULT_QUERIES.card, DEFAULT_QUERIES.control]));
    // The card form hides the header and draws flat rows; the control layout stacks the controls.
    expect(stackDeclarations(tableCss, 'card', ' > .cinder-table__header').get('clip-path')).toBe(
      'inset(50%)',
    );
    expect(
      stackDeclarations(tableCss, 'card', ' .cinder-table__body .cinder-table__row').get('display'),
    ).toBe('grid');
    expect(
      stackDeclarations(
        tableCss,
        'control',
        ' .cinder-table__body .cinder-table__cell[data-cinder-controls]',
      ).get('min-block-size'),
    ).toBe('2.75rem');
  });

  test('the column labels print from the server-rendered attribute', () => {
    expect(
      stackDeclarations(
        tableCss,
        'card',
        ' .cinder-table__body .cinder-table__cell[data-cinder-stack-label]::before',
      ).get('content'),
    ).toBe('attr(data-cinder-stack-label)');
  });
});

describe('Table stackStyle for another stackBelow', () => {
  test.each(['480px', '20rem'])('keys the rules to %s, in the component layer', (length) => {
    const css = stackStyle(length);
    const layers: string[] = [];
    parse(css).walkAtRules('layer', (rule) => void layers.push(rule.params));
    expect(layers).toEqual(['cinder.components']);
    const queries = new Set(containerRules(css).map(([query]) => query));
    expect(queries).toEqual(new Set([`cinder-table not (min-width: ${length})`]));
    for (const [, , selector] of containerRules(css)) {
      expect(selector).toContain(`[data-cinder-stack-below='${length}']`);
    }
    // Server rendering escapes `<` in a style element's text, so the CSS has none.
    expect(css).not.toContain('<');
  });

  test('table.css already covers 640px, DataTable default; any other length is a style', () => {
    expect(stylesheetCoversLength('640px')).toBe(true);
    expect(stylesheetCoversLength('480px')).toBe(false);
    const stylesheet = containerRules(tableCss).filter(([, , selector]) =>
      selector.includes("[data-cinder-stack-below='640px']"),
    );
    expect(stylesheet).toEqual(containerRules(stackStyle('640px')));
  });
});
