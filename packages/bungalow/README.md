# Bungalow

`@lostgradient/bungalow` resolves and prepares a local application's state directory: its database path, configuration path, secrets, logs, and file-based content directories. Interborough keeps its state in `~/.interborough`, or wherever `INTERBOROUGH_HOME` points. Bungalow targets macOS and Linux only, and it is a private source package that is not published.

Bungalow only hands out paths. It never opens a database, parses configuration, or reads the contents of a content directory. Storage engines belong in Weft.

## Workspace usage

Declare `"@lostgradient/bungalow": "workspace:*"` in the consuming workspace's dependencies and install from the Corvidae root with `bun install`. The package exports TypeScript source directly and has no build or publication step.

## Choosing the root

`resolveBungalowRoot({ name, environment, homeDirectory })` is a pure function. It returns `<NAME>_HOME` when that variable is set and non-empty, where `<NAME>` is the application name uppercased with `-` turned into `_`. Otherwise it returns `<homeDirectory>/.<name>`. Both values must be absolute paths, because a state directory that follows the working directory loses data.

An override is normalized, so a trailing slash or a dot segment does not change the root. An application name matches `^[a-z][a-z0-9-]*$`. A secret key or content directory name matches `^[a-z0-9][a-z0-9-]*$`. Anything else throws `BungalowInputError`.

## Errors

Every error extends `BungalowError`. None of them carries a secret value or a secret key: messages name the operation and never an entry, and a `BungalowFilesystemError` keeps only the code, system call, and errno of the underlying failure as its `cause`, never its path, because a path inside `secrets/` ends in the key.

## Opening a Bungalow

```typescript
import { openBungalow } from '@lostgradient/bungalow';

const bungalow = openBungalow({ name: 'interborough' });

bungalow.database; // <root>/database.sqlite
bungalow.configuration; // <root>/configuration.json
bungalow.directory('agents'); // <root>/agents, created 0700 if absent

bungalow.writeSecret('api-key', 'sk-example'); // <root>/secrets/api-key, mode 0600
bungalow.readSecret('api-key'); // the value, or undefined when never written

bungalow.close();
```

Opening creates the root (mode `0700`), `secrets/` (mode `0700`), `logs/`, the `lock` file, and the `deployment-id` file. It does not create the database or configuration file, and a missing configuration file is valid. Every open sets the root and `secrets/` to `0700`, tightening a directory that was looser, and once it holds the lock it removes the temporary files a crash left in the root and in `secrets/`, matching only the names Bungalow itself gives them (`deployment-id.<pid>-<uuid>.tmp` in the root, `<key>.<pid>-<uuid>.tmp` in `secrets/`). `readSecret` sets a secret file that group or others could reach back to `0600` before it reads it.

A secret is written to a temporary file that is `0600` from its first byte, synced, renamed into place, and the directory entry is synced, so a crash leaves the old value or the new one.

`deploymentId` is a ULID generated on the first open and persisted at `deployment-id`, so every later open of the same root returns it. The generator is a small hand-written one (`src/ulid.ts`), a 48-bit millisecond timestamp followed by 80 random bits from `crypto.getRandomValues`, in Crockford base32, so the package adds no dependency. A `deployment-id` file that does not hold a ULID throws `BungalowStateError` rather than being replaced, because replacing it would change the deployment's identity.

## Entries Bungalow does not trust

A root sits in a directory that users and other tools also write to, so an entry inside it can be a symbolic link to somewhere else, a second hard link to a file elsewhere, or a FIFO that would block an `open` forever. `src/entry-guard.ts` is the one place that checks. Every entry Bungalow opens, reads, changes the mode of, truncates, or writes inside the root (the root when it already exists, `secrets/`, `logs/`, content directories, `lock`, `deployment-id`, each secret, and the temporary files) is opened with `O_NOFOLLOW` and `O_NONBLOCK`, and the descriptor is then checked with `fstat`: a directory must be a real directory, and a file must be a regular file with exactly one link. Only then does Bungalow `fchmod`, truncate, or read it, through that descriptor. Anything else throws `BungalowStateError` naming the kind of entry (`lock file`, `secrets directory`) and never a secret's key. Writing a secret renames a new file over the entry, so a write never goes through a link either, and the temporary-file sweep skips symbolic links. Every directory Bungalow creates is made durable by syncing the directory that contains it.

A root that is itself a symbolic link is refused, so point `<NAME>_HOME` at the real directory.

## The single-instance lock

Holding a handle holds an exclusive, non-blocking `flock(2)` on `<root>/lock`, taken through `bun:ffi` (`libSystem.B.dylib` on macOS, `libc.so.6` on Linux). The kernel is the arbiter: a second open of a held root, in this process or another, throws `BungalowLockedError`, and when a holder dies without closing, the kernel drops its lock at once. There is no stale lock to detect or reclaim, no process identifier to check for liveness, and no race between two openers.

After taking the lock the holder truncates the file and writes its process identifier as the first line. A contender that is refused reads only that first line to name the holder in `BungalowLockedError.holderProcessIdentifier`, so a later version can add lines. The identifier is advisory: `BungalowLockedError.holderProcessIdentifier` is `undefined` or can still name the previous holder during the short window between a holder taking the lock and writing its own identifier, and a crashed holder's identifier stays in the file until the next holder overwrites it. `close()` clears the file, releases the lock by closing the descriptor, and never removes the file. It is idempotent once it has succeeded, and it can be retried after a failure. A closed handle throws `BungalowStateError` on any further use.

The lock file is opened through that guard, and with close-on-exec.

The root must be on a local filesystem that supports `flock`. Network filesystems that do not honour it are unsupported, and a host that refuses the lock for any reason other than contention throws `BungalowFilesystemError`. On any platform other than macOS and Linux, opening throws `BungalowUnsupportedError`, and so does a Linux whose C library is not glibc, such as Alpine's musl, because the lock is bound to `libc.so.6`.

## Tests

`process.env.NODE_ENV === 'test'` is the guard against a test touching a developer's real home directory. Under it, `openBungalow` throws unless `<NAME>_HOME` is set. A test calls `openTemporaryBungalow({ name })`, which creates an isolated root under the operating system's temporary directory and removes it on `close()`, or points `<NAME>_HOME` at a directory it owns.

The one place the package reads `process.env` is `src/environment-configuration.ts`. Every function that depends on the environment also accepts it as a value.
