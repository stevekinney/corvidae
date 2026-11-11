import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

/** One typed fact: an optional icon, a value and an optional link. */
export type KeyFact = {
  /** The fact as text, such as "LoDo" or "$$". It is never split across lines. */
  value: string;
  /** Decorative icon drawn before the value. It is hidden from assistive technology; name the fact's kind with `label` instead. */
  icon?: Snippet;
  /** What kind of fact this is, such as "Neighborhood". It is read before the value by assistive technology and never drawn. */
  label?: string;
  /** Makes the value a link to this address. */
  href?: string;
};

/** Props for the KeyFacts component. */
export type KeyFactsProps = Omit<HTMLAttributes<HTMLUListElement>, 'class'> & {
  /** The facts in reading order. A fact wraps to the next line as a whole, and no separator glyph is drawn between facts. */
  items: KeyFact[];
  /** Accessible name of the list, such as "Details". Left unset, the list is unnamed. */
  label?: string;
  /** Custom class merged with `.cinder-key-facts`. */
  class?: string;
};
