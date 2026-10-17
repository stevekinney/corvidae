# Bungalow

`@lostgradient/bungalow` resolves and prepares a local application's state directory: its database path, configuration path, secrets, logs, and file-based content directories. Interborough keeps its state in `~/.interborough`, or wherever `INTERBOROUGH_HOME` points. Bungalow targets macOS and Linux, and it is a private source package that is not published.

Bungalow only hands out paths. It never opens a database, parses configuration, or reads the contents of a content directory. Storage engines belong in Weft.

## Workspace usage

Declare `"@lostgradient/bungalow": "workspace:*"` in the consuming workspace's dependencies and install from the Corvidae root with `bun install`. The package exports TypeScript source directly and has no build or publication step.

## Choosing the root

`resolveBungalowRoot({ name, environment, homeDirectory })` is a pure function. It returns `<NAME>_HOME` when that variable is set and non-empty, where `<NAME>` is the application name uppercased with `-` turned into `_`. Otherwise it returns `<homeDirectory>/.<name>`. Both values must be absolute paths, because a state directory that follows the working directory loses data.

An application name matches `^[a-z][a-z0-9-]*$`. A secret key or content directory name matches `^[a-z0-9][a-z0-9-]*$`. Anything else throws `BungalowInputError`. Error messages never echo a secret key or value.

## Opening a Bungalow

```typescript
import { openBungalow } from '@lostgradient/bungalow';

const bungalow = openBungalow({ name: 'interborough' });

bungalow.database; // <root>/database.sqlite
bungalow.configuration; // <root>/configuration.json
bungalow.directory('agents'); // <root>/agents, created 0700 if absent

bungalow.writeSecret('api-key', value); // <root>/secrets/api-key, mode 0600
bungalow.readSecret('api-key'); // the value, or undefined when never written

bungalow.close();
```

Opening creates the root (mode `0700`), `secrets/` (mode `0700`), `logs/`, and the `deployment-id` file. It does not create the database or configuration file, and a missing configuration file is valid. Directories that already exist keep the mode they have.

`deploymentId` is a ULID generated on the first open and persisted at `deployment-id`, so every later open of the same root returns it. The generator is a small hand-written one (`src/ulid.ts`), a 48-bit millisecond timestamp followed by 80 random bits from `crypto.getRandomValues`, in Crockford base32, so the package adds no dependency. A `deployment-id` file that does not hold a ULID throws `BungalowStateError` rather than being replaced, because replacing it would change the deployment's identity.

## The single-instance lock

Holding a handle holds the root's `lock` file, which records the holder's process identifier. A second open of a held root, in this process or another, throws `BungalowLockedError` carrying `holderProcessIdentifier`. A lock whose holder process no longer exists is reclaimed, so a crash never leaves the root unusable. `close()` releases the lock and is idempotent; a closed handle throws `BungalowStateError` on any further use.

The lock file is created by hard-linking a fully written file, so a reader never sees a half-written lock. The operating system can reuse a dead holder's process identifier for an unrelated process; the lock then looks held until you remove the `lock` file named in the error.

## Tests

`process.env.NODE_ENV === 'test'` is the guard against a test touching a developer's real home directory. Under it, `openBungalow` throws unless `<NAME>_HOME` is set. A test calls `openTemporaryBungalow({ name })`, which creates an isolated root under the operating system's temporary directory and removes it on `close()`, or points `<NAME>_HOME` at a directory it owns.

The one place the package reads `process.env` is `src/environment-configuration.ts`. Every function that depends on the environment also accepts it as a value.
