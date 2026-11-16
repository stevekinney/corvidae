/**
 * COR-2165 — how a trigger kind that is not the supervisor's own tells it what its listener is
 * doing. The secret gate wraps a kind whose plugin declares a secret: its `start` resolves while it
 * waits for the secret, and starts and stops the plugin's own listener as the secret is saved and
 * removed. The supervisor cannot see any of that from `start`'s result, so the gate reports it
 * against the context the supervisor handed `start`, the way `assertWorkflowAvailable` finds the
 * check a gated workflow carries: a `WeakMap` keyed by the context object, so neither side holds
 * the other and a context the supervisor did not register reports nowhere.
 *
 * @module workflow-trigger-reports
 */

import type { PluginTriggerContext } from '@lostgradient/interborough-plugin';

/** What a gated kind reports about the listener it keeps for one workflow file. */
export type ListenerReport =
  | {
      /** A declared secret is missing, so the plugin's own listener is not running. */
      readonly state: 'waiting-for-secret';
    }
  | {
      /** The plugin's own listener is running. */
      readonly state: 'listening';
    }
  | {
      /**
       * The plugin's own `start` threw after the first transition. The supervisor stops the kind's
       * listener and treats this as a `start` that threw.
       */
      readonly state: 'failed';
      /** What `start` threw. */
      readonly error: unknown;
    };

/** Receives the reports of one listener. It never awaits, and never throws. */
export type ListenerReporter = (report: ListenerReport) => void;

const reporters = new WeakMap<PluginTriggerContext, ListenerReporter>();

/** Registers `reporter` for the listener started with `context`. */
export function listenForReports(context: PluginTriggerContext, reporter: ListenerReporter): void {
  reporters.set(context, reporter);
}

/**
 * Tells the supervisor what the listener started with `context` is doing; does nothing for a
 * context no supervisor registered. Returns at once: the supervisor handles the report in the same
 * turn and never waits on the kind, because the kind may be reporting from inside its own queue.
 */
export function reportListener(context: PluginTriggerContext, report: ListenerReport): void {
  reporters.get(context)?.(report);
}
