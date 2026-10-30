# Agent files

Bureau loads agent definitions from Markdown files in a directory the host names (COR-1524). You create and edit agents by hand, or through `bureau.agents.create`, `update`, and `delete` (served over HTTP as `bureau.agents.definitions.*`, see [Operations](#operations)); either way the agent is a file. This follows how Claude Code, Codex, and OpenClaw keep agents: one file per agent, the body is the instructions, and the frontmatter describes everything else.

Bureau does not know where the directory lives. The host passes an agent source (`BureauOptions.agentSource`), usually `agentFileDirectory(path, { tools })` from `@lostgradient/bureau/sources`, and the Interborough host passes `agents/` under its home. See [Sources](#sources).

## A file

```md
---
name: Researcher
description: Finds and cites sources
model: anthropic/claude-sonnet-4-5
models:
  - anthropic/claude-sonnet-4-5
  - openai/gpt-4.1
tools:
  - lookup-order
skillDescriptors:
  - id: cite
    name: Cite
    description: Cites the sources it used
    tags: [research]
a2a: false
stepLimit: 25
retry:
  attempts: 3
  delayMilliseconds: 500
  jitter: true
---

You are a careful researcher. Cite everything.
```

The filename without `.md` is the agent's identifier, so this file is `researcher.md` and the agent is `researcher`. The identifier must match `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$` and be at most 64 characters, because it doubles as a path segment; a file whose stem breaks either rule is `invalid` with `invalid-identifier`. Workflow files have the same cap. Only files ending exactly in `.md` count: dotfiles, `.MD`, `.markdown`, `.txt`, and directories are ignored. A symbolic link to a file is followed. A file larger than 256 KiB is invalid.

The frontmatter keys are:

- `name`: a display label, optional, defaulting to the identifier. It need not be unique.
- `description`: what the agent does, optional.
- `model`: required, written `<provider>/<model-or-alias>`, split on the first `/`. It must name a non-retired row in the deployment's model catalog (`bureau.models.catalog()`). A bare model name is not accepted, because it would be ambiguous across providers.
- `models`: optional, the models a session of this agent may be switched to through `bureau.contexts.steer`, each written `<provider>/<model-or-alias>` like `model`. A file agent is selectable: `model` is its default, `models` narrows the choice, and without it the deployment's model catalog is allowed. `bureau.agents.models` reports the list filtered to the rows the catalog holds, so an entry the catalog lacks is left out rather than making the file invalid. The list is checked when the file is parsed, never against the catalog: every entry is `<provider>/<name>`, non-empty and unique, the list is not empty, and it includes the default `model`, compared as the literal string the file wrote (an alias of the default does not count). A violation is `invalid-frontmatter`, with `problem.issues[].path` set to `models.<index>` for an entry and to `models` for the list. Changing the list changes the file, so the `definitionRevision` rises. An `update` that omits `models` removes it, as it does `tools`, whether through `BureauAgentCatalog.update` or `bureau.agents.definitions.update`; a client that read the list sends it back to keep it. A run's snapshot keeps the list its run started with.
- `tools`: a list of unique names from the deployment's tool catalog (the `tools` option of the agent source). Defaults to none.
- `skillDescriptors`: descriptive Agent Card skills (`id`, `name`, `description`, `tags`, and optionally `examples`, `inputModes`, `outputModes`), never executable skills. Ids are unique within the agent.
- `examples`: optional, a list of at most three non-blank strings, each at most 200 characters (Operative's `AGENT_EXAMPLE_LIMITS`, the bounds `createAgent` enforces), that show what a person might ask the agent, which a chat client offers as buttons on a new chat. `bureau.agents.list` carries them as `examples`. They never reach a run. Bureau reads them and does not write them: `bureau.agents.definitions.update` and `BureauAgentCatalog.update` keep the key in the file as it is, the way they keep any key they do not know, and a write that changes nothing else writes nothing. A value that is not such a list is `invalid-frontmatter`.
- `a2a`: a strict boolean, default `false`. It opts the agent into A2A, the agent-to-agent protocol: only an agent that opts in is served at `<publicUrl>/a2a/<id>`. Every other surface (chat over AG-UI, `bureau.agents.list`, `bureau.deployment.get`) serves any ready agent whatever this says. A persisted agent opts in by this key and nothing else: the `a2aAgents` allowlist of `createBureauHandler` governs code-defined agents only. See [The A2A opt-in](#the-a2a-opt-in).
- `stepLimit`: optional, an integer from 1 to 1000, the most steps one run of the agent may take (Operative's `maximumSteps`). Absent, Operative's default of 25 applies. A run that reaches it finishes with `maximum-steps`. A value outside the range, or one that is not an integer, is `invalid-frontmatter` with `problem.issues[].path` set to `stepLimit`.
- `retry`: optional, how a run retries a generate call that failed (Operative's `RetryOptions`). `attempts` (required, an integer from 1 to 10) counts the first call, so `1` retries nothing; `delayMilliseconds` (an integer from 0 to 60000, default `0`) is the wait between attempts; `jitter` (a boolean, default `false`) randomises that wait. Absent, a failed call is not retried. An out-of-range value, or a key other than these three, is `invalid-frontmatter` with the path `retry.attempts`, `retry.delayMilliseconds`, `retry.jitter`, or `retry`.

For both, an `update` that leaves the key out keeps the file's value, as it does for `a2a`, and a file with no such key is not given one; `null` removes the key, so `bureau.agents.definitions.get` answers `null` again. A snapshot written before the keys existed loads with neither.

A file written for an earlier version of the format may carry keys it no longer knows (the offering flag it used to have, and `skills`, now `skillDescriptors`): Bureau ignores them like any other unknown key, leaves them in the file when it rewrites it, and does not read the old `skills` list as `skillDescriptors`.

Any other top-level key is allowed. Bureau ignores it at run time, leaves it out of the run's snapshot, and keeps it when it rewrites the file. The exported schema is `agentFileFrontmatterSchema`.

The body is the agent's instructions. Bureau passes it to the agent trimmed, and an empty body means no instructions.

YAML is read with `js-yaml` under the core schema, so a date-looking value stays text and no custom tag is evaluated.

## What is invalid

A file that cannot be used is still listed by `bureau.agents.list()`, with `state: 'invalid'` and a `problem` whose `code` says why. It never runs, `bureau.run` and `createRun` refuse it as an unknown agent, and it never affects another agent.

- `invalid-identifier`: the filename is not a valid identifier.
- `invalid-frontmatter`: a schema failure; `problem.issues` lists every one.
- `unknown-model`: not written `<provider>/<model>`, absent from the model catalog, or the host's `models.generate` could not set it up.
- `unknown-tool`: names a tool the tool catalog lacks; the message lists each.
- `shadows-code-agent`: the identifier is a key of `createBureau({ agents })`, or `bureau`, the default agent. Code always wins.
- `missing-frontmatter`, `invalid-yaml`, `not-utf8`, `file-too-large`, and `unreadable`.

## Wiring it in

```ts
import { createBureau } from '@lostgradient/bureau';
import { agentFileDirectory } from '@lostgradient/bureau/sources';
import type { GenerateFunction } from '@lostgradient/operative';
import type { Tool } from 'armorer';

declare const lookupOrderTool: Tool;
declare function generateFor(provider: string, model: string): GenerateFunction;

const bureau = await createBureau({
  agents: {},
  agentSource: agentFileDirectory('/home/me/.interborough/agents', {
    tools: { 'lookup-order': lookupOrderTool },
  }),
  models: { generate: (descriptor) => generateFor(descriptor.provider, descriptor.model) },
});
```

`models.generate` turns the catalog row a file's `model` resolved to into the `generate` it runs with. The host supplies it because the host holds the credentials. `agentSource` without it is refused with `BureauError` (`BAD_REQUEST`), so a model name is never silently ignored. If it throws, that file is `invalid` with `unknown-model`.

## Sources

The directory is one implementation of a `DefinitionSource` (COR-1702). Bureau keeps parsing, frontmatter validation, model and tool validation, snapshots, revisions, and the write-through operations; a source only holds bytes:

```ts
import type { DefinitionEntry, DefinitionSourceChange } from '@lostgradient/bureau';
import { SourceConflictError } from '@lostgradient/bureau';

declare const entry: DefinitionEntry;
declare const change: DefinitionSourceChange;
declare const conflict: SourceConflictError;

// `entry.hash` is the SHA-256 hex of `entry.bytes`, computed by the source.
export const identifier: string = entry.id;
export const added: string[] = change.added;
export const actual: string | null = conflict.actualHash;
```

`load()` returns every definition the source holds. `watch(listener)` reports changes made outside Bureau. `write(id, bytes, { expectedHash })` creates (`expectedHash: null`) or replaces a definition, and `delete(id, { expectedHash })` removes one; each compares the definition's current hash with `expectedHash` as late as the source can and rejects with a `SourceConflictError` carrying `id`, `expectedHash`, and `actualHash` (`null` for a definition that does not exist) when they differ, writing nothing. Bureau calls `load()` after its own `write` and `delete`, so write-through never waits on `watch`, and a `watch` report of the same change is a no-op because a rescan is idempotent. `bureau.agents.refresh()` calls `load()`. A source may attach a `problem` to an entry instead of bytes (a file over the size cap, a file that could not be read); the definition is then listed as `invalid`.

`agentFileDirectory(path, { tools, watch?, watchFactory? })` is the directory source: `fs.watch` is the trigger, a once-a-second rescan backs it up, files over 256 KiB are not read, only `*.md` files count, and a write goes to a temporary dotfile renamed into place. `watch: false` means no `fs.watch` and no poll, and a change is picked up by the next `load()`. `watchFactory` replaces how a directory is watched, for a test. It lives in `@lostgradient/bureau/sources`, apart from the main entry, because it needs Node's file system. There is no `path(id)`: a host that shows where a file lives computes the path itself.

`agentObjectSource(location, options)` is the S3 counterpart, for a deployment whose definitions live in a bucket. `location` is `{ bucket, prefix }`: every `*.md` object directly under the prefix (`agents` and `agents/` mean the same folder) is an agent named by the key minus the extension, and nested keys, dotfiles, and other extensions are ignored. `options` takes `client`, a `Bun.S3Client` the caller builds (Bureau reads no environment and never sees a credential), `tools`, `pollIntervalMilliseconds` (default 1000), `watch` (default `true`; `false` means no poll, and a change is picked up by the next `load()`), `runtime`, and `diagnose`. It is Bun only. An object store has no change feed, so the poll is the whole watch: each tick lists the prefix (following continuations), reads only the objects whose ETag changed, and tells the listeners, with empty lists when nothing changed. `hash` and `expectedHash` are still the SHA-256 of the bytes; the ETag is used only as the condition on a change. A write reads the object, checks its hash, and sends that read's ETag as `If-Match` (`If-None-Match: *` to create) on a presigned request, because `S3Client.write` ignores a conditional header; a delete sends `If-Match` the same way. A store has to honor that header on `DELETE` for the delete to be conditional: the store COR-1759 probed (a Railway bucket) does, but AWS S3 honors `If-Match` on `DELETE` only for directory buckets, so on a store that ignores it the delete is unconditional and only the hash check just before it protects it. A refusal (`412`, or `404` for a key that vanished) reads the object again and rejects with a `SourceConflictError` whose `actualHash` is the hash of what is there now, or `null`. Like the directory source, it lives in `@lostgradient/bureau/sources`.

```ts
import { agentObjectSource } from '@lostgradient/bureau/sources';

declare const client: Bun.S3Client;

export const agentSource = agentObjectSource(
  { bucket: 'my-definitions', prefix: 'agents/' },
  { client, tools: {} },
);
```

A file agent runs exactly as a code-defined one does. `bureau.tasks.start('researcher', input)` accepts any string name (a second overload of `start`, which resolves to an untyped `TaskHandle`) and runs it as a task in a context, resolving the same options, tools, and instructions. It is refused with `NOT_FOUND` for a name that is not a ready agent.

`bureau.agents` keeps `names()`, `entries()`, `query()`, `get()`, and `has()` typed to the code-defined map. The combined view is `list()`: code agents first in definition order, then file agents by identifier, each with `id`, `source`, `state`, `name`, `description`, `a2a`, `owner`, `definitionHash`, `definitionRevision` (see [Revisions](#revisions)), and, for an invalid file, `problem`.

Every file agent belongs to the deployment's owner of record, `anonymous:local` in single-user mode. A file has no owner field, and an `owner` key in the frontmatter is just an unknown key.

## Watching

Bureau watches the directory, so adding, editing, or deleting a file takes effect without a restart. `fs.watch` is only a trigger: any event marks the catalog dirty, and one single-flight loop rescans the whole directory until nothing is dirty. Bursts coalesce, and since a rescan is idempotent it does not matter whether a change arrived as an edit, a rename into place, a delete, or the directory disappearing. There is no debounce interval. `fs.watch` can drop an event (on macOS a directory's creation went unreported in about one of two hundred runs of a test that made the directory and a file in it back to back), so a rescan every second backs it up; it reports nothing when nothing changed, and it bounds how long a change the watcher missed can go unseen. A directory that does not exist is an empty catalog, and its nearest existing ancestor is watched until it appears. A file read half-written may be transiently invalid, but it often is not: a file torn at a point where the frontmatter and a prefix of the body still parse is a valid agent, which Bureau lists, could run, and gives a revision of its own, and the completion of the write triggers the rescan that replaces it with another. Write a hand edit to a temporary file in the same directory (a dotfile is ignored) and rename it into place, as Bureau's own writer does, so no scan reads a half-written file.

`bureau.agents.onChange(listener)` is called after every rescan that added, changed, or removed an agent, with the identifiers, and `bureau.agents.refresh()` rescans now. A host that replaces the model catalog after the Bureau exists calls `refresh()`, because a file's model is revalidated when a scan sees the catalog's revision change.

## Revisions

A file agent's external identity is its name and its `definitionRevision`, so a client that fences on the revision has to see every change to the file. The revision of a ready file agent is 1 on its first sighting and rises by one every time the file's content (its SHA-256) changes. Editing the file by hand, and `update` both change it; a model catalog change that points an alias at another model does not, because the file did not change. Content that returns to an earlier hash still raises it: the revision counts changes, not distinct contents. An invalid file has no revision (`definitionRevision` is absent from its listing and `null` on the wire).

Bureau keeps one record per file agent under `bureau-agent-revision:v1:<id>`, as JSON in this key order: `{"revision":<n>,"hash":"<sha-256 of the file's bytes the revision was raised for>"}`. Each rescan, after the files are evaluated and before `refresh()` resolves or `onChange` fires, reads the record of every ready file (one read per ready file per rescan; it writes nothing when the record already describes the file), so a catalog that missed another process's edits reports the record's revision on its next rescan (a catalog writes a new revision only from a reading it can trust is current: when the record describes other content and the file still has the content this catalog itself last recorded, the scan may have read the file just before a peer's edit, so the write waits one rescan; each distinct record hash buys one such wait). A catalog that has recorded nothing yet, on its first rescan after a start, has no last-recorded hash and writes at once, so the revision it lists always names the content it lists it with: a change made while the Bureau was down is listed at a new revision on the first refresh. The one known property is a narrow race on that first rescan: if a peer records an edit between this catalog's first read of the file and its read of the record, the catalog can count that edit twice. A revision is only ever raised that way, never lowered. A rescan that finds only the revision changed reports the file in `onChange`'s `changed`. The hash in a record is a SHA-256 in lowercase hex; a record with any other hash is malformed. A file whose hash differs from the record's has `revision + 1` and the new hash written, on condition that the record is still the exact text that was read; a store with no record reads as a first sighting and writes revision 1 on condition that the key is absent. The condition makes it safe across processes: two Bureaus on one store that see the same change produce one increment and report the same revision, and a writer that loses the race reads the winner's record and reports its revision. Deleting a file leaves its record, so recreating the identifier continues from the last revision.

The revision is the agent's generation profile revision (`createAgent` takes an optional `revision`, 1 when absent), so every reader that reports `definitionRevision` reports the persisted one: `bureau.agents.list` (HTTP), `bureau.agents.definitions.get` and `list`, the recovery record of a `bureau.run` run, and the metadata of a session run (`lastAgentRevision`). A run keeps the revision it started with: a run resumed after a restart is rebuilt from its snapshot with the revision it recorded, not the revision the file has reached since. A snapshot is keyed by content, so the revision is recorded with the run: in its recovery record (`definitionRevision`) and, for every run of a file agent, in an optional `definitionRevision` on its reference `bureau-agent-run:v1:<runId>`, filled once and never changed by a later hold. A session run restored after a restart reads the revision from its own reference; a reference written before the field existed has none, and falls back to the session's metadata (`lastAgentRevision`), which names the session's latest run's revision only.

A record that cannot be read or written, or that is not a valid record, never makes the agent invalid and is never replaced (replacing it would write revision 1 over a higher one). The agent stays listed at the last revision this Bureau knew, or 1 if it knows none, a diagnostic names the agent (once when the failure begins or the file changes, not on every rescan that finds the store still down), and the next rescan tries again. While the store cannot be read, an agent can therefore report a lower revision than the store holds; it cannot record runs then either.

## Writing

`bureau.agents.read(id)` returns the file's text and `hash`, the SHA-256 of its bytes. `create(id, definition)`, `update(id, definition, { expectedHash })`, and `delete(id, { expectedHash })` write through the same files. Each checks that the result would load (schema, identifier, model, tools, code names, and that the host's `models.generate` can set the model up) and writes nothing otherwise, throwing `AgentFileError` with the codes above.

A write goes to a temporary dotfile in the same directory and is renamed into place, so nothing reads half a file. Writes are serialized in this process. `create` throws `AgentFileConflictError` (`agent-file-exists`) when the file exists. `update` and `delete` throw it (`agent-file-changed`, with `currentHash`) when the bytes no longer hash to `expectedHash`, and `AgentFileError` (`agent-file-not-found`) when the file is gone.

`update` keeps the body byte for byte when the supplied instructions equal it, and a frontmatter whose meaning does not change keeps its original text. When the frontmatter does change, Bureau replaces the lines of the keys it knows (`name`, `description`, `model`, `models`, `tools`, `skillDescriptors`, `a2a`, `stepLimit`, `retry`) and keeps every other line, comments included, byte for byte, so an unknown key keeps its value and its YAML type for other tools: a quoted `created: '2024-01-01'` stays a string and an unquoted date stays a date. Bureau reads the rewritten frontmatter back and requires it to hold exactly the keys and values asked for. If it does not (a quoted key, say, which a line edit does not recognise), the whole frontmatter is re-emitted with `js-yaml`, which keeps values and types but drops comments and layout. An update that changes nothing writes nothing. An update or delete of a symbolic-linked agent file replaces the link with a regular file and leaves its target alone.

There is no cross-process file lock. A different process writing the same file in the instant between a write's last check and its `rename` is not detected, because `rename` replaces whatever is there and, for `create`, cannot refuse an existing target. The window is the time between two system calls.

## The A2A opt-in

An agent opts into A2A when its file says `a2a: true` and the file is `ready`; an `invalid` file is not an agent, so it never opts in. Turn it on or off with `update` (or by hand). One rule holds for `BureauAgentCatalog.update` and the HTTP operation `bureau.agents.definitions.update` alike: an `update` that leaves `a2a` out keeps the file's value, and a file with no `a2a` key is not given one, so a caller that rewrites a definition cannot turn the opt-in off by omitting it. (This differs from `tools` and `models`, which an `update` that omits them removes.) A file with no `a2a` key is `false`; `create` writes `a2a: false` unless it is told otherwise.

A code-defined agent opts in through the `a2aAgents` allowlist of `createBureauHandler` alone, and `update` and `delete` refuse it as not found before reading any file. `bureau.agents.definitions.get` and `list` report `a2a` from whoever opts the agent in: the allowlist for a code-defined agent, the file for a persisted one. `bureau.agents.list` (the HTTP operation) reports the same `a2a` on every ready agent, and `bureau.deployment.get` names them all.

The opt-in decides only what the A2A mount serves; it does not decide who can chat with an agent. The AG-UI mount starts a run of any ready agent, and a run that is waiting for an answer can be resumed after its agent is deleted. This part records and exposes the opt-in; the A2A mount reads it on every request (COR-1819).

## Operations

`createBureauHandler` serves the same files as `bureau.agents.definitions.*` and `bureau.agents.catalog`, under the scopes `bureau.agents:read` and `bureau.agents:write` (see [the control plane](./external-control-plane.md)). `bureau.agents.catalog` reads `bureau.models.catalog().descriptors` unfiltered, each row reduced to the `general` audience, and `bureau.agents.tools()` (the deployment's tool catalog, by name with each description and a `shortDescription`: the tool's `metadata.shortDescription`, one line for a person, or `null` when it declares none). `bureau.agents.detail(id)` is what `definitions.get` serves: the listing fields, the file's exact text, and its parsed definition, read from disk now so the hash, the text, the state, and the `definitionRevision` describe the same bytes: a file that changed since the last rescan is settled (rescanned) first, so its new text is never served at the previous revision. Every write the operations make that changed a file is appended to the audit trail as `agent.created`, `agent.updated`, or `agent.deleted`, filed under the `runId` `agent:<identifier>` and attributed to the caller. A Bureau with no persistent storage keeps no durable audit trail and records nothing.

## Snapshots

A run uses the definition it started with. When a run of a file agent starts, Bureau stores the parsed definition in its database under `bureau-agent-snapshot:v1:<id>:<hash>`, where the hash is the file's, and ties the run to it with `bureau-agent-run:v1:<runId>`. The run records the hash (`agentDefinitionHash` in a `bureau.run` run's recovery record, `lastAgentDefinitionHash` in a session run's metadata), and the snapshot is written before the record that names it.

A switch (`bureau.contexts.steer`) reaches the provider call through the agent's generate, which picks each step's model from that step's own steering: the model the session was switched to, or the default. A model that is no longer usable when a step runs (a hand edit has dropped it from `models`, the catalog has retired it, or `models.generate` now throws for it) fails the step with a `ModelOverrideUnusableError` naming the model. It never falls back to the default, and `bureau.contexts.get` keeps reporting the override.

Editing or deleting the file mid-run does not change the run, because the agent object was built from the snapshot's values. A run resumed after a restart is rebuilt from the snapshot, with the model and tools resolved against the catalogs as they are now, even if the file is gone. A snapshot that was pruned fails the resume with `AgentSnapshotError` (`snapshot-missing`), and a model or tool the deployment no longer has fails it with `snapshot-unresolvable`. Neither falls back to the current file.

`bureau.agents.revisions(id)` lists the snapshots that have run for an identifier, most recently run first.

A snapshot is kept while any run that references it is retained, and pruned after the last one's retention ends:

- A reference is written only once the run is this execution's. A run with a minted identifier ties itself to its snapshot at once. A child or a goal attempt, whose identifier is claimed first, ties itself only after it wins the claim; a start that loses the claim, or fails, leaves the winner's reference alone and drops a snapshot nothing holds.
- A session run's reference goes when its task is deleted (the `run.removed` event, which task retention triggers), or when its session save fails before the run exists.
- Any run's reference also goes once it has been settled for longer than `BureauOptions.retention.tasks` (default 30 days; `'forever'` prunes nothing). The durable maintenance pass does this. It is what releases a `bureau.run` run, which leaves the run store the moment it settles and was never subject to task retention before. Those runs now have a snapshot retention window equal to `retention.tasks`.
- A run settles its reference as it ends: a fresh run through its handle or the store, a recovered `bureau.run` run through the recovery branch. The maintenance pass also reconciles every open reference against the durable engine. A run the engine says has ended is settled at its end time. A reference with no run behind it, once it is ten minutes old, belongs to a start that failed and is released. A run still active, or one this process is driving, is left alone.
- A run that has not settled keeps its snapshot indefinitely, because it may still be resumed.
- A snapshot read back is validated against the definition schema, with the defaults a later field would need. One that is not valid fails the resume with `snapshot-unresolvable`.
- Pruning is not atomic across Bureau instances that share a store: one can list the references while another records a run on the same definition, and the first can then delete the snapshot. Agent files support one Bureau per store, which is how Interborough runs.

## Limits

- The steering agent-identity override still validates against the code-defined map only. A file agent is not a steering target.
- Writes are not safe against another process editing the same file (see Writing).
- Per-user directories and Git history of the directory are out of scope.
