/**
 * Type-equality test pinning the public Text prop surface so future edits
 * don't silently drift it.
 */

import { expect, test } from 'bun:test';
import type { ComponentProps, Snippet } from 'svelte';

import Text from './text.svelte';
import type { TextElement, TextProps, TextVariant } from './text.types.ts';

type SnapshotTextProps = {
  variant?: TextVariant;
  as?: TextElement;
  class?: string;
  children: Snippet;
};

type Assignable<A, B> = A extends B ? true : false;

const aliasForward: Assignable<SnapshotTextProps, TextProps> = true;
const componentAcceptsSnapshot: Assignable<SnapshotTextProps, ComponentProps<typeof Text>> = true;
const componentAcceptsMinimalRequired: Assignable<
  { children: Snippet },
  ComponentProps<typeof Text>
> = true;

// `as` must exclude metadata and other non-content tags.
const styleExcluded: [TextElement] extends ['style'] ? true : 'style' extends TextElement ? true : false =
  false;
const sectionAllowed: ['section' | 'span' | 'h2'] extends [TextElement] ? true : false = true;

test('Text public prop surface unchanged', () => {
  expect(aliasForward).toBe(true);
  expect(componentAcceptsSnapshot).toBe(true);
  expect(componentAcceptsMinimalRequired).toBe(true);
  expect(styleExcluded).toBe(false);
  expect(sectionAllowed).toBe(true);
});
