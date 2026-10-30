# Bungalow

`@lostgradient/bungalow` resolves and prepares an application's home: where its database and content live, its configuration, its secrets, its logs, and its deployment identity. Locally the home is a directory, `~/.interborough` or wherever `INTERBOROUGH_HOME` points for Interborough. Remotely it is a Postgres database, an S3-compatible bucket, and environment variables (see [Remote mode](#remote-mode)). Bungalow targets macOS and Linux only, and it is a private source package that is not published.

Bungalow hands out locations for the database and content, and reads the configuration, the secrets, and the deployment ID itself. It never connects to a database, parses configuration, or reads the contents of a content location. Storage engines belong in Weft. It has no runtime dependencies: remote mode uses Bun's built-in `Bun.S3Client` and `fetch`.

## Workspace usage

Declare `"@lostgradient/bungalow": "workspace:*"` in the consuming workspace's dependencies and install from the Corvidae root with `bun install`. The package exports TypeScript source directly and has no build or publication step.

## Choosing the root

`resolveBungalowRoot({ name, environment, homeDirectory })` is a pure function. It returns `<NAME>_HOME` when that variable is set and non-empty, where `<NAME>` is the application name uppercased with `-` turned into `_`. Otherwise it returns `<homeDirectory>/.<name>`. Both values must be absolute paths, because a state directory that follows the working directory loses data.

An override is normalized, so a trailing slash or a dot segment does not change the root. An application name matches `^[a-z][a-z0-9-]*$`. A secret key or content directory name matches `^[a-z0-9][a-z0-9-]*$`. Anything else throws `BungalowInputError`.

## Errors

