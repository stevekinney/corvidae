# Workflow files

Bureau loads agent-authored workflows from JSON files in a directory the host names (COR-1527). You create and edit a workflow by hand, or through `bureau.workflows.create`, `update`, `pause`, `resume`, and `delete`; either way the workflow is a file. It follows the same rules as [agent files](agent-files.md): one file per workflow, the filename is the identifier, a file that cannot be used is listed and never runs, changes take effect without a restart, and a run keeps the revision it began on.

Bureau does not know where the directory lives. The host passes a workflow source (`BureauOptions.workflowSource`), usually `workflowFileDirectory(path)` from `@lostgradient/bureau/sources`, and the Interborough host passes `workflows/` under its home. A directory that does not exist is an empty one. `workflowSource` needs a durable engine, because a schedule and an instance both persist; without one `createBureau` refuses it with `BureauError` (`BAD_REQUEST`).

## A file

```json
{
  "name": "nightly-digest",
  "description": "Writes and edits the morning digest.",
  "agent": "writer",
  "paused": false,
  "trigger": { "kind": "schedule", "spec": "0 6 * * *", "overlap": "skip" },
  "steps": [
    {
      "kind": "activity",
      "handler": "agent",
      "input": { "agent": "writer", "message": "Write the digest." }
    },
    { "kind": "sleep", "duration": "5m" },
    {
      "kind": "activity",
      "handler": "agent",
      "input": { "agent": "editor", "message": "Edit it." }
    }
  ]
}
```

The file is Weft's workflow document (`packages/weft/src/document-workflow`) plus three Bureau fields, and nothing else: an unknown key makes the file `invalid`, because the document schema is strict.

