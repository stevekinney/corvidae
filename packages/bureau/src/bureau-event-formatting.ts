/**
 * Turns a Bureau event into the line a person reads (COR-1876). A plugin contributes formatters
 * for the event kinds it knows (`PluginFormatter`); an event no formatter claims is shown by
 * its raw kind, with the run it names so the view can still link to it.
 *
 * A formatter formats from the event alone, synchronously, and what it returns is bounded
 * (COR-2221): a `title` is one line of at most {@link FORMATTED_TITLE_LIMIT} characters (its
 * newlines become spaces) and a `body` at most {@link FORMATTED_BODY_LIMIT}; a longer one is cut,
 * never refused, and a `body` that is not a string is dropped with a `warn` diagnostic.
 *
 * Each kind has at most one formatter. Two that claim the same kind are refused when the
 * formatters are registered, so the sentence a kind gets never depends on registration order.
 *
 * @module bureau-event-formatting
 */

import type { PluginEvent, PluginFormatter } from '@lostgradient/interborough-plugin';

import { runOfPayload } from './hooks/hook-origin.ts';

/** An event formatter a plugin contributes, with the plugin that contributes it. */
export interface EventFormatterRegistration {
  /** The plugin's name. */
  readonly plugin: string;
  /** The formatter itself. */
  readonly formatter: PluginFormatter;
}

/** An event as a person reads it. */
export interface FormattedBureauEvent {
  /** The event's kind, always the raw one. */
  readonly kind: string;
  /** One line naming what happened: a formatter's sentence, or the raw kind when none claims it. */
  readonly title: string;
  /** More detail, when the formatter gave some. */
  readonly body?: string;
  /** The run the event is about, so the view can link to it; absent when the payload names none. */
  readonly runId?: string;
  /** The plugin whose contribution emitted the event; absent for an event from Bureau core. */
  readonly source?: string;
  /** `<plugin>/<formatter>` when a contributed formatter wrote the title; absent for the raw fallback. */
  readonly formattedBy?: string;
}

/** The longest `title` a formatter's output keeps, in characters; a longer one is cut (COR-2221). */
export const FORMATTED_TITLE_LIMIT = 200;

/** The longest `body` a formatter's output keeps, in characters; a longer one is cut (COR-2221). */
export const FORMATTED_BODY_LIMIT = 2000;

/** A line break: CRLF, CR, LF, and the Unicode line and paragraph separators. */
const LINE_BREAKS = /\r\n|[\r\n\p{Zl}\p{Zp}]/gu;

/** Cuts `text` to `limit` characters without leaving half of a surrogate pair behind. */
function truncated(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const last = text.charCodeAt(limit - 1);
  const isHighSurrogate = last >= 0xd800 && last <= 0xdbff;
  return text.slice(0, isHighSurrogate ? limit - 1 : limit);
}

/** Formats events with the formatters it was built from. */
export type BureauEventFormatter = (event: PluginEvent) => FormattedBureauEvent;

function recordOf(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

/**
 * Builds the formatter over `registrations`. A formatter that throws, or answers with no usable
 * title, is reported to `diagnose` and the event is shown raw: a broken plugin never hides an event.
 * Throws when two formatters claim one event kind.
 */
export function createBureauEventFormatter(
  registrations: readonly EventFormatterRegistration[] | undefined,
  diagnose?: (message: string, cause?: unknown) => void,
): BureauEventFormatter {
  const byKind = new Map<string, EventFormatterRegistration>();
  for (const registration of registrations ?? []) {
    for (const kind of registration.formatter.eventKinds) {
      const claimed = byKind.get(kind);
      if (claimed !== undefined) {
        throw new Error(
          `Event kind "${kind}" is formatted by both "${claimed.plugin}/${claimed.formatter.name}" and "${registration.plugin}/${registration.formatter.name}"`,
        );
      }
      byKind.set(kind, registration);
    }
  }

  return (event) => {
    const runId = runOfPayload(recordOf(event.payload));
    const common = {
      kind: event.kind,
      ...(runId === undefined ? {} : { runId }),
      ...(event.source === undefined ? {} : { source: event.source }),
    };
    const registration = byKind.get(event.kind);
    if (registration !== undefined) {
      const name = `${registration.plugin}/${registration.formatter.name}`;
      try {
        const formatting = registration.formatter.format(event);
        if (typeof formatting.title === 'string' && formatting.title.length > 0) {
          // A body that is not a string is dropped, and says so: the title still stands.
          if (formatting.body !== undefined && typeof formatting.body !== 'string') {
            diagnose?.(
              `Event formatter "${name}" returned a body that is not a string for "${event.kind}"`,
            );
          }
          return {
            ...common,
            title: truncated(formatting.title.replaceAll(LINE_BREAKS, ' '), FORMATTED_TITLE_LIMIT),
            ...(typeof formatting.body === 'string'
              ? { body: truncated(formatting.body, FORMATTED_BODY_LIMIT) }
              : {}),
            formattedBy: name,
          };
        }
        diagnose?.(`Event formatter "${name}" returned no title for "${event.kind}"`);
      } catch (cause) {
        diagnose?.(`Event formatter "${name}" failed on "${event.kind}"`, cause);
      }
    }
    return { ...common, title: event.kind };
  };
}