Every error extends `BungalowError`. None of them carries a secret value or a secret key: messages name the operation and never an entry, and a `BungalowFilesystemError` keeps only the code, system call, and errno of the underlying failure as its `cause`, never its path, because a path inside `secrets/` ends in the key. In remote mode its `cause` is only `{ status }` or `{ code }`; see [Remote mode](#remote-mode).

## Opening a Bungalow

```typescript
import { openBungalow } from '@lostgradient/bungalow';

const bungalow = await openBungalow({ name: 'interborough' });

bungalow.mode; // 'local'
bungalow.database; // { kind: 'sqlite', path: '<root>/database.sqlite' }
bungalow.content('agents'); // { kind: 'directory', path: '<root>/agents' }, created 0700 if absent
bungalow.configurationLocation; // '<root>/configuration.json'
await bungalow.readConfiguration(); // the file's text, or undefined when it is absent
bungalow.writeConfiguration('{}\n'); // replaces it atomically, mode 0600; the caller validates the text
bungalow.secretLocation('api-key'); // '<root>/secrets/api-key'

bungalow.writeSecret('api-key', 'sk-example'); // <root>/secrets/api-key, mode 0600
bungalow.readSecret('api-key'); // the value, or undefined when never written

bungalow.close();
```

`openBungalow` and `openTemporaryBungalow` return a promise, so a mode that reads from a network can open without blocking. A Bungalow hands out locations, not bare paths, so a caller never assumes the home is a directory: `mode` is `'local'` or `'remote'`; `database` is `{ kind: 'sqlite', path }` or `{ kind: 'postgres', url }`; `content(name)` is `{ kind: 'directory', path }` or `{ kind: 's3', bucket, prefix }`; `configurationLocation` and `secretLocation(key)` are strings for messages and for a person editing by hand (the file's path in local mode), and the configuration's text comes from `readConfiguration()`. Local mode returns the `sqlite` and `directory` variants, remote mode the `postgres` and `s3` ones. `content(name)` rejects the names Bungalow keeps in the root (`secrets`, `logs`, `lock`, `deployment-id`).

Opening creates the root (mode `0700`), `secrets/` (mode `0700`), `logs/`, the `lock` file, and the `deployment-id` file. It does not create the database or configuration file, and a missing configuration file is valid. `writeConfiguration(text)` creates or replaces it: the text goes to `configuration.json.<pid>-<uuid>.tmp` (mode `0600`, synced), which is renamed over the file and then the root is synced, so a crash or failure at any step leaves the previous file whole. Bungalow stores the text as given and never parses it. A failure throws `BungalowFilesystemError`, whose message and cause carry neither the text nor a path. Every open sets the root and `secrets/` to `0700`, tightening a directory that was looser, and once it holds the lock it removes the temporary files a crash left in the root and in `secrets/`, matching only the names Bungalow itself gives them (`deployment-id.<pid>-<uuid>.tmp` and `configuration.json.<pid>-<uuid>.tmp` in the root, `<key>.<pid>-<uuid>.tmp` in `secrets/`). `readSecret` sets a secret file that group or others could reach back to `0600` before it reads it.

A secret is written to a temporary file that is `0600` from its first byte, synced, renamed into place, and the directory entry is synced, so a crash leaves the old value or the new one.

`deploymentId` is a ULID generated on the first open and persisted at `deployment-id`, so every later open of the same root returns it. The generator is a small hand-written one (`src/ulid.ts`), a 48-bit millisecond timestamp followed by 80 random bits from `crypto.getRandomValues`, in Crockford base32, so the package adds no dependency. A `deployment-id` file that does not hold a ULID throws `BungalowStateError` rather than being replaced, because replacing it would change the deployment's identity.

## Remote mode

Remote mode keeps the home in Postgres, an S3-compatible bucket, and environment variables, so that two instances can share it. Every variable is read from the `environment` passed to `openBungalow` (the process environment by default), and an empty value counts as unset. `<NAME>` is the application name uppercased with `-` turned into `_`, as for `<NAME>_HOME`: `INTERBOROUGH` for Interborough.

| Variable | Meaning |
| --- | --- |
| `<NAME>_DATABASE_URL` | The Postgres URL, handed out as `database`. Required in remote mode. |
| `<NAME>_BUCKET` | The bucket that holds configuration, content, and the deployment ID. Required in remote mode. |
| `<NAME>_BUCKET_PREFIX` | Optional. The key prefix inside the bucket. |
| `S3_ENDPOINT` | The S3 endpoint URL. Required in remote mode. |
| `S3_REGION` | The region. Required in remote mode. |
| `S3_ACCESS_KEY_ID` | The access key ID. Required in remote mode. |
| `S3_SECRET_ACCESS_KEY` | The secret access key. Required in remote mode. |
| `S3_SESSION_TOKEN` | Optional. A session token for temporary credentials. |
| `<NAME>_SECRET_<KEY>` | The secret `<key>`, with the key uppercased and `-` turned into `_`: `api-key` is `<NAME>_SECRET_API_KEY`. |

Setting both `<NAME>_DATABASE_URL` and `<NAME>_BUCKET` selects remote mode, and `<NAME>_HOME` is then not read. Setting only one of them throws `BungalowInputError` naming the other. In remote mode the four required `S3_` variables must all be set; the first missing one, in the table's order, is named in a `BungalowInputError`. Every input is checked before any request is made, and no message names a variable's value. `S3_BUCKET` is never read: the bucket is `<NAME>_BUCKET`. The `NODE_ENV=test` refusal applies only to local mode.

The prefix is normalized: a leading `/` is removed and a trailing `/` is added, so `prod` and `/prod/` are both `prod/`, and an unset prefix is the bucket's root. A prefix with an empty, `.`, or `..` segment, such as `a//b`, `a/./b`, or `a/../b`, or with a backslash, throws `BungalowInputError`, and so does a bucket containing `/` or `\` or named `.` or `..`: a request URL rewrites each of them, so the object read or written would not be the one Bungalow names, and two prefixes could share one home. Before its first request Bungalow also checks that the signed URL addresses each key exactly. Inside the bucket, with `<prefix>` normalized:

| Key | Holds |
| --- | --- |
| `<prefix>configuration.json` | The configuration. Bungalow never writes it: put it in the bucket by hand. Absent is valid, and `readConfiguration()` then returns `undefined`. |
| `<prefix>deployment-id` | The deployment ID, as `<ULID>\n`, the same as the local file. |
| `<prefix><name>/` | The content named `<name>`, handed out by `content(name)`. |

```typescript
import { openBungalow } from '@lostgradient/bungalow';

const bungalow = await openBungalow({
  name: 'interborough',
  environment: {
    INTERBOROUGH_DATABASE_URL: 'postgres://interborough@db.internal/interborough',
    INTERBOROUGH_BUCKET: 'interborough-state',
    INTERBOROUGH_BUCKET_PREFIX: 'production',
    S3_ENDPOINT: 'https://storage.example.com',
    S3_REGION: 'auto',
    S3_ACCESS_KEY_ID: 'example-access-key-id',
    S3_SECRET_ACCESS_KEY: 'example-secret-access-key',
    INTERBOROUGH_SECRET_API_KEY: 'sk-example',
  },
});

bungalow.mode; // 'remote'
bungalow.database; // { kind: 'postgres', url: 'postgres://interborough@db.internal/interborough' }
bungalow.content('agents'); // { kind: 's3', bucket: 'interborough-state', prefix: 'production/agents/' }
bungalow.configurationLocation; // 's3://interborough-state/production/configuration.json'
await bungalow.readConfiguration(); // the object's text, or undefined when it is absent
bungalow.secretLocation('api-key'); // 'INTERBOROUGH_SECRET_API_KEY'
bungalow.readSecret('api-key'); // 'sk-example', or undefined when the variable is unset or empty
bungalow.s3Client(); // the Bun.S3Client configured above; undefined in local mode
bungalow.logs; // undefined: remote mode has no local directory

bungalow.close();
```

`writeSecret` throws `BungalowStateError` in remote mode, since secrets come from the environment, and so does `writeConfiguration`, since the configuration is an object a person puts in the bucket. `s3Client()` returns a `Bun.S3Client` built from the variables above, passed explicitly, so Bun's default endpoint and region are never used; it uses path-style addressing. The credentials appear in no location Bungalow hands out. Credentials come only from the environment Bungalow is given, never from the process's own, with one exception that Bungalow refuses instead of allowing: when no session token is set, `Bun.S3Client` signs every request with the `AWS_SESSION_TOKEN` or `S3_SESSION_TOKEN` the process had when Bun started, and no option turns that off. Before any request, Bungalow presigns a probe key, and if the URL carries `X-Amz-Security-Token` while the given environment has no `S3_SESSION_TOKEN` (an empty one counts as unset), `openBungalow` throws `BungalowInputError`, whose message names `AWS_SESSION_TOKEN` and `S3_SESSION_TOKEN` and never a value. Set `S3_SESSION_TOKEN` in the given environment, which is then the token every request carries, or unset the two in the process (an aws-vault or SSO shell, a Lambda, or a `.env` file sets them).

Remote mode takes no lock and loads no C library. Two overlapping instances, as in a rolling deploy, agree on one deployment ID: an instance that finds no `<prefix>deployment-id` writes a new ULID with `If-None-Match: *` (through a URL signed by `client.presign` and sent with `fetch`, since `Bun.S3Client.write` drops a conditional header), then reads the object back and uses whatever it holds, whether its own write succeeded or got `412`. A stored value that is not a ULID throws `BungalowStateError` and is left as it is. An object still absent after the write is a failed read, not a reason to write again.

Every S3 failure throws `BungalowFilesystemError` whose message names only the operation (`Could not read configuration.`, `Could not read deployment ID.`, `Could not write deployment ID.`). Its `cause` is `{ status }` for an HTTP response, or `{ code }` (the underlying error's `code`, or `'unknown'`) for a failure with no response, such as a refused connection. Neither holds the key, bucket, prefix, URL, credentials, or the underlying message. `close()` ends the handle and is idempotent; a closed handle throws `BungalowStateError` on further use, as locally.

## Entries Bungalow does not trust

A root sits in a directory that users and other tools also write to, so an entry inside it can be a symbolic link to somewhere else, a second hard link to a file elsewhere, or a FIFO that would block an `open` forever. `src/entry-guard.ts` is the one place that checks. Every entry Bungalow opens, reads, changes the mode of, truncates, or writes inside the root (the root when it already exists, `secrets/`, `logs/`, content directories, `lock`, `deployment-id`, each secret, and the temporary files) is opened with `O_NOFOLLOW` and `O_NONBLOCK`, and the descriptor is then checked with `fstat`: a directory must be a real directory, and a file must be a regular file with exactly one link. Only then does Bungalow `fchmod`, truncate, or read it, through that descriptor. Anything else throws `BungalowStateError` naming the kind of entry (`lock file`, `secrets directory`) and never a secret's key. Writing a secret renames a new file over the entry, so a write never goes through a link either, and the temporary-file sweep skips symbolic links. Every directory Bungalow creates is made durable by syncing the directory that contains it.

A root that is itself a symbolic link is refused, so point `<NAME>_HOME` at the real directory.

## The single-instance lock

Holding a handle holds an exclusive, non-blocking `flock(2)` on `<root>/lock`, taken through `bun:ffi` (`libSystem.B.dylib` on macOS, `libc.so.6` on Linux). The kernel is the arbiter: a second open of a held root, in this process or another, throws `BungalowLockedError`, and when a holder dies without closing, the kernel drops its lock at once. There is no stale lock to detect or reclaim, no process identifier to check for liveness, and no race between two openers.

After taking the lock the holder truncates the file and writes its process identifier as the first line. A contender that is refused reads only that first line to name the holder in `BungalowLockedError.holderProcessIdentifier`, so a later version can add lines. The identifier is advisory: `BungalowLockedError.holderProcessIdentifier` is `undefined` or can still name the previous holder during the short window between a holder taking the lock and writing its own identifier, and a crashed holder's identifier stays in the file until the next holder overwrites it. `close()` clears the file, releases the lock by closing the descriptor, and never removes the file. It is idempotent once it has succeeded, and it can be retried after a failure. A closed handle throws `BungalowStateError` on any further use.

The lock file is opened through that guard, and with close-on-exec.

The root must be on a local filesystem that supports `flock`. Network filesystems that do not honour it are unsupported, and a host that refuses the lock for any reason other than contention throws `BungalowFilesystemError`. On any platform other than macOS and Linux, opening throws `BungalowUnsupportedError`, and so does a Linux whose C library is not glibc, such as Alpine's musl, because the lock is bound to `libc.so.6`.

## Tests

`process.env.NODE_ENV === 'test'` is the guard against a test touching a developer's real home directory. Under it, a local `openBungalow` rejects unless `<NAME>_HOME` is set; a remote one is not refused, because it never touches the home directory. A test calls `openTemporaryBungalow({ name })`, which creates an isolated root under the operating system's temporary directory and removes it on `close()`, or points `<NAME>_HOME` at a directory it owns. A test of remote mode runs against `createS3TestServer` from `@lostgradient/testing/s3-server`.

The one place the package reads `process.env` is `src/environment-configuration.ts`. Every function that depends on the environment also accepts it as a value.
