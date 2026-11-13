import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

/** Props for the Citation component. */
export type CitationProps = Omit<HTMLAttributes<HTMLSpanElement>, 'class'> & {
  /** Custom class merged with `.cinder-citation`. */
  class?: string;
  /** The sources behind the claim, in the order to show them. Every source is one row of one list, however many there are. */
  sources: readonly CitationSource[];
  /** Names the marker and the panel, such as `Sources`. The marker reads it with the source count. */
  label?: string;
  /** The words Citation draws itself, for a host that translates them. Each one left out keeps its English default. */
  labels?: CitationLabels | undefined;
  /** The index in `sources` of the source the reader followed a marker for. Its row is marked as the current one, and the list opens scrolled to it. */
  current?: number | undefined;
  /** Opens the sources under the marker instead of in a floating popover, on a viewport at least as wide as a phone. On a phone they still open in the bottom sheet. */
  inPlace?: boolean;
  /** With `inPlace`, whether the sources are open under the marker. Bindable; the marker toggles it. */
  expanded?: boolean | undefined;
  /** With `inPlace`, called after the marker toggles `expanded`, with the new value. */
  onExpandedChange?: ((expanded: boolean) => void) | undefined;
  /** Reports whether the sources are shown under the marker (`inPlace` on a wide viewport) or in the sheet or popover. Bindable, read only. */
  shownInPlace?: boolean | undefined;
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
  /** Where the source lives. A safe web address makes the whole row a link; without one, the source reads as an internal document; any other address is never linked. */
  url?: string;
  /** An excerpt from the source, shown in quotation marks under its title. */
  detail?: string;
};

/** The words Citation draws itself. */
export type CitationLabels = {
  /** The note on a source with no address. Defaults to "Internal document, no public link". */
  noLink?: string | undefined;
  /** The note on a source whose address is not a safe web link. Defaults to "Link hidden: the address isn't a safe web link". */
  unsafeLink?: string | undefined;
  /** The marker's name when there is no source, after `label`. Defaults to "no sources". */
  noSources?: string | undefined;
};
