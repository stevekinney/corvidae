# Skills

`@corvidae/skills` supplies procedural knowledge to Corvidae agent runtimes. It lets the runtime keep a small catalog of available capabilities in context, load full instructions only when an agent chooses a relevant skill, and then fetch larger bundled resources on demand.

Persistent sessions, memory, tools, schedulers, and durable workflows can share repeatable operating knowledge through skills instead of hard-coding every procedure into system prompts or runtime code.

## Workspace usage

Declare `"@corvidae/skills": "workspace:*"` in the consuming workspace's dependencies. Install dependencies from the Corvidae root with `bun install`. Import the private package through `@corvidae/skills`; it exports TypeScript source directly and has no library build or publication step.

## Mental Model

Skills use progressive disclosure:

- **Catalog**: The agent sees a compact `<available_skills>` block with each skill name and description.
- **Instructions**: The agent calls `activate_skill` to load one skill's full `SKILL.md` body into context.
- **Resources**: The agent calls `load_skill_resource` for larger files bundled beside the skill, such as checklists, scripts, examples, or templates.

This keeps normal runs cheap and focused while still making specialized procedures available when the task calls for them.

## Runtime composition

Corvidae has several extension points: `@corvidae/armorer` tools, `@corvidae/operative` hooks, `@corvidae/memory` recall, and application-owned runtime composition. Skills connect those extension points into one workflow:

- Applications can inject the skill catalog on the first step of a run and add skill management tools to the active toolbox.
- `operative` can consume skill hooks and enforce the tool policy from active skills.
- `armorer` provides the validated tools for activating skills, loading resources, and reviewing proposals.
- `memory` can store skill-specific learning in isolated `skill:{name}` namespaces.
- Storage-backed providers let skill state survive process restarts through the same durable storage model used elsewhere in the project.

Without this package, procedural knowledge would either live in large always-on prompts or in scattered product code. Skills make it portable, auditable, and activatable at runtime.

## Skill File Format

A skill is a _directory_ containing a `SKILL.md` file, plus any resources it bundles:

```
code-review/
├── SKILL.md          # required: frontmatter + instructions
├── scripts/          # optional
├── references/       # optional
└── assets/           # optional
```

```md
---
name: code-review
description: Review code changes for correctness, tests, and maintainability.
license: Apache-2.0
allowed-tools: Read Grep Bash(git:*)
metadata:
  owner: platform
---

Read the diff first. Prioritize correctness issues, regressions, missing tests, and unclear ownership boundaries.

When a referenced checklist is needed, load `references/checklist.md`.
```

### The pinned specification

