/**
 * The demo plugin's code workflow. The Bureau registers it as `demo:echo-input`.
 *
 * @module workflows
 */

import type { PluginWorkflow } from '@lostgradient/interborough-plugin';
import { workflow } from '@lostgradient/weft';
import { z } from 'zod';

/** The workflow's name inside the plugin, without the `demo:` prefix. */
export const ECHO_WORKFLOW_NAME = 'echo-input';

/** What a start gives the workflow. */
export const echoInputSchema = z.object({ message: z.string().default('hello') });

/**
 * One code workflow that completes at once with the message it was started with, so a fresh host
 * lists a code workflow beside the workflow files without a model or an activity. The host starts
 * it on the same envelope a workflow file's run starts on, so the message is the envelope's
 * `input`.
 */
export function createDemoWorkflows(): PluginWorkflow[] {
  const echo = workflow({ name: ECHO_WORKFLOW_NAME }).execute(async function* (
    _context,
    envelope: { readonly input?: { readonly message?: string } },
  ) {
    // A workflow body is a generator; this one has nothing to wait for, so it delegates to nothing.
    yield* [];
    return { message: envelope.input?.message ?? 'hello' };
  });
  return [{ ...echo, title: 'Echo the input', inputSchema: echoInputSchema } as PluginWorkflow];
}