- `name`: must equal the identifier. The filename without `.json` is the identifier, so this file is `nightly-digest.json`. An identifier matches `^[a-z](?:[a-z0-9-]*[a-z0-9])?$` and is at most 64 characters, because Bureau derives ids from it that must stay inside Weft's 128.
- `description`: optional. A sentence on what the workflow is for: a non-empty string of at most 280 characters, shown beside the workflow in lists. A description of another type, an empty one, or a longer one makes the file `invalid`.
- `agent`: optional. The identifier of the agent that wrote the file. It is only recorded; it is not checked against the agent catalog, so deleting that agent leaves the workflow valid.
- `paused`: optional boolean, default `false`. A paused workflow starts nothing new. See [Pausing and deleting](#pausing-and-deleting).
- `trigger`: `{ kind: 'schedule', spec, overlap? }` or `{ kind: 'signal', name }`. `spec` is a cron expression (five or six fields) or a duration such as `1h` or `30 seconds`, exactly as `DurableScheduleDefinition.spec` accepts. `overlap` is `skip` (the default), `queue`, `cancel-running`, or `allow`. `name` is a non-empty string of at most 256 characters, the longest signal name `bureau.workflows.signal` admits. Any other field, a malformed `spec`, a missing, empty, or longer `name`, or any other `kind` makes the file `invalid`. See [Signals](#signals).
- `steps`: Weft's steps, run in order: `activity`, `sleep`, and `await-signal`. The only activity is `agent`.

Only files ending exactly in `.json` count: dotfiles, `.JSON`, other extensions, and directories are ignored. A symbolic link to a file is followed. A file larger than 256 KiB is invalid. `description`, `agent`, and `paused` are stripped before the document is handed to Weft, so none is part of a revision.

## What is invalid

A file that cannot be used is listed by `bureau.workflows.list()` with `state: 'invalid'` and a `problem` whose `code` says why. It is never registered, it has no schedule, and it never affects another workflow.

- `invalid-identifier`: the filename is not a valid identifier.
- `invalid-json`: the text is not one JSON object.
- `invalid-document`: a schema failure; `problem.issues` lists every one. This includes a `name` that is not the identifier, an unknown key, a badly typed `agent` or `paused`, an unregistered trigger kind or handler, and an `agent` step whose `input` is not exactly `{ agent, message }`.
- `shadows-code-workflow`: the identifier is a workflow the engine already has from code. Code always wins.
- `file-too-large`, `not-utf8`, and `unreadable`.

## The `agent` step

`{ kind: 'activity', handler: 'agent', input: { agent, message } }` runs one agent and returns its result. `agent` is the identifier of a ready file agent or the key of a code-defined agent.

- **The run.** The step starts one standalone durable run of the agent as the deployment's owner of record (`anonymous:local` in single-user mode). It is a catalog run, not a session run: it creates no session, it is not a task, `bureau.tasks.list` never shows it, and boot reconciliation skips it. You follow a workflow's work through `bureau.workflows.runs.*`.
- **The message.** The run's user message is `message`, followed by one fenced JSON block for each of the instance's `trigger` and the `previous` step's result that is present and not `null`, in that order. Each block follows a blank line and a label line, `Trigger:` or `Previous step:`, and holds the value as `JSON.stringify(value, null, 2)` in a three-backtick fence that is lengthened when the JSON itself holds a run of backticks. When neither is present, the message is `message` unchanged.
- **The result.** The step returns `{ content, output, finishReason }`: the final assistant text, the structured output (or `null`), and the finish reason. That value is `previous` for the next step. After a `sleep` it is `null`, and after an `await-signal` it is the signal's payload.
- **Failure.** An agent that does not exist, a run that fails (`error`, `tripwire`, `maximum-steps`, `elicitation-denied`, or `budget-exceeded`), and a run that is aborted each fail the step, and so the instance. Documents carry no per-step retry. `bureau.workflows.runs.get` returns the instance's `error`, which names the agent and the finish reason.
- **After a restart.** The step's run has an id that is a function of the instance and the step (`workflow-agent-` and a hash), so a step that a restart runs again finds its own run: if the engine already holds it (boot recovery is resuming it) the step waits for that run, and only a step with no run yet starts one. The step adopts a run at its id only when that run's recovery record carries the step's own marker (the instance, the step, the agent, and the owner); a run of anything else at that id fails the step. Under `maintenance: 'manual'` the step waits on the engine's own handle for the run, which `maintain()` drives, instead of `waitForDurableRun`, which refuses to wait in that mode. A graceful `shutdown()` and a new Bureau resumes parked and in-flight instances the same way: recovery skips the instances of workflow files rather than reading them as foreign runs. A kill between claiming the run's recovery record and starting it is covered the same way.

## Wiring it in

```ts
import { createBureau } from '@lostgradient/bureau';
import { agentFileDirectory, workflowFileDirectory } from '@lostgradient/bureau/sources';
import type { BackendDescriptor, GenerateFunction, StandaloneAgent } from '@lostgradient/operative';
import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';

declare const writer: StandaloneAgent;
declare function generateFor(descriptor: BackendDescriptor): GenerateFunction;

const bureau = await createBureau({
  agents: { writer },
  agentSource: agentFileDirectory('/home/me/.interborough/agents'),
  workflowSource: workflowFileDirectory('/home/me/.interborough/workflows'),
  storage: new BunSQLiteStorage('/home/me/.interborough/bureau.sqlite'),
  durable: true,
  models: { generate: generateFor },
});
```

Bureau registers the workflows before the engine recovers, and starts the engine's scheduler only after that, so a schedule that is due the moment the process starts cannot fire a workflow type Weft does not have yet. A Bureau with no `workflowSource` starts its scheduler exactly as it always did. `bureau.workflows` is `undefined` for a Bureau with no workflow source.

## Watching

`workflowFileDirectory(path, { watch?, watchFactory? })` is a `WorkflowSource`, the same contract the agent files use (see [agent files](agent-files.md#sources)): `load()`, `watch()`, and `write` and `delete` with an `expectedHash`. Bureau calls `load()` after each of its own writes, and `bureau.workflows.refresh()` calls `load()`. `watch: false` means no `fs.watch` and no poll.

`workflowObjectSource({ bucket, prefix }, { client, pollIntervalMilliseconds?, watch?, runtime?, diagnose? })` is the S3 counterpart: every `*.json` object directly under the prefix is a workflow named by the key minus the extension, `client` is a `Bun.S3Client` the caller builds, and the source polls instead of watching (default every second; `watch: false` means no poll). It is Bun only, hashes the bytes with SHA-256 like every source, and uses an object's ETag only as the `If-Match` (or `If-None-Match: *`) condition on a write or delete, so a refused change rejects with a `SourceConflictError` carrying the hash of what is there now. See [Agent files](agent-files.md#sources).

Bureau watches the directory the way it watches the agent directory (see [agent files](agent-files.md#watching)): `fs.watch` is only a trigger, one single-flight loop rescans the whole directory, and a rescan every second (`DIRECTORY_POLL_INTERVAL_MILLISECONDS`) backs it up. A change to the directory registers the new document with the engine and puts the schedule back to match, one change at a time. A write through an operation returns only after that has happened. A hand edit takes effect within the watcher's event or the one-second backstop.

If applying a change fails (a storage error, or an activation conflict in Weft), the file already holds the change and the engine and the schedule do not. A write through an operation then fails with `WorkflowApplyError` (`Unavailable`, `data.reason` `workflow-apply-failed` over the wire) instead of reporting success, the failure is reported through the diagnostic sink, and every later rescan, changed or not, applies the files again until it succeeds. `shutdown()` waits for the apply in progress before it disposes the engine, and nothing is applied after that.

`bureau.workflows.onChange(listener)` is called after every rescan that added, changed, or removed a workflow, with the identifiers, and `bureau.workflows.refresh()` rescans now and resolves once the engine and the schedules match the files.

## Writing

`bureau.workflows.list` returns each file with its `description` and its `trigger` as written, and, when called with `includeRuns: true`, for a `ready` file `runs`: how many instances are `active` (pending, running, or suspended), how many began in the last 24 hours, and when the newest began (`lastRunAt`, `null` for none), counted from the engine's totals. `runs` is `null` for an `invalid` file, for every file unless `includeRuns` is asked for (because each count reads the engine), and for a file whose count the engine could not give: the failure is reported through `onDiagnostic` and the list still answers with every file. Only the files on the requested page are counted. Each count is two reads the engine narrows by its type, status, and created-at indexes before it loads any state, so they load only the instances they count; a workflow with no instance in the last day also looks back 30 days, and then through its whole history, for the newest. `bureau.workflows.get(id)` returns the file's text and `hash`, the SHA-256 of its bytes. `create(id, definition)`, `update(id, definition, { expectedHash })`, `pause(id, { expectedHash })`, `resume(id, { expectedHash })`, and `delete(id, { expectedHash })` write through the same files. `definition` is the document without its `name` (Bureau sets it to the identifier) plus the optional `description`, `agent`, and `paused`. Each checks that the result would load and writes nothing otherwise, throwing `WorkflowFileError` with the codes above.

A write goes to a temporary dotfile in the same directory and is renamed into place, so nothing reads half a file. Writes are serialized in this process. `create` throws `WorkflowFileConflictError` (`workflow-file-exists`) when the file exists. `update`, `pause`, `resume`, and `delete` throw it (`workflow-file-changed`, with `currentHash`) when the bytes no longer hash to `expectedHash`, and `WorkflowFileError` (`workflow-file-not-found`) when the file is gone. The file is re-emitted as two-space JSON with a trailing newline; there are no comments to preserve. An update that changes nothing writes nothing, and pausing a paused workflow does neither.

There is no cross-process file lock. A different process writing the same file in the instant between a write's last check and its `rename` is not detected, as for agent files.

Over the wire a taken identifier is a `Conflict` fault (`data.reason` is `workflow-file-exists`), and a stale `expectedHash` is Weft's `StaleRevision` fault, because `Conflict` carries no hash: `data.expectedRevision` is the hash the caller sent and `data.currentRevision` the hash now on disk. A document that would not load is `Unprocessable` with the problem code as `data.reason` and every issue in the message.

## Revisions

A **revision** is a document's content as Weft hashes it (`workflowVersion`), computed after `description`, `agent`, and `paused` are stripped. Pausing or resuming changes neither, so it adds no revision.

Bureau stores each revision in its database under `bureau-workflow-snapshot:v1:<identifier>:<workflowVersion>`. The record holds the document exactly as Weft was handed it, so its recomputed version must equal its key, and a record that does not hash to its key is refused. It also holds when Bureau registered the revision (`registeredAt`) and when an instance of it first and last started (`firstRunAt`, `lastRunAt`).

- **Written first.** A revision's snapshot is written before the revision is registered, never after, so no revision reaches the engine without one behind it. Bureau cannot observe a start (a schedule fire goes straight to Weft, and so does Weft's own start), so nothing can be written "at run start".
- **A run pins its version.** Weft stamps every instance with the `workflowVersion` it began on. Bureau keeps no record per run; it asks the engine.
- **History.** `bureau.workflows.revisions(id)` lists the revisions that have run (`lastRunAt` present), most recently run first. A revision that was saved but never ran is not listed. Run revision A, then revision B, and the result is `[B, A]`. Each revision carries `compatibility` (COR-1813): Weft's `checkWorkflowCompatibility` verdict for that revision against the file's current revision, built from the manifest of each document (`buildWorkflowDocumentManifest`, which runs the pipeline registration runs and never calls a handler). The current revision is `{ compatible: true }`. Any other revision is `{ compatible: false, reasons }`, and `reasons` lists every applicable one of `name-mismatch`, `manifest-version-unsupported`, `contract-hash-mismatch`, `workflow-version-incompatible`, and `artifact-revision-mismatch`, in Weft's fixed order. A revision's version is a hash of its document and its revision follows its content, so every revision that differs at all carries at least `workflow-version-incompatible` and `artifact-revision-mismatch`; one whose steps use other handlers or wait for other signals also carries `contract-hash-mismatch`. `compatibility` is `null` when there is no current revision to compare against (the workflow's file was deleted or is invalid) or a manifest could not be built from a document, which is reported through `onDiagnostic`.

### At startup

Before the engine recovers, Bureau asks the engine which `workflowVersion`s still have an instance in flight (`pending`, `running`, or `suspended`) for every workflow it has a file or a snapshot for. It registers every ready file's current document as `active`, and each in-flight version that is no longer the file's as `retained` from its snapshot. So an instance parked in a `sleep` or an `await-signal` whose file was edited or deleted resumes on its original revision after a restart. An instance Bureau cannot register a revision for is cancelled before the engine recovers, because the engine refuses to recover anything while an in-flight instance of an unregistered type remains, and one such instance would strand every durable run in the store on every boot. That is an instance pinned to a revision whose snapshot is not stored, is not valid, or no longer validates against this Bureau, or whose workflow's name is now a code-defined workflow's (an instance of that code workflow itself is never touched). Each cancellation is reported through the diagnostic sink as an error naming the instance, the workflow, and the reason. The reason is stored (`bureau-workflow-cancelled-run:v1:<runId>`), so `bureau.workflows.runs.get` returns the instance as `cancelled` with it in `error`, and `runs.list` still lists it. Bureau can only do this for a workflow it still holds a trace of: a file, a stored revision of any version, or an earlier cancellation. An instance of a type Bureau has no trace of, or one of a Bureau that has no `workflowSource` at all, is left untouched in storage: Bureau recovers every other run, and reports each one left behind in `recovery()`'s `skippedRuns` (which makes its `outcome` `partial`) and as one `scope: 'recovery'` `warn` diagnostic per run per boot. A later boot that registers the type recovers it.

### Retention

Two steps, deliberately separate:

- **Leaving the `retained` set.** Nothing is stored to release. A revision is registered as `retained` at a startup only while the engine still has an instance in flight on it; once none is, the next startup does not register it.
- **Deleting the stored snapshot.** The durable maintenance pass deletes a snapshot that is not the current file's revision, has no instance in flight, and whose last activity (its registration, its last start, and the latest update of any of its instances in the engine) is older than `BureauOptions.retention.tasks` (default 30 days; `'forever'` deletes nothing). A record that cannot be read is deleted too, unless an instance of that workflow is still in flight: the record is then the last trace of the workflow, and the next boot needs it to cancel that instance with a reason.

`BureauOptions.retention.tasks` is therefore the window in which `bureau.workflows.revisions(id)` can list a revision of a deleted workflow, and in which `runs.list` and `runs.get` can still answer for the instances of a workflow whose file and snapshots are gone. A cancellation record is deleted by the same pass once it is older than the window and no instance of its workflow is in flight (a cancellation that kept failing leaves the instance in flight, and the record is what the next boot retries from).

## The schedule

Each workflow with a `schedule` trigger has exactly one live native schedule, whose id is `bureau-workflow-schedule:<identifier>:<generation>`. Weft keeps a cancelled schedule's record and refuses to create another under its id, so the generation is one more than the highest generation among every schedule of that identifier, cancelled ones included, read from the engine each time. "Exactly one" means one that is not cancelled.

Every startup, every rescan that finds a change, and every rescan after a failed apply puts the schedule back to match the file (a schedule changed through Weft's own console is corrected at the next of these, not at once): it is created if missing, its `spec` and `overlap` are updated, it is paused when the file says `paused: true` and resumed when it does not, and it is cancelled when the file is deleted or becomes `invalid`. Fixing the file creates a new generation. The schedule always resolves the active revision at the moment it fires (`active-at-fire`), and its input, which is the instance's `trigger`, is the static `{ kind: 'schedule', scheduleId }`; when it fired is the instance's own `createdAt`.

`bureau.schedules.*` (the in-process `bureau.schedules.get` and `bureau.schedules.list`) reads these schedules, and `ownerOf` answers them with the deployment's owner. `bureau.schedules.pause`, `bureau.schedules.resume`, `bureau.schedules.cancel`, `bureau.schedules.skipnext`, and `bureau.schedules.runnow` refuse them with `BureauError` (`NOT_FOUND`), as if they did not exist: the workflow's own operations are the only way to change one.

## Signals

A signal does two things, in this order, through `bureau.workflows.signal({ name, payload?, signalId? })` over the wire or `bureau.workflows.signal(name, payload, { signalId })` in process. It returns `{ started, delivered }`: the identifiers of the instances it started and the ones it delivered to.

- **Delivery.** `payload` goes to every running instance of a workflow file that is waiting at an `await-signal` step named `name`, as Weft's `waitingForSignals` lists it. This includes the instances of a paused or deleted workflow, which still finish. An instance that is not waiting at that name, or that is waiting at another, receives nothing. Bureau reads an instance's state again right before it delivers, so an instance that was cancelled or finished since the listing is skipped and left out of `delivered`. That narrows the window and does not close it: Weft drops a signal sent to an instance that has finished without saying so, so one that finishes at the very moment of the delivery can still be listed. A retry with the same `signalId` that Weft drops as a duplicate is listed too, because it is the answer the first call gave.
- **Start.** Then one instance starts for every ready, unpaused workflow whose trigger is `{ kind: 'signal', name }`. Its `trigger` is `{ kind: 'signal', name, payload }`, with `payload` `null` when the call had none, and that is what an `agent` step's message shows after `Trigger:`. A paused, deleted, or `invalid` workflow is skipped and the call does not fail. Starts are not deduplicated: every call starts one instance per matching workflow.

Delivery is over before any instance starts, so a new instance whose first step awaits the same name is not satisfied by the call that started it; it waits for the next signal.

`signalId` is forwarded to Weft's signal delivery, and may be at most 128 bytes (UTF-8 bytes, not characters, as Weft counts them). A delivery retried with the same `signalId` is applied once, so an instance that moved on to a second wait at the same name does not take the retry as another signal. It does not deduplicate starts, and Weft's `startOrSignal` is not used.

The operation needs the deployment's owner or `bureau.workflows:write`. Any other caller gets `{ started: [], delivered: [] }`, and nothing is delivered or started.

**When a signal cannot be sent.** Everything the engine would refuse, or an agent step could not render, is checked before anything is delivered or started: a `signalId` over 128 bytes, a payload that is not a JSON value (a `Map`, a `Set`, a `bigint` or `NaN` passed in process), a payload that cannot be encoded, and a payload (or the trigger built from it) over the engine's payload limit (`durableGuardrails.payloadSize`). Each is `InvalidParams` over the wire and `BureauError` (`BAD_REQUEST`) in process, and changes nothing. Any other error from the engine during delivery stops the call: it is `Unavailable` with `data.reason` `signal-delivery-failed`, nothing is started, and it is not retried silently. The same is true when an earlier change to the files has not reached the engine, with `data.reason` `workflow-apply-failed`, as a write does. In both cases the message names the instances the signal had already reached (`Delivered to: …`), and an in-process caller finds them on the error as `delivered`, so a retry with the same `signalId` reaches them again without applying the signal twice. An error while starting an instance is not reported this way: the call fails with what the engine said, and the instances it had already started are not listed.

## Agent tools

With a `workflowSource`, Bureau adds five tools to the deployment's tool catalog (the `tools` of the agent source) itself, so an agent file receives them only when it lists them in `tools`: `workflows-create`, `workflows-update`, `workflows-pause`, `workflows-resume`, and `workflows-list` (COR-1529). The names use hyphens because provider tool-name grammars exclude dots. A host tool with one of these names is refused at `createBureau` with `BureauError` (`BAD_REQUEST`). Code-defined agents take their tools from their own definitions and are not given these.

The tools write through `Bureau.workflows`, the same methods the operations use, never to the filesystem directly.

- **Who they act for.** Every workflow belongs to the deployment's owner of record. A tool acts only when the owner of record of the run that called it, read through `Bureau.ownerOf` and not from anything the request carried, is that owner. For any other run `workflows-list` answers an empty list and every write answers `not-found`.
- **The `agent` field.** `workflows-create` and `workflows-update` write the calling run's own agent identifier. `workflows-update` replaces the whole definition, and `paused` left out means running. `workflows-pause` and `workflows-resume` change only `paused`. A calling agent whose identifier is not an agent identifier gets `{ status: 'invalid', code: 'invalid-agent', issues }` from every tool and writes nothing.
- **The identifier.** `workflows-create` takes a `name` and an optional `id`. Without `id` it lowercases the name, turns every run of characters outside `[a-z0-9]` into one `-`, trims `-` from both ends, and requires the result to start with a letter and be at most 64 characters; anything else is `{ status: 'invalid', code: 'invalid-identifier' }`. There is no automatic suffix, so a taken identifier is a `conflict`.
- **Guarding a change.** `workflows-list` returns each workflow's `id`, `hash`, `state`, `paused`, and `triggerKind` (`null` for an `invalid` file, which also carries its `problem` code so its author can fix it). `workflows-update`, `workflows-pause`, and `workflows-resume` take that `hash` as `expectedHash`.
- **Results.** Every outcome of a call whose input matches the tool's schema is an ordinary tool result, never a failed tool call. Input that does not match the schema the model is shown is refused by the tool runner as a failed tool call, before the tool runs, so nothing is written. The shapes are: `{ status: 'ok', id, hash }`; `{ status: 'conflict', id, reason: 'workflow-file-exists' | 'workflow-file-changed', currentHash? }`; `{ status: 'invalid', code, issues }`, with every schema failure of a document that would not load in `issues`; `{ status: 'not-found', id }`; and `{ status: 'unavailable', reason: 'workflow-apply-failed' }`. `workflows-list` answers `{ status: 'ok', workflows }`.

A change takes effect before the call returns, as it does over HTTP. There is no `delete` or `get` tool.

## Audit

Every write to a workflow file that changed it is appended to the audit trail, whether a tool or an HTTP call made it: `workflow.created`, `workflow.updated`, `workflow.paused`, `workflow.resumed`, and `workflow.deleted`. The entry is filed under the `runId` `workflow:<identifier>`, so `auditTrail.query({ runId: 'workflow:digest' })` is one workflow's history, and its `detail` is `{ id, hash, previousHash? }`: `hash` is the file after the write (the file that was deleted, for a delete) and `previousHash` the one the write was guarded by. The actor, the entry's `principal`, is `agent-run:<runId>` for a tool call and the calling principal's owner string for HTTP. A write that changed nothing (a no-op update, pausing a paused workflow) and a write that was refused write no entry, and a write whose apply to the engine failed does, because the file changed. `ownerOf` resolves the entry to the deployment's owner, so an owner-scoped reader sees it as the deployment's owner and no other principal does. Edits made by hand on disk are not audited. A Bureau with no persistent storage keeps no trail and records nothing.

## Pausing and deleting

- **Paused.** `paused: true` in the file pauses the schedule. A paused workflow starts no new instance from its schedule, and an instance that is already running completes.
- **Deleted.** Deleting the file cancels the schedule. Instances already running finish on the revision they began on, including after a restart; the revision stays registered as `retained` until none is left.
- **Refusal happens on Bureau's own paths.** Weft has no start-admission hook, and Bureau adds none. A schedule fire goes straight to Weft, so pausing and cancelling the schedule is the whole refusal there. `bureau.workflows.signal` is the one path that starts a workflow, and it checks `bureau.workflows.assertStartable(id)` for each candidate, which throws `BureauError` (`NOT_FOUND`) for a workflow that is missing, invalid, deleted, or paused; the signal skips such a candidate and the call does not fail. A paused or deleted workflow's running instances still receive a delivered signal.
- **Weft's own start is not covered.** Weft's start operation, relayed by Interborough's engine console, starts any registered workflow type, and a start there bypasses Bureau's pause and delete. A deleted workflow's last revision also stays registered with the engine as long as the process lives, so a start there still finds it.

## Owner

Every workflow file belongs to the deployment's owner of record (`anonymous:local` in Interborough), and the file has no owner field: an `owner` key is an unknown key and makes the file `invalid`. An `agent` step starts its run as that owner. Bureau's `ownerOf` resolves a workflow's schedule, and any instance of a workflow file, to that owner, so `bureau.schedules.*`, `bureau.workflows.runs.list`, and `bureau.workflows.runs.get` apply the owner predicate to them.

## Operations

`createBureauHandler` serves the workflow operations as JSON-RPC: `bureau.workflows.create`, `update`, `pause`, `resume`, `delete`, `get`, `list`, `revisions`, `runs.list`, `runs.get`, and `signal`. A caller reaches workflows without a scope only when it is the deployment's owner, which under `unauthenticatedAccess: 'allow'` is the one local caller. `bureau.workflows:read` grants the reads to any caller and `bureau.workflows:write` the writes, and neither implies the other. A caller who may not see workflows is answered as if there were none: an empty page for `list` and `runs.list`, and `NotFound` for the rest; `create` has nothing to hide and answers `Forbidden`. A run that is not an instance of a workflow file is `NotFound` in `runs.get` for every caller. `signal` needs the owner or `bureau.workflows:write` and answers any other caller `{ started: [], delivered: [] }`, because it names no workflow to hide. A `definition` that names a key the operation does not declare (`retries`, say) is `InvalidParams` before anything is written: `data.issues` holds an `unrecognized_keys` issue at path `definition` whose message names the key. `definition.trigger` and each item of `definition.steps` are open at the wire, so the trigger kind's own validator and the document's step validation refuse their unknown keys as `Unprocessable`.

## The host is frozen

Bureau builds one `DocumentWorkflowHost` per engine, with the `agent` activity and the `schedule` trigger kind, and freezes it. The `agent` handler resolves its agent from the live catalog each time it is called. Weft keeps the loader and handlers of the first registration of a revision, so a second host would be ignored without a word; registering documents on an engine with a different host throws `WorkflowHostConflictError` (`workflow-host-conflict`), naming both hosts' activities and trigger kinds.

## Limits

- Writes are not safe against another process editing the same file (see Writing).
- Per-user directories and Git history of the directory are out of scope.
- Webhook and lifecycle triggers are not planned; a signal is the one way in from outside, and an A2A message from another principal starts nothing.
- `runs.list` reads at most 1,000 instances of a workflow.
