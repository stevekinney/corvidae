import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

/** Props for the Citation component. */
export type CitationProps = Omit<HTMLAttributes<HTMLSpanElement>, 'class'> & {
  /** Custom class merged with `.cinder-citation`. */
  class?: string;
  /** The sources behind the claim, in the order to show them. Up to five are listed together; more are paged one at a time. */
  sources: readonly CitationSource[];
  /** Names the marker and the panel, such as `Sources`. The marker reads it with the source count. */
  label?: string;
  /** The words Citation draws itself, for a host that translates them. Each one left out keeps its English default. */
  labels?: CitationLabels | undefined;
  /** Closes an open panel when a previously displayed source is withdrawn by the host. */
  closeOnSourceRemoval?: boolean;
  /** Called after an open source panel or sheet has fully closed. */
  onCloseComplete?: (() => void) | undefined;
  children?: Snippet;
};

/** One source behind a claim. */
export type CitationSource = {
  /** The source's title, clamped to two lines. */
  label: string;
  /** Where the source lives. A safe web address becomes a link; without one, the source reads as an internal document; any other address is never linked. */
  url?: string;
  /** An excerpt from the source, shown in quotation marks under its title. */
  detail?: string;
};

/** The words Citation draws itself. */
export type CitationLabels = {
  /** The link to a source, given its host (`undefined` for a relative address). Defaults to "Open example.com", or "Open source" without a host; an arrow follows it. */
  open?: ((host: string | undefined) => string) | undefined;
  /** The note on a source with no address. Defaults to "Internal document, no public link". */
  noLink?: string | undefined;
  /** The note on a source whose address is not a safe web link. Defaults to "Link hidden: the address isn't a safe web link". */
  unsafeLink?: string | undefined;
  /** The marker's name when there is no source, after `label`. Defaults to "no sources". */
  noSources?: string | undefined;
  /** The pager's previous button. Defaults to "Previous". */
  previous?: string | undefined;
  /** The pager's previous button's accessible name. Defaults to "Previous source". */
  previousSource?: string | undefined;
  /** The pager's next button. Defaults to "Next". */
  next?: string | undefined;
  /** The pager's next button's accessible name. Defaults to "Next source". */
  nextSource?: string | undefined;
  /** The pager's position. Defaults to "2 of 7". */
  position?: ((page: number, total: number) => string) | undefined;
};
