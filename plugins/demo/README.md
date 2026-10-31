# @lostgradient/plugin-demo

An Interborough plugin that gives a fresh host something to try without a model provider. It is off by default: the owner turns it on in Settings, or with `plugins.demo.enabled` in `configuration.json`, and the host picks the change up on its next start.

Everything it contributes answers from a script, so no model is called and no provider key is needed. The Bureau registers each contribution under the plugin's prefix.

- **Agents**: `demo:assistant`, `demo:tool-runner`, `demo:request-human-input`, `demo:echo`, `demo:model-switcher`, and `demo:internal`. `demo:tool-runner` looks an order up, then asks to refund it and stops until an operator approves.
- **Tools**: `demo:lookup-order` (read-only) and `demo:issue-refund` (changes something, so an operator approves each call). An agent file lists them under `tools`.
- **Validators**: `demo:accepts-any-answer` passes every answer, and `demo:never-passes` waits until its goal is cancelled.
- **A goal and a schedule**: the `seeded-goal` goal (it names `demo:accepts-any-answer`) and the `Daily summary` schedule (it runs `demo:assistant`), both created in `afterStart`.

## The approval secret

The plugin declares the Bungalow secret `demo-approval-secret` as `generated`. It signs the approvals `demo:tool-runner` raises. It is the plugin's own secret, not the host's `approval-secret`: the host keeps that one for itself, refuses a plugin that declares it, and never needs the demo's, because the toolbox that raised an approval is the one that verifies it.

- **Local mode**: the host creates the value the first time the plugin is enabled.
- **Remote mode**: the host cannot write the deployment's environment, so the plugin is `needs-setup` and its agents refuse to run until the deployment sets `INTERBOROUGH_SECRET_DEMO_APPROVAL_SECRET`, the same value on every host. A secret saved after the host started applies on the next start, because a plugin composes once.

## The seeded schedule and goal

`afterStart` calls `seedDemo` with the plugin's scoped storage. The schedule's identifier is recorded under `plugin:demo:seeded-schedule`, and every change to that record is a conditional write, so starts that overlap, in one process or in two hosts over one database, create the schedule and the goal once. An operator who renames, edits, or deletes the schedule does not get a second one on the next start. A seeding failure marks the plugin failed and the host keeps running.

`createDemoPlugin({ seedOnStart: false })` builds the plugin without that step, for a test that controls when seeding runs.

## Tests

`src/plugin.test.ts` runs the plugin conformance suite and checks the plugin against a real Bureau. `src/seed-schedule.test.ts` crosses every starting state and failure of the seed with a restart. Refresh the committed identities after a schema change with `bun scripts/check-plugin-identities.ts --write plugins/demo`.
