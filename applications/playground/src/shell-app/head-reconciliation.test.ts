/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';

import { headResourceKey, planHeadReconciliation } from './head-reconciliation.ts';

function headOf(markup: string): Element[] {
  const document = window.document.implementation.createHTMLDocument('page');
  document.head.innerHTML = markup;
  return [...document.head.children];
}

const base = 'https://cinder.website/page/button';

describe('headResourceKey', () => {
  test('identifies stylesheets by resolved URL and styles by text', () => {
    const [link, style] = headOf(
      '<link rel="stylesheet" href="/playground-styles/documentation.css" /><style>.a{color:red}</style>',
    );
    expect(headResourceKey(link!, base)).toBe(
      'link:https://cinder.website/playground-styles/documentation.css',
    );
    expect(headResourceKey(style!, base)).toBe('style:.a{color:red}');
  });

  test('leaves every other head element alone', () => {
    const elements = headOf(
      '<meta charset="UTF-8" /><title>x</title><link rel="icon" href="/x.ico" /><script>1</script><style> </style>',
    );
    for (const element of elements) expect(headResourceKey(element, base)).toBeNull();
  });
});

describe('planHeadReconciliation', () => {
  test('adds what the target needs and removes what only the old page used', () => {
    const plan = planHeadReconciliation(
      ['link:shared', 'link:chat', 'style:chat'],
      ['link:shared', 'link:button'],
    );
    expect(plan).toEqual({ add: ['link:button'], remove: ['link:chat', 'style:chat'] });
  });

  test('keeps a shared resource in place and plans nothing for identical heads', () => {
    expect(planHeadReconciliation(['link:shared'], ['link:shared'])).toEqual({
      add: [],
      remove: [],
    });
  });

  test('adds in target order and ignores duplicates', () => {
    expect(planHeadReconciliation([], ['b', 'a', 'b'])).toEqual({ add: ['b', 'a'], remove: [] });
  });
});
