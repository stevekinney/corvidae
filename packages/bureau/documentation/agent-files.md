# Agent files

Bureau loads agent definitions from Markdown files in a directory the host names (COR-1524). You create and edit agents by hand, or through `bureau.agents.create`, `update`, and `delete`; either way the agent is a file. This follows how Claude Code, Codex, and OpenClaw keep agents: one file per agent, the body is the instructions, and the frontmatter describes everything else.

Bureau does not know where the directory lives. The host passes a path (`BureauOptions.agentDirectory`), and the Interborough host passes `agents/` under its home.

## A file

```md
---
name: Researcher
description: Finds and cites sources
model: anthropic/claude-sonnet-4-5
tools:
  - lookup-order
skills:
  - id: cite
    name: Cite
    description: Cites the sources it used
    tags: [research]
published: false
---

You are a careful researcher. Cite everything.
```

The filename without `.md` is the agent's identifier, so this file is `researcher.md` and the agent is `researcher`. The identifier must match `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`, because it later doubles as a path segment. Only files ending exactly in `.md` count: dotfiles, `.MD`, `.markdown`, `.txt`, and directories are ignored. A symbolic link to a file is followed. A file larger than 256 KiB is invalid.

The frontmatter keys are:

- `name`: a display label, optional, defaulting to the identifier. It need not be unique.
- `description`: what the agent does, optional.
- `model`: required, written `<provider>/<model-or-alias>`, split on the first `/`. It must name a non-retired row in the deployment's model catalog (`bureau.modelCatalog`). A bare model name is not accepted, because it would be ambiguous across providers.
- `tools`: a list of unique names from the deployment's tool catalog (`BureauOptions.agentTools`). Defaults to none.
- `skills`: descriptive Agent Card skills (`id`, `name`, `description`, `tags`, and optionally `examples`, `inputModes`, `outputModes`), never executable skills. Ids are unique within the agent.
- `published`: a strict boolean, default `false`. It records whether the agent may be offered over the network. Bureau only reports it on `list()`; serving published file agents belongs to the network operations (COR-1526).

Any other top-level key is allowed. Bureau ignores it at run time, leaves it out of the run's snapshot, and keeps it when it rewrites the file. The exported schema is `agentFileFrontmatterSchema`.

The body is the agent's instructions. Bureau passes it to the agent trimmed, and an empty body means no instructions.

YAML is read with `js-yaml` under the core schema, so a date-looking value stays text and no custom tag is evaluated.

## What is invalid

A file that cannot be used is still listed by `bureau.agents.list()`, with `state: 'invalid'` and a `problem` whose `code` says why. It never runs, `bureau.run` and `createRun` refuse it as an unknown agent, and it never affects another agent.

- `invalid-identifier`: the filename is not a valid identifier.
- `invalid-frontmatter`: a schema failure; `problem.issues` lists every one.
- `unknown-model`: not written `<provider>/<model>`, absent from the model catalog, or the host's `resolveAgentGenerate` could not set it up.
- `unknown-tool`: names a tool the tool catalog lacks; the message lists each.
- `shadows-code-agent`: the identifier is a key of `createBureau({ agents })`, or `bureau`, the default agent. Code always wins.
- `missing-frontmatter`, `invalid-yaml`, `not-utf8`, `file-too-large`, and `unreadable`.

## Wiring it in

```ts
const bureau = await createBureau({
  agents: {},
  agentDirectory: '/home/me/.interborough/agents',
  agentTools: { 'lookup-order': lookupOrderTool },
  resolveAgentGenerate: (descriptor) => generateFor(descriptor.provider, descriptor.model),
});
```

`resolveAgentGenerate` turns the catalog row a file's `model` resolved to into the `generate` it runs with. The host supplies it because the host holds the credentials. `agentDirectory` without it is refused with `BureauError` (`BAD_REQUEST`), so a model name is never silently ignored. If it throws, that file is `invalid` with `unknown-model`.

A file agent runs exactly as a code-defined one does. `bureau.run('researcher', input)` accepts any string name (a second overload of `run`), and `bureau.createRun({ agentName: 'researcher', ... })` runs it as a session run; both resolve the same options, tools, and instructions. Both are refused with `NOT_FOUND` for a name that is not a ready agent.

`bureau.agents` keeps `names()`, `entries()`, `query()`, `get()`, and `has()` typed to the code-defined map. The combined view is `list()`: code agents first in definition order, then file agents by identifier, each with `id`, `source`, `state`, `name`, `description`, `published`, `owner`, `definitionHash`, and, for an invalid file, `problem`.

