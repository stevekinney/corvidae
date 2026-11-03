import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

import type {
  TimelineEntryKind,
  TimelineHeadingLevel,
  TimelineTone,
} from '../timeline/timeline.types.ts';

/**
 * One entry in a Timeline. Renders a marker (dot or icon) on the rail
 * with the item content beside it.
 */
export type TimelineItemProps = Omit<HTMLAttributes<HTMLLIElement>, 'class' | 'children'> & {
  /** Machine-readable ISO datetime rendered into `<time datetime>`. */
  datetime: string;
  /** Visible timestamp label rendered inside `<time>`. */
  timestamp: string;
  /** Visible event title. */
  title: string;
  /** Semantic marker tone. `pending` is a hollow neutral ring. @default "info" */
  tone?: TimelineTone | undefined;
  /** What the item is: an event row, the `now` marker, a labelled `separator` or a collapsed `band`. @default "event" */
  kind?: TimelineEntryKind | undefined;
  /** For a `band`: the muted text after the title. */
  detail?: string | undefined;
  /** For a `band`: the text of the button that opens it. @default "Show" */
  expandLabel?: string | undefined;
  /** For a `band`: the text of the button that closes it. @default "Hide" */
  collapseLabel?: string | undefined;
  /** Whether to draw the connector to the following event. @default "visible" */
  connectorAfter?: 'visible' | 'hidden' | undefined;
  /** Optional adjacent group heading rendered inside this list item before the event body. */
  groupHeader?: string | undefined;
  /** Heading level applied when `groupHeader` is rendered. @default 3 */
  groupHeaderLevel?: TimelineHeadingLevel | undefined;
  /** Additional class names merged with `.cinder-timeline-item`. */
  class?: string | undefined;
  /** Item body content. For a `band`, the details it opens. */
  children?: Snippet | undefined;
  /** Decorative custom marker glyph. Must not contain interactive descendants. */
  marker?: Snippet | undefined;
  /** Controls drawn at the inline end of an event's row. Interactive; not drawn for `now` or `separator`. */
  actions?: Snippet | undefined;
};

/** Schema generator surface for TimelineItem — excludes snippet props. */
export interface TimelineItemSchemaProps {
  /** Machine-readable ISO datetime rendered into `<time datetime>`. */
  datetime: string;
  /** Visible timestamp label rendered inside `<time>`. */
  timestamp: string;
  /** Visible event title. */
  title: string;
  /** Semantic marker tone. `pending` is a hollow neutral ring. @default "info" */
  tone?: TimelineTone | undefined;
  /** What the item is: an event row, the `now` marker, a labelled `separator` or a collapsed `band`. @default "event" */
  kind?: TimelineEntryKind | undefined;
  /** For a `band`: the muted text after the title. */
  detail?: string | undefined;
  /** For a `band`: the text of the button that opens it. @default "Show" */
  expandLabel?: string | undefined;
  /** For a `band`: the text of the button that closes it. @default "Hide" */
  collapseLabel?: string | undefined;
  /** Whether to draw the connector to the following event. @default "visible" */
  connectorAfter?: 'visible' | 'hidden' | undefined;
  /** Optional adjacent group heading rendered inside this list item before the event body. */
  groupHeader?: string | undefined;
  /** Heading level applied when `groupHeader` is rendered. @default 3 */
  groupHeaderLevel?: TimelineHeadingLevel | undefined;
  /** Additional class names merged with `.cinder-timeline-item`. */
  class?: string | undefined;
}
