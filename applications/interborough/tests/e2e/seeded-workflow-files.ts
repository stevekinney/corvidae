/**
 * The workflow files `e2e-server.ts` writes into the host's temporary home before it starts
 * (`26-workflows.spec.ts`), by file name without `.json`. Their identifiers are
 * `SEEDED_WORKFLOWS` in `workflow-support.ts`.
 */
export const SEEDED_WORKFLOW_FILES = {
  // Loads, names the seeded `assistant`, and is started by a schedule that will not fire for a day.
  'e2e-digest': {
    name: 'e2e-digest',
    description: 'Writes the daily digest.',
    agent: 'demo:assistant',
    trigger: { kind: 'schedule', spec: '24h' },
    steps: [
      {
        kind: 'activity',
        handler: 'agent',
        input: { agent: 'demo:assistant', message: 'Write the digest.' },
      },
      { kind: 'sleep', duration: '1m' },
    ],
  },
  // Loads. The signal `e2e-begin` starts an instance, whose one step waits for `e2e-approve`.
  'e2e-approval': {
    name: 'e2e-approval',
    agent: 'demo:assistant',
    trigger: { kind: 'signal', name: 'e2e-begin' },
    steps: [{ kind: 'await-signal', signal: 'e2e-approve' }],
  },
  // A schedule the Bureau cannot parse, so the file is invalid and is never registered.
  'e2e-broken': {
    name: 'e2e-broken',
    trigger: { kind: 'schedule', spec: 'not a schedule' },
    steps: [],
  },
} as const;