This package validates against the [Agent Skills specification](https://github.com/agentskills/agentskills) at one exact revision, exported as `AGENT_SKILLS_SPECIFICATION_REVISION`. The rules are transcribed from that revision's official reference validator (`skills-ref`) rather than from its prose, because the two disagree about Unicode names and the validator is what a publisher's skill is actually checked against.

`name` and `description` are required. The complete set of fields the specification defines is `name`, `description`, `license`, `compatibility`, `allowed-tools`, and `metadata` — **strict validation rejects every other top-level key**, which is how a portable `denied-tools` is refused. A skill author must not be able to disable a tool for the agent that loaded them; native deny policy belongs in Bureau configuration.

| Field | Rule |
| --- | --- |
| `name` | 1–64 characters; NFKC-normalized; lowercase; no leading, trailing or consecutive hyphens; letters, digits and hyphens only. Unicode letters and a leading digit are both allowed. Must equal the skill's directory name. |
| `description` | Non-empty, at most 1024 characters. |
| `compatibility` | At most 500 characters. |
| `allowed-tools` | **One space-separated string**, e.g. `Bash(git:*) Bash(jq:*) Read`. It may only _narrow_ authority the run already has, never add to it. |
| `metadata` | A map of string keys to string values. |

`allowed-tools` was comma-separated in earlier versions of this package. It is not: a comma appears _inside_ a real tool request such as `Bash(git:*)`, and splitting on one shreds it. A YAML sequence is read as well, because the reference validator accepts one, but portable output is always the single space-separated string.

### Strict parsing and diagnostic import

The two are deliberately separate, and the distinction is the whole point:

- **`parseSkillMarkdown(text, options?)`** validates strictly and repairs nothing. It throws `SkillConformanceError` (carrying every failure, not just the first) when the document parses but does not conform, and `SkillParseError` when it does not parse at all.
- **`importSkillMarkdown(text, options?)`** repairs what it can, preserves unknown fields losslessly in `preservedFields`, and reports every change in `repairs`. It returns conformance failures rather than throwing.

An import is **never** labelled `conformant` on the strength of a repair, however small: what a publisher ships is the original bytes, and those are what another client will strictly validate.

Pass `{ directoryName }` to either one to enable the specification's name-must-match-directory rule. Omit it — for a registry payload with no directory — and that rule is skipped, exactly as the reference validator skips it.

## How It Works

The package has four main parts:

- **Providers**: `SkillProvider` implementations list, load, save, delete, enable, disable, and serve resources for skills.
- **Sessions**: `createSkillSession()` tracks which skills are active for one run and intersects their `allowed-tools`.
- **Hooks**: `createSkillCatalogHook()` returns a `prepareStep` hook that renders the catalog on step 0.
- **Tools**: `createSkillToolbox()` creates `activate_skill`, `load_skill_resource`, `deactivate_skill`, and `list_skills`.

- **Artifacts**: `readSkillArtifact()` reads a skill directory into a complete bounded `SkillArtifact` — every file, with digests and deterministic ordering.
- **Discovery**: `discoverSkills()` and `createSkillCatalogService()` turn configured sources into immutable, trust-aware catalog revisions.

The storage-backed provider writes skills under keys such as `skill:{name}:metadata`, `skill:{name}:body`, `skill:{name}:resource:{path}`, and `skill:{name}:enabled`. Resources are base64-encoded at that string-only boundary so binary content survives. The static provider keeps the same interface in memory for tests, local bundles, and browser-safe use cases.

### Resources are bytes

`SkillProvider.loadResource()` and `saveResource()` carry `Uint8Array`, not `string`. A bundle legitimately contains images, fonts and other binary assets, and decoding one as UTF-8 replaces every invalid sequence with `U+FFFD` — silent, irreversible corruption. Decoding happens at the model-facing `load_skill_resource` tool, which is the one place text is actually required.

### Artifacts and admission

`readSkillArtifact(directory, options?)` walks the whole tree and returns either an admitted `SkillArtifact` or the typed diagnostics explaining why not. It never returns a partial bundle: a caller holding half a skill cannot tell which half of its instructions is missing.

Refused before any content is read: absolute paths, `..`, backslashes, NUL bytes, duplicate normalized paths, symbolic links resolving outside the skill root, special files such as FIFOs and sockets, oversized files, too many files, and exceeded scan depth or directory limits. Size and count limits are checked from the directory walk's own `stat`, so an oversized file is refused rather than loaded and then rejected.

Two containment limits are documented rather than implied. A **hard link** inside the root to a file outside it is admitted — a link carries no record of where it was made, so it is indistinguishable from an ordinary file, and creating one already requires read access to the target. Resolving a path and then reading it is inherently **time-of-check to time-of-use**; closing that needs descriptor-based traversal, and the assumption here is that the skill tree is not under concurrent hostile modification.

Nothing in this package executes anything it reads. Scripts are inert content — read, catalogued, digested and decoded exactly like any other resource.

## Basic Usage

Discovery decides what exists; a **client** is what a single run holds. It takes a catalog revision and a way to load an artifact, and owns that run's active set.

```typescript
import {
  createFilesystemArtifactLoader,
  createSkillClient,
  createSkillClientToolbox,
  discoverSkills,
  renderClientCatalog,
} from '@corvidae/skills';

const catalog = await discoverSkills({
  sources: [{ id: 'user', kind: 'user', location: '/path/to/skills', precedence: 20 }],
});

const client = createSkillClient({ catalog, loadArtifact: createFilesystemArtifactLoader() });

// The tier-one block a host injects on the first step, or `undefined` when nothing is offered.
renderClientCatalog(client);

// `undefined` rather than an empty toolbox: a model handed `activate_skill` against an empty
// catalog wastes a turn discovering nothing exists, and sometimes invents a name to pass it.
const skillTools = createSkillClientToolbox(client);
```

The revision the client was built from is a **run input**: it is frozen, so a source changing on disk mid-run cannot rewrite instructions already admitted to the conversation. `client.catalog()` returns that same revision, and a host that wants newer skills builds a new client from a newer revision rather than mutating this one.

### Client ownership

Create a separate client for each run or conversation whose activations should be isolated. A catalog revision is shared, immutable content; a client owns which of it is active. Reusing a revision shares what exists, while reusing a client shares activation state and the narrowed tool set that follows from it.

Skill text is executable guidance for an agent, not an authorization grant. The host remains responsible for which tools exist, what those tools may do, and whether a principal can accept a proposal. Signature or digest verification establishes the fetched bytes' provenance; it does not make their instructions appropriate for every run.

### Delegation attenuates

`client.attenuate({ skills, tools })` returns a child client that can reach **at most** what the parent could. Naming a skill the parent has no access to grants nothing, tool requests are intersected with the skill's own `allowed-tools` rather than unioned, and a grandchild narrows further without ever widening back. A refusal outside the grant is typed `not-delegated` and names nothing the caller was not offered, so a rejected guess cannot be used to enumerate what exists.

## Discovery, Trust, and the Catalog

Discovery turns configured _sources_ into an immutable _catalog revision_. Nothing here loads a skill into a provider; it decides what exists, where it came from, whether it may be used, and why not.

```typescript
import {
  createSkillCatalogService,
  defaultSkillSources,
  admitSources,
  generalCatalogProjection,
} from '@corvidae/skills';

const service = createSkillCatalogService({
  sources: defaultSkillSources({ projectRoot: process.cwd() }),
  // Without this, the project source is discovered but nothing from it is available.
  trustPolicy: admitSources(['project']),
});

// A pure read. It starts no scan and returns the identical object until a refresh commits.
service.catalog();

const refresh = service.refresh();
await refresh.result();

generalCatalogProjection(service.catalog()); // [{ name, description }]
```

### Sources

A `SkillSource` has an `id` (stable identity), a `kind`, a `location` (canonical, never credential-bearing), and an explicit `precedence`. Precedence lives on the source rather than on the array, so reordering configuration cannot silently change which skill shadows which.

`defaultSkillSources()` builds the documented defaults: `<project>/.agents/skills` and `<home>/.agents/skills`. The `.claude/skills` compatibility root is **opt-in** via `includeCompatibilityRoots` — a workspace that happens to have one is not thereby asking this runtime to load it.

### Trust

Project sources are **untrusted by default**, and that is the point: opening a repository must not be the same act as granting its `.agents/skills` directory the ability to put instructions in front of a model. User and built-in sources reflect a deliberate installation. Remote sources are untrusted until an integrity policy admits them.

An untrusted source's skills are still **discovered** — they appear in the catalog, unavailable, with the reason attached — so a host can offer "this workspace has 3 skills, trust it?" rather than pretending they do not exist.

### Catalog entries

Each `SkillCatalogRecord` carries `name`, `description`, `directoryName`, `sourceId`, `sourceKind`, `sourceLocation`, `bundleSupport`, `trust` and `trustReason`, `artifactDigest`, a `compatibility` verdict, and `available` with an `unavailableReason` (`source-untrusted`, `source-revoked`, `shadowed`, `invalid`, `unreadable`). A shadowed entry stays in the catalog marked as such, with `shadowedBy` — an operator asking "why is my project skill not the one running" needs to see both.

Its `digest` covers every field the catalog exposes, including `sourceLocation`, `bundleSupport` and the source diagnostics — a digest blind to those reports `unchanged` after a source moves, and keeps serving the stale value for ever.

`generalCatalogProjection()` is the tier-one view a model may see: exactly `name` and `description`, built by omission rather than redaction, so a field added later cannot leak by being forgotten.

`compatibility` is where a strict-validation verdict lives per entry. A skill that is merely non-portable — an unknown frontmatter key, a name disagreeing with its directory — stays available with its diagnostics attached; one with no usable identity is marked `invalid`.

### Catalog revisions are immutable

A revision is frozen **at every level** — records, `compatibility`, and each diagnostics array — and numbered. `Object.freeze` is shallow, so freezing only the revision and its arrays would let one holder mutate an entry and change what every other holder sees while the digest still attested to the original. A revision handed in as `initial` is cloned for the same reason. A source changing on disk produces a **later** revision and never edits an earlier one, so instructions already admitted to a conversation cannot be rewritten underneath it by someone editing a file. `service.catalog()` returns the identical object by reference until a refresh commits a new one, which lets a caller diff by identity instead of entry by entry. A refresh that finds identical content reports `unchanged` and commits nothing.

### Refresh is started work

`service.refresh()` returns a handle conforming to the repository's started-work control contract (`documentation/operative-type-safe-api.md`): `snapshot()` is cached and side-effect-free, `subscribeSnapshot()` delivers the current snapshot _before returning_ and then every later revision, `abort()` is idempotent, `result()` never rejects, and `closed()` memoizes a cleanup acknowledgement from the shared vocabulary (`not-required`, `completed`, `failed`, `unresolved`). A cancellation request disqualifies the `not-required` fast path.

A cancelled discovery still produces a revision, marked `cancelled`, rather than throwing: a caller that aborted still wants to know what was found.

### Diagnostics

`SkillSourceDiagnostic.code` distinguishes what went wrong, because a host cannot act on one catch-all: `unavailable`, `untrusted`, `revoked`, `admission-failed` (a bundle the artifact layer refused), `containment-refused` (a skill directory that is itself a link out of the root), `name-conflict` (two sources serving different content under one name), `duplicate-source-id`, and `cancelled`.

### Scans are bounded and abortable

A source's scan is bounded two ways, because each alone is wrong: counting only admitted skill directories lets a root full of stray files cost an unbounded number of syscalls, and counting only raw entries lets those files hide every real skill behind them. The abort signal is checked _inside_ the enumeration, since walking a large directory is precisely the slow part a caller wants to cancel — honouring it only between sources leaves a single large root unresponsive for its whole duration.

A skill directory that is itself a symbolic link is resolved and contained against the canonical root, including a link resolving to the root itself, which would otherwise make the entire discovery tree look like one bundle. An in-root alias is de-duplicated by resolved target, so it cannot become a phantom duplicate that out-sorts the real directory.

### Remote sources

A remote source names the skills it serves — never a wildcard crawl — and must configure an integrity policy: pinned SHA-256 digests, an Ed25519 public key, or both. A source with neither is refused **without a single request being made**, because content arriving with nothing to check it against is exactly the case where "fetch it and see" is how untrusted instructions reach a model.

Integrity is checked over the **raw bytes** the registry served, not a decoded copy: `response.text()` strips a BOM and replaces invalid UTF-8, so digesting its output would verify something other than what was sent. A matching pinned digest admits on its own and no signature is fetched. Otherwise a detached signature must be retrievable at `{location}/{name}/SKILL.md.sig` and verify; anything other than a clean 200 fails closed. A digest mismatch or an invalid signature is always a refusal — that is tamper evidence, not an absent policy.

Because this transport carries only `SKILL.md`, a remote entry is `bundleSupport: 'manifest-only'`. Claiming complete bundle support would promise `references/` and `assets/` that no resource load could ever return.

### Durable storage as a source

A skill does not have to live on a filesystem: the self-improvement flow writes an accepted proposal straight into a key-value store. Pass that store as `storage` and its skills are catalogued, digested, trust-decided and activated by exactly the same path as a filesystem one.

```typescript
import { discoverSkills } from '@corvidae/skills';

const catalog = await discoverSkills({
  sources: [{ id: 'storage', kind: 'storage', location: 'kv://skills', precedence: 25 }],
  storage: store,
});
```

The stored form is a metadata record plus a body, so the manifest is re-serialized from them and run through the strict parser: coming from our own store is not a reason to trust its shape. A `storage` source is **trusted** by default — it holds what this runtime itself admitted and persisted, and treating it as untrusted would make an accepted proposal unusable by the run that accepted it — but an explicit trust policy still revokes it. A skill marked disabled is omitted rather than catalogued as unavailable, because `enabled` is an operator switch on the store, not a verdict about the skill.

`createStorageSkillProvider(store)` remains the **write** surface for that store, which is what the proposal flow needs. Reading is discovery's job.

## Runtime integration

The host application creates a skill session, injects the catalog on the first step, and combines its base toolbox with the skill-management tools. Compose those package APIs directly where the application assembles its runtime.

A skill-enabled run follows this sequence:

- Step 0 gets an `<available_skills>` system message.
- The agent calls `activate_skill` when one catalog entry matches the task.
- The active skill's instructions are returned in a `<skill_content>` block.
- If the skill lists resources, the agent can call `load_skill_resource`.
- An active skill's `allowed-tools` narrows the available tool set for the run. It can only remove tools, never add one the run did not already have.

Use the session, hooks, and tool factories below to wire this behavior into the application runtime.

## Memory and Learning

`createSkillMemory(memory, skillName)` wraps any compatible memory implementation and forces reads and writes into the `skill:{name}` namespace. The wrapper overrides the namespace on its `remember` and `recall` calls. The host still owns authorization: callers with direct access to the underlying memory can choose that namespace themselves.

`createSkillMemoryHooks()` can recall skill-specific memories on the first step and store final responses as experiential skill learning. The hooks degrade gracefully: memory failures should not crash an agent run.

## Proposal Workflows

The self-improvement helpers store proposed changes in durable storage and expose review tools:

- `list_proposals`
- `view_proposal`
- `accept_proposal`
- `reject_proposal`

Accepting a skill proposal parses its content as `SKILL.md` and saves it through the configured `SkillProvider`. Rejecting a proposal records a content hash so the same content is not proposed again.

## Package Structure

### `@corvidae/skills` (root)

The primary API covering providers, parsing, ingestion, sessions, hooks, tools, proposals, and all public types.

```typescript
import {
  createSkillClient,
  createSkillClientToolbox,
  createFilesystemArtifactLoader,
  discoverSkills,
  createStorageSkillProvider,
  parseSkillMarkdown,
  importSkillMarkdown,
  serializeSkillMarkdown,
  isValidSkillName,
  readSkillArtifact,
  readStoredSkillArtifacts,
  createSkillMemory,
  createSkillMemoryHooks,
  createProposalToolbox,
  saveProposal,
  acceptProposal,
  rejectProposal,
  listProposals,
} from '@corvidae/skills';
```

**Parsing:**

- **`parseSkillMarkdown(text, options?)`**: Parses a `SKILL.md` string strictly into a `SkillContent`. Throws `SkillConformanceError` when it parses but does not conform, `SkillParseError` when it does not parse. Repairs nothing.
- **`importSkillMarkdown(text, options?)`**: Diagnostic import. Returns `{ content, preservedFields, repairs, conformance, conformant }`.
- **`serializeSkillMarkdown(content)`**: Serializes a `SkillContent` back to a portable `SKILL.md`, carrying only fields the specification defines.
- **`validatePortableFrontmatter(frontmatter, options?)`**: Returns every strict-conformance failure for already-parsed frontmatter. Empty means conformant.
- **`isValidSkillName(name)`** / **`isPortableSkillName(name)`**: Returns `true` when the name satisfies the pinned specification's grammar.
- **`normalizeSkillName(name)`**, **`parseAllowedTools(value)`**, **`serializeAllowedTools(tools)`**: The normalization the specification requires, exported so callers can apply it consistently.
- **`AGENT_SKILLS_SPECIFICATION_REVISION`**, **`AGENT_SKILLS_SPECIFICATION_REPOSITORY`**, **`PORTABLE_FRONTMATTER_FIELDS`**, **`MAXIMUM_SKILL_NAME_LENGTH`**, **`MAXIMUM_DESCRIPTION_LENGTH`**, **`MAXIMUM_COMPATIBILITY_LENGTH`**: The pinned contract, as constants.

**Artifacts:**

- **`readSkillArtifact(directory, options?)`**: Reads a skill directory into a bounded `SkillArtifact`, or returns typed admission diagnostics.
- **`createSkillArtifact(name, files, options?)`**: The same admission rules over files a caller already holds, without touching a filesystem.
- **`normalizeArtifactPath(path)`**, **`resolveMediaType(path)`**, **`findArtifactEntry(artifact, path)`**, **`findArtifactManifest(artifact)`**, **`decodeArtifactText(entry)`**: Helpers over an admitted artifact.
- **`DEFAULT_SKILL_ADMISSION_LIMITS`**, **`resolveAdmissionLimits(limits?)`**: The default bounds (1 MiB per file, 8 MiB per artifact, 256 files) and how partial limits resolve against them.

**Storage:**

- **`createStorageSkillProvider(store)`**: The write surface over a `TextValueStore`, persisting skills under structured keys. Reading them back is discovery's job, via the `storage` source.

**Discovery:**

- **`discoverSkills(options)`**: Builds one immutable `SkillCatalogRevision` from the configured sources. Takes `sources`, an optional `trustPolicy`, `limits`, an `AbortSignal`, and `remote` transport for remote sources.
- **`createSkillCatalogService(options)`**: A catalog whose `catalog()` read starts no work and whose `refresh()` returns a started-work handle.
- **`defaultSkillSources(options?)`**: The documented project and user roots, with the `.claude/skills` compatibility root opt-in.
- **`admitSources(ids)`**: A trust policy admitting exactly the named source identifiers.
- **`resolveTrust(source, policy?)`** / **`defaultTrustForKind(kind)`**: The trust decision and its per-kind default.
- **`materializeRemoteSource(source, options)`**: Fetches and verifies a remote source's skills, refusing anything its integrity policy does not admit.
- **`readStoredSkillArtifacts(store, options?)`**: Reads a `TextValueStore`'s skills as artifacts, so a stored skill is catalogued by the same path as a filesystem one.
- **`availableRecords(revision)`**, **`findRecord(revision, name)`**, **`generalCatalogProjection(revision)`**: Reads over a revision.
- **`AGENTS_SKILLS_DIRECTORY`**, **`CLAUDE_SKILLS_DIRECTORY`**, **`DEFAULT_SOURCE_PRECEDENCE`**: The documented conventions, as constants.

**Clients:**

- **`createSkillClient(options)`**: The run's own view of a catalog revision: what it may activate, what is active, and which tools that narrows to. `attenuate(grant)` returns a child that can reach at most what this one could.
- **`createSkillClientToolbox(client)`**: `activate_skill`, `deactivate_skill` and `load_skill_resource` over a client, or `undefined` when it has nothing to offer.
- **`createFilesystemArtifactLoader()`** / **`createStaticArtifactLoader(artifacts)`**: How a client turns a catalog record into bytes. The filesystem loader re-verifies the recorded digest and reports `changed` rather than loading content the catalog never attested to.
- **`renderClientCatalog(client)`** / **`renderActiveSkillInstructions(active)`**: The tier-one catalog block and the tier-two instruction block a host injects.

**Session:**

- **`createSkillSession()`**: Creates a `SkillSession` that tracks active skills and merges their `allowed-tools` across activations. Merging intersects, so each additional active skill can only narrow further.

**Hooks:**

- **`createSkillCatalogHook(options)`**: Returns a `{ prepareStep }` hook. On step 0 its `prepareStep` returns the `<available_skills>` XML string (the caller injects it into the conversation; the hook does not inject it itself). Pass `{ provider, skillPolicy? }`.
- **`escapeXml(text)`**: Escapes characters that would break the `<available_skills>` XML block.

**Tools:**

- **`createSkillToolbox(options)`**: Returns a plain object of four `Tool` instances—`{ activateSkill, loadSkillResource, deactivateSkill, listSkills }` (the `activate_skill`, `load_skill_resource`, `deactivate_skill`, and `list_skills` tools). It is not an armorer `Toolbox`; spread the tools into `createToolbox([...])` to build one.
- **`createActivateSkillTool(options)`**: Creates just the `activate_skill` tool.
- **`createLoadSkillResourceTool(options)`**: Creates just the `load_skill_resource` tool.
- **`createDeactivateSkillTool(options)`**: Creates just the `deactivate_skill` tool.
- **`createListSkillsTool(options)`**: Creates just the `list_skills` tool.
- **`isSkillContent(message)`**: Returns `true` if a message string contains an embedded `<skill_content ...>` marker. Used by context compactors to detect injected skill content. Signature: `isSkillContent(message: string): boolean`.

**Memory:**

- **`createSkillMemory(memory, skillName)`**: Wraps a `MemoryLike` to namespace all reads and writes under `skill:{skillName}`.
- **`createSkillMemoryHooks(options)`**: Returns a `{ prepareStep, onStep }` hook pair that recalls and stores skill-specific memory.

**Proposals:**

- **`createProposalToolbox(options)`**: Returns a plain object of four `Tool` instances—`{ listProposals, viewProposal, acceptProposal, rejectProposal }` (the `list_proposals`, `view_proposal`, `accept_proposal`, and `reject_proposal` tools). Like `createSkillToolbox`, it is not an armorer `Toolbox`; spread the tools into `createToolbox([...])` to build one.
- **`createAcceptProposalTool(options)`**, **`createListProposalsTool(options)`**, **`createRejectProposalTool(options)`**, **`createViewProposalTool(options)`**: Create individual proposal tools.
- **`saveProposal(store, content, options?)`**: Persists a skill proposal to storage.
- **`acceptProposal(store, id, provider, options?)`**: Parses the proposal as `SKILL.md` and saves it through the provider.
- **`rejectProposal(store, id, options?)`**: Records the proposal's content hash as rejected so duplicates are blocked.
- **`listProposals(store, options?)`**: Returns all stored proposals.
- **`getProposal(store, id)`**: Returns a single `Proposal` by ID, or `undefined`.
- **`clearProposals(store, options?)`**: Removes all proposals from storage. `options.runtime` (a `RuntimeServices` from `lifecycle`) controls the clock used for `options.olderThanMs` age comparisons; defaults to the real clock.
- **`isRejectedPattern(store, content)`**: Returns `true` if the content hash matches a previously rejected proposal.

### Test utilities

Testing utilities for code that depends on `SkillProvider`. Both require no filesystem or network access, but their methods are async (Promise-returning)—`await` store and provider calls as the examples below do.

```typescript
import { createMockKeyValueStore, createMockSkillProvider } from '@corvidae/skills';
import { parseSkillMarkdown } from '@corvidae/skills';

// In-memory TextValueStore backed by Weft MemoryStorage—
// drop-in replacement for production stores in unit tests.
const store = createMockKeyValueStore();
await store.set('hello', 'world');
const value = await store.get('hello'); // 'world'

// Mock SkillProvider with full call tracking
const provider = createMockSkillProvider([
  parseSkillMarkdown(`---
name: code-review
description: Review code.
---
Body here.
`),
]);

const catalog = await provider.listSkills();
// [{ name: 'code-review', description: 'Review code.' }]

const skill = await provider.loadSkill('code-review');
// { metadata: { name: 'code-review', ... }, body: 'Body here.' }

// Inspect every method call for assertions
const calls = provider.calls;
// [{ method: 'listSkills', args: [] }, { method: 'loadSkill', args: ['code-review'] }]
```

**Key exports:**

- **`createMockKeyValueStore()`**: Returns a `TextValueStore` backed by Weft's `MemoryStorage`. No `init()` or setup is required, but all `TextValueStore` methods (`get`, `set`, `delete`, `list`, etc.) are async and return Promises—`await` them.
- **`createMockSkillProvider(initialSkills?)`**: Returns a `SkillProvider` plus a `calls` array. Every method call—`listSkills`, `loadSkill`, `saveSkill`, `deleteSkill`, `listResources`, `loadResource`, `saveResource`, `isEnabled`, `setEnabled`—is logged to `calls` as `{ method, args }`. `loadResource` and `saveResource` carry `Uint8Array`; encode and decode with `TextEncoder`/`TextDecoder` when a test's subject is text.

## Development

Run the focused checks from this package directory:

```bash
bun run lint
bun run typecheck
bun run test
```

From the Corvidae root, run `bunx turbo run lint typecheck test --filter=@corvidae/skills` for this workspace or `bun run validate` for the complete workspace. Formatting is configured at the root. This library has no build or publishing command.

### Conformance cross-check

The pinned corpus in `test/fixtures/agent-skills-corpus.ts` runs against this package on every `bun test`. It can also be run against the **actual** official reference validator, which proves the corpus's expectations match upstream rather than merely matching this package:

```bash
AGENT_SKILLS_REFERENCE_VALIDATOR=uvx bun test packages/skills/test/conformance-reference.test.ts
```

This is opt-in on purpose. `skills-ref` is a Python package, and wiring it into the default suite would put a hard `uv` dependency on `bun run validate` in a Bun-only workspace. `uvx` fetches it pinned at `AGENT_SKILLS_SPECIFICATION_REVISION`; set the variable to an executable name instead to use an installed copy.

The corpus records one deliberate divergence — `strictyaml` bans flow-style mappings and `js-yaml` accepts them under any schema — as a `knownDivergence`, asserted _as_ a divergence so it cannot close or widen unnoticed. **Moving the pin is a superseding decision, not a patch**: record the new revision, re-run the corpus, and classify every newly non-conformant skill as a diagnostic-import repair or a rejection before the new baseline becomes strict.