Every file agent belongs to the deployment's owner of record, `anonymous:local` in single-user mode. A file has no owner field, and an `owner` key in the frontmatter is just an unknown key.

## Watching

Bureau watches the directory, so adding, editing, or deleting a file takes effect without a restart. `fs.watch` is only a trigger: any event marks the catalog dirty, and one single-flight loop rescans the whole directory until nothing is dirty. Bursts coalesce, and since a rescan is idempotent it does not matter whether a change arrived as an edit, a rename into place, a delete, or the directory disappearing. There is no debounce interval. `fs.watch` can drop an event (on macOS a directory's creation went unreported in about one of two hundred runs of a test that made the directory and a file in it back to back), so a rescan every second backs it up; it reports nothing when nothing changed, and it bounds how long a change the watcher missed can go unseen. A directory that does not exist is an empty catalog, and its nearest existing ancestor is watched until it appears. A file read half-written is transiently invalid, and its completion triggers the rescan that corrects it.

`bureau.agents.onChange(listener)` is called after every rescan that added, changed, or removed an agent, with the identifiers, and `bureau.agents.refresh()` rescans now. A host that replaces the model catalog after the Bureau exists calls `refresh()`, because a file's model is revalidated when a scan sees the catalog's revision change.

## Writing

`bureau.agents.read(id)` returns the file's text and `hash`, the SHA-256 of its bytes. `create(id, definition)`, `update(id, definition, { expectedHash })`, and `delete(id, { expectedHash })` write through the same files. Each checks that the result would load (schema, identifier, model, tools, code names) and writes nothing otherwise, throwing `AgentFileError` with the codes above.

A write goes to a temporary dotfile in the same directory and is renamed into place, so nothing reads half a file. Writes are serialized in this process. `create` throws `AgentFileConflictError` (`agent-file-exists`) when the file exists. `update` and `delete` throw it (`agent-file-changed`, with `currentHash`) when the bytes no longer hash to `expectedHash`, and `AgentFileError` (`agent-file-not-found`) when the file is gone.

`update` keeps the frontmatter keys Bureau does not know, in place, and the body byte for byte when the supplied instructions equal it. A frontmatter whose meaning does not change keeps its original text, and an update that changes nothing writes nothing. A frontmatter that does change is re-emitted by `js-yaml` `dump`, which drops YAML comments and reformats it; the body stays untouched.

There is no cross-process file lock. A different process writing the same file in the instant between a write's last check and its `rename` is not detected, because `rename` replaces whatever is there and, for `create`, cannot refuse an existing target. The window is the time between two system calls.

## Snapshots

A run uses the definition it started with. When a run of a file agent starts, Bureau stores the parsed definition in its database under `bureau-agent-snapshot:v1:<id>:<hash>`, where the hash is the file's, and ties the run to it with `bureau-agent-run:v1:<runId>`. The run records the hash (`agentDefinitionHash` in a `bureau.run` run's recovery record, `lastAgentDefinitionHash` in a session run's metadata), and the snapshot is written before the record that names it.

Editing or deleting the file mid-run does not change the run, because the agent object was built from the snapshot's values. A run resumed after a restart is rebuilt from the snapshot, with the model and tools resolved against the catalogs as they are now, even if the file is gone. A snapshot that was pruned fails the resume with `AgentSnapshotError` (`snapshot-missing`), and a model or tool the deployment no longer has fails it with `snapshot-unresolvable`. Neither falls back to the current file.

`bureau.agents.revisions(id)` lists the snapshots that have run for an identifier, most recently run first.

A snapshot is kept while any run that references it is retained, and pruned after the last one's retention ends:

- A session run's reference goes when its task is deleted (the `run.removed` event, which task retention triggers).
- Any run's reference also goes once it has been settled for longer than `BureauOptions.taskRetention` (default 30 days; `'forever'` prunes nothing). The durable maintenance pass does this. It is what releases a `bureau.run` run, which leaves the run store the moment it settles and was never subject to task retention before. Those runs now have a snapshot retention window equal to `taskRetention`.
- A run that has not settled keeps its snapshot indefinitely, because it may still be resumed.

## Limits

- The steering agent-identity override still validates against the code-defined map only. A file agent is not a steering target.
- Writes are not safe against another process editing the same file (see Writing).
- Per-user directories, Git history of the directory, and the network operations (COR-1526) are out of scope.
