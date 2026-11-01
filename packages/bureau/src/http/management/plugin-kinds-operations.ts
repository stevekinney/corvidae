/**
 * `bureau.plugins.kinds` and `bureau.events.format` (COR-1893): the two reads a client needs to
 * show what running plugins contribute to workflows and hooks.
 *
 * - `bureau.plugins.kinds` lists the trigger kinds a workflow file's trigger can name besides
 *   `schedule` and `signal`, and the hook action kinds a hook's `{ type: 'plugin' }` action can
 *   name, each with what it does and the fields its configuration takes as JSON Schema. A client
 *   draws the fields from it and writes the configuration back as the file or the hook holds it.
 * - `bureau.events.format` is an event as a person reads it (`Bureau.formatEvent`): a contributed
 *   formatter's sentence for its kind, or the raw kind when none claims it.
 *
 * Both are read-only and any authenticated caller may read them: they return what plugins declare,
 * never state, and `format` only describes the events the caller already holds.
 *
 * @module plugin-kinds-operations
 */

import { defineOperation } from '@lostgradient/weft';
import { z } from 'zod';

import type { BureauEventFormatter } from '../../bureau-event-formatting.ts';
import type { BureauPlugins } from '../../plugins/plugin-types.ts';
import { unaryTransports as transports, unknownKeyPolicy } from './management-schemas.ts';

/** What `bureau.plugins.kinds` reads from the handler's `host`. */
export type BureauPluginKindsOperationHost = {
  readonly plugins: Pick<BureauPlugins, 'triggerKinds' | 'hookActionKinds'>;
};

/** What `bureau.events.format` reads from the handler's `host`. */
export type BureauEventFormatOperationHost = {
  readonly formatEvent: BureauEventFormatter;
};

const configurationSchema = z
  .record(z.string(), z.unknown())
  .nullable()
  .describe(
    'The fields the kind’s configuration takes, as JSON Schema; `null` when the schema cannot be written as one.',
  );

const kindsInput = z.object({});

const kindsOutput = z.object({
  triggerKinds: z
    .array(
      z.object({
        plugin: z.string().describe('The contributing plugin.'),
        id: z.string().describe('`plugin:name`, the `kind` a workflow file’s `trigger` names.'),
        description: z.string().describe('What the trigger listens for.'),
        version: z.string().describe('The version a workflow revision that uses it pins.'),
        configuration: configurationSchema,
      }),
    )
    .describe('The trigger kinds of the running plugins, in load order.'),
  hookActionKinds: z
    .array(
      z.object({
        plugin: z.string().describe('The contributing plugin: the `plugin` of the action.'),
        kind: z.string().describe('The kind’s name within the plugin: the `kind` of the action.'),
        description: z.string().describe('What the action does.'),
        version: z.string().describe('The version a delivery of the kind pins.'),
        configuration: configurationSchema,
      }),
    )
    .describe(
      'The hook action kinds of the running plugins, in load order. Empty when the Bureau composes no hooks.',
    ),
});

/** `bureau.plugins.kinds`. */
export const pluginKindsOperation = defineOperation<
  typeof kindsInput,
  typeof kindsOutput,
  BureauPluginKindsOperationHost
>({
  name: 'bureau.plugins.kinds',
  mcpExposable: false,
  summary: 'List the trigger and hook action kinds plugins contribute',
  description:
    'Lists the trigger kinds a workflow file’s trigger can name besides `schedule` and `signal` (`id` is `plugin:name`) and the hook action kinds a hook’s `{ type: "plugin" }` action can name (`plugin` and `kind`), for the plugins that are running. Each has a `description`, the `version` a record that uses it pins, and its `configuration` as JSON Schema (the fields a trigger holds besides `kind`, or an action’s `configuration`), or `null` when the schema cannot be written as one. Read-only; any authenticated caller may read it.',
  destructive: false,
  tags: ['Plugins'],
  inputSchema: kindsInput,
  outputSchema: kindsOutput,
  producibleFaults: [],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: ({ host }) =>
    Promise.resolve({
      triggerKinds: host.plugins.triggerKinds().map((kind) => ({ ...kind })),
      hookActionKinds: host.plugins.hookActionKinds().map((kind) => ({ ...kind })),
    }),
});

/** The most events one `bureau.events.format` call formats. */
export const MAXIMUM_EVENTS_TO_FORMAT = 200;

const formatInput = z.object({
  events: z
    .array(
      z
        .strictObject({
          kind: z.string().min(1).max(256).describe('The event’s kind.'),
          bureauId: z.string().min(1).max(256).describe('The Bureau that published it.'),
          emittedAtMs: z.number().describe('When it was published, in epoch milliseconds.'),
          payload: z.unknown().describe('The event’s payload, required: a formatter reads it.'),
          source: z
            .string()
            .max(256)
            .optional()
            .describe('The plugin that caused the event, from the envelope’s `source`.'),
        })
        .refine((event) => Object.hasOwn(event, 'payload'), {
          error: 'An event to format carries its payload.',
          path: ['payload'],
        }),
    )
    .max(MAXIMUM_EVENTS_TO_FORMAT)
    .describe('The events to format, as `bureau.events` delivered them.'),
});

const formatOutput = z.object({
  events: z
    .array(
      z.object({
        kind: z.string().describe('The event’s kind, always the raw one.'),
        title: z
          .string()
          .describe('One line naming what happened: a formatter’s sentence, or the raw kind.'),
        body: z.string().optional().describe('More detail, when the formatter gave some.'),
        runId: z
          .string()
          .optional()
          .describe('The run the event is about, when its payload names one.'),
        source: z.string().optional().describe('The plugin whose contribution emitted the event.'),
        formattedBy: z
          .string()
          .optional()
          .describe('`<plugin>/<formatter>` when a contributed formatter wrote the title.'),
      }),
    )
    .describe('One entry per input event, in order.'),
});

/** `bureau.events.format`. */
export const eventsFormatOperation = defineOperation<
  typeof formatInput,
  typeof formatOutput,
  BureauEventFormatOperationHost
>({
  name: 'bureau.events.format',
  mcpExposable: false,
  summary: 'Format events as a person reads them',
  description:
    'Formats each event of `events`, in order. Each event is complete, as `bureau.events` delivered it (`kind`, `bureauId`, `emittedAtMs`, `payload`), and an incomplete one is refused, because a formatter would write its sentence from fields that were never there. The result is the sentence a plugin’s event formatter writes for its kind (`title`, `body`, and `formattedBy`, `<plugin>/<formatter>`), or the raw kind as the `title` for an event no formatter claims. `runId` is the run the payload names, so a view can link to it, and `source` is the plugin that caused the event. A formatter that fails is reported to the Bureau’s diagnostics and its event is shown raw. At most 200 events per call. Read-only; any authenticated caller may read it.',
  destructive: false,
  tags: ['Events'],
  inputSchema: formatInput,
  outputSchema: formatOutput,
  producibleFaults: [],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: ({ host, input }) =>
    Promise.resolve({
      events: input.events.map((event) => {
        const formatted = host.formatEvent({
          kind: event.kind,
          bureauId: event.bureauId,
          emittedAtMs: event.emittedAtMs,
          payload: event.payload,
          ...(event.source === undefined ? {} : { source: event.source }),
        });
        return { ...formatted };
      }),
    }),
});
