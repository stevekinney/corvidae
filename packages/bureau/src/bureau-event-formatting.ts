/**
 * Turns a Bureau event into the line a person reads (COR-1876). A plugin contributes formatters
 * for the event kinds it knows (`PluginEventFormatter`); an event no formatter claims is shown by
 * its raw kind, with the run it names so the view can still link to it.
 *
 * Each kind has at most one formatter. Two that claim the same kind are refused when the
 * formatters are registered, so the sentence a kind gets never depends on registration order.
 *
 * @module bureau-event-formatting
 */

import type { PluginEvent, PluginEventFormatter } from '@lostgradient/interborough-plugin';

import { runOfPayload } from './hooks/hook-origin.ts';

/** An event formatter a plugin contributes, with the plugin that contributes it. */
export interface EventFormatterRegistration {
  /** The plugin's name. */
  readonly plugin: string;
  /** The formatter itself. */
  readonly formatter: PluginEventFormatter;
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
          return {
            ...common,
            title: formatting.title,
            ...(typeof formatting.body === 'string' ? { body: formatting.body } : {}),
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
