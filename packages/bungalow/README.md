# Bungalow

Bungalow binds each local home or remote bucket prefix to one durable `workspaceId`. The marker is claimed atomically after the stable `deployment-id` is loaded and before the caller can compose recovery, plugins, or writes. An existing nonempty local home without its persisted deployment identity refuses to open; a marker mismatch is never repaired automatically. The workspace identity is trusted host configuration, not an HTTP request value.

`@lostgradient/bungalow` resolves and prepares an application's home: where its database and content live, its configuration, its secrets, its logs, and its deployment identity. Locally the home is a directory, `~/.interborough` or wherever `INTERBOROUGH_HOME` points for Interborough. Remotely it is a Postgres database, an S3-compatible bucket, and environment variables (see [Remote mode](#remote-mode)). Bungalow runs on Bun and on Node 22 or later, on macOS and Linux (see [Running on Node](#running-on-node)).

Bungalow hands out locations for the database and content, and reads the configuration, the secrets, and the deployment ID itself. It never connects to a database, parses configuration, or reads the contents of a content location. Storage engines belong in Weft. It has no runtime dependencies: remote mode signs its requests with its own SigV4 presigner over `node:crypto` and sends them with `fetch`.

## Running on Node

The package detects no runtime. Every part either works the same on Bun and Node or is chosen by the caller, so Bun keeps its defaults and a Node host injects the one piece Bun alone has.

| Injection point | Default | On Node |
| --- | --- | --- |
| `acquireLock` (`openBungalow`, `openLocalBungalow`, `openTemporaryBungalow`) | The `flock(2)` lock through `bun:ffi`, which only Bun has. On Node it rejects with `BungalowUnsupportedError` naming the fix. | Pass `acquirePortableLock`. See [The portable lock](#the-portable-lock). |
| `presigner` (`openBungalow`, `openRemoteBungalow`) | `defaultPresigner`: `createSigV4Presigner` over the descriptor's credentials. | The default works unchanged. |
| `deploymentSecrets` and `secretProvider` | Files under the root locally, environment values remotely. | The defaults work unchanged. |
| The `describe…` functions of `/conformance` | No default: each takes a `{ describe, test }` runner first. | Pass `{ describe, test }` from `node:test`. |

```typescript
import { acquirePortableLock, openBungalow } from '@lostgradient/bungalow';

const home = await openBungalow({ name: 'readyset', acquireLock: acquirePortableLock });
```

`acquireLock` is never called in remote mode and `presigner` never in local mode, so a host can pass both and let the environment choose. `acquireLocalRootLockDescriptor`, which locks a descriptor the caller already opened, uses `flock(2)` and stays Bun-only.

`src/node-runtime.test-support.ts` is the Node subset of the test suite: a local open on the portable lock, the lock refusing a second holder in the same process and in another process, the default lock's refusal, local secrets and configuration, remote conditional writes and listing, and the lock, home, and deployment-secret conformance suites under `node:test`. `src/node-runtime.integration.test.ts` runs it in a native Node child against an S3 test server. Set `BUNGALOW_NODE_BINARY` to choose the Node it runs on, as in `BUNGALOW_NODE_BINARY=$(mise which node --tool node@22) bun run test:slow`. Node runs the TypeScript source by stripping its types, which needs Node 22.18 or later. Node refuses to strip types under `node_modules`, so an npm release must ship JavaScript.

### The portable lock

`acquirePortableLock(root)` resolves to a `RootLock`. It runs on Node and Bun. Like the default lock, it is arbitrated by the kernel, so there is no stale lock to reclaim and no process identifier to check for liveness: a holder that dies, even by `SIGKILL`, loses the lock at once. The holder writes its process identifier as the first line of `<root>/lock`, as the default does, so a refused opener's `BungalowLockedError` names it. The mechanism differs by platform, and so do its limits:

- **macOS:** opens `<root>/lock` with `O_EXLOCK | O_NONBLOCK`, which takes the same `flock(2)` lock as the default. A Bun process on the default lock and a Node process on the portable one exclude each other.
- **Linux:** Node cannot call `flock(2)`, so the lock is a listening abstract Unix socket named after the device and inode of the root directory. This is weaker than the default in two ways. It excludes only openers in the same network namespace, so two containers that share a volume but not a network namespace can both hold one root. It also does not see `flock(2)`, so a Bun process on the default lock and a Node process on the portable one can both hold one root. A home that processes on both runtimes open must inject `acquirePortableLock` on every runtime. `node-runtime.integration.test.ts` asserts this gap, so a change in either direction fails.

Any other platform rejects with `BungalowUnsupportedError`. `acquireLock` may return a `RootLock` or a promise of one, and the open awaits it.

## Workspace usage

Declare `"@lostgradient/bungalow": "workspace:*"` in the consuming workspace's dependencies and install from the Corvidae root with `bun install`. The workspace exports TypeScript source directly. The npm release workflow packages the root API and the `/conformance` test entry point.

## Choosing the root

`resolveBungalowRoot({ name, environment, homeDirectory })` is a pure function. It returns `<NAME>_HOME` when that variable is set and non-empty, where `<NAME>` is the application name uppercased with `-` turned into `_`. Otherwise it returns `<homeDirectory>/.<name>`. Both values must be absolute paths, because a state directory that follows the working directory loses data.

An override is normalized, so a trailing slash or a dot segment does not change the root. An application name matches `^[a-z][a-z0-9-]*$`. A secret key or content directory name matches `^[a-z0-9][a-z0-9-]*$`. Anything else throws `BungalowInputError`.

## Resolving and opening separately

`openBungalow` does two things: it decides from the environment where the home is, and it opens it. Each half is also available on its own, so a host can keep several homes open in one process, or keep its settings somewhere other than the environment, without the environment rules deciding for it.

`resolveBungalowDescriptor({ name, environment, homeDirectory })` is the first half. It is pure: it performs no I/O, takes no lock, and reads no process state, so the environment and the home directory are both required. It applies exactly the rules of [Remote mode](#remote-mode) and [Choosing the root](#choosing-the-root), and returns a `BungalowDescriptor`: `{ kind: 'local', root }`, or `{ kind: 'remote', databaseUrl, bucket, prefix, endpoint, region, accessKeyId, secretAccessKey, sessionToken?, secrets }` with the prefix normalized and the `<NAME>_SECRET_*` variables copied. It applies no `NODE_ENV=test` policy; that refusal belongs to `openBungalow`.

`openLocalBungalow({ name, root })` and `openRemoteBungalow({ name, descriptor, databaseWorkspaceClaim })` are the second half. Neither reads an environment. A local root must be absolute. A remote descriptor goes through the same validation whether `resolveBungalowDescriptor` returned it or the caller built it by hand: required fields, a path-safe bucket, and the prefix's normalization and segment rules, so a hand-built descriptor cannot alias two prefixes or skip a check. Its failures name the field (`descriptor.prefix`), never the value. `openBungalow` is these pieces composed: the descriptor, then the `NODE_ENV=test` refusal for a local home, then the matching open.

```typescript
import { homedir } from 'node:os';

import {
  openLocalBungalow,
  openRemoteBungalow,
  resolveBungalowDescriptor,
  type DatabaseWorkspaceClaim,
} from '@lostgradient/bungalow';

async function openHome(databaseWorkspaceClaim: DatabaseWorkspaceClaim) {
  const descriptor = resolveBungalowDescriptor({
    name: 'interborough',
    environment: process.env,
    homeDirectory: homedir(),
  });
  if (descriptor.kind === 'remote') {
    return openRemoteBungalow({ name: 'interborough', descriptor, databaseWorkspaceClaim });
  }
  return openLocalBungalow({ name: 'interborough', root: descriptor.root });
}
```

Both opens also take the options `openBungalow` takes for the same mode (`workspaceId` and `secretProvider`, and `writableConfiguration` remotely), and two more that `openBungalow` does not:

- `deploymentSecrets`, a `DeploymentSecretsFactory`. It receives `{ workspaceId, assertOpen }` once the workspace identity is bound, before the caller gets the handle, and returns the `DeploymentSecrets` the handle hands out; `assertOpen` throws `BungalowStateError` once the handle is closed. Omitted, the defaults are unchanged: files under `secrets/` locally, read-only `<NAME>_SECRET_<KEY>` values remotely. It replaces only `deploymentSecrets`: the managed `secretProvider` is chosen separately, and neither ever routes through the other. A local home still creates `secrets/`. The store it returns must carry a boolean `writable`, which says whether `write` can succeed; an injected store without one makes the open reject with `BungalowInputError`. Bungalow does not wrap an injected store to enforce `writable: false`.
- `acquireLock`, local only: `(root) => RootLock | Promise<RootLock>`, called after the root directory exists and before anything in it is read. The open releases the lock if it then fails, and `close()` releases it. Omitted, it is the `flock(2)` lock described in [The single-instance lock](#the-single-instance-lock); on Node, pass `acquirePortableLock`. `openBungalow` and `openTemporaryBungalow` take it too.
- `presigner`, remote only: a `PresignerFactory`, `(descriptor) => ObjectPresigner`, called once per open before any request. Omitted, it is `defaultPresigner`; see [Signing requests](#signing-requests). `openBungalow` takes it too.

`openLocalBungalow` also takes `access: 'read' | 'write'`, which defaults to `'write'`; see [Capabilities and read-only access](#capabilities-and-read-only-access).

Two local homes with different roots can be open in one process at once, each with its own lock, identity, and secrets, and closing one leaves the other open.

```typescript
import {
  BungalowLockedError,
  openLocalBungalow,
  openRemoteBungalow,
  type DatabaseWorkspaceClaim,
  type DeploymentSecretsFactory,
  type RootLock,
} from '@lostgradient/bungalow';

/** A host's own store for deployment secrets, such as an operating-system keychain. */
const keychain: DeploymentSecretsFactory = ({ workspaceId, assertOpen }) => {
  const values = new Map<string, string>();
  return {
    writable: true,
    async read(key) {
      assertOpen();
      return values.get(key);
    },
    async write(key, value) {
      assertOpen();
      values.set(key, value);
    },
    location: (key) => `keychain:${workspaceId}/${key}`,
  };
};

/** A host's own single-instance mechanism, here one held root per process. */
const held = new Set<string>();
function acquireLock(root: string): RootLock {
  if (held.has(root)) throw new BungalowLockedError(root, process.pid);
  held.add(root);
  return { release: () => held.delete(root) };
}

async function openTenants(databaseWorkspaceClaim: DatabaseWorkspaceClaim) {
  const first = await openLocalBungalow({
    name: 'interborough',
    root: '/srv/interborough/first',
    deploymentSecrets: keychain,
    acquireLock,
  });
  const second = await openLocalBungalow({
    name: 'interborough',
    root: '/srv/interborough/second',
  });
  const remote = await openRemoteBungalow({
    name: 'interborough',
    databaseWorkspaceClaim,
    descriptor: {
      kind: 'remote',
      databaseUrl: 'postgres://interborough@db.internal/tenant',
      bucket: 'interborough-state',
      prefix: 'tenant',
      endpoint: 'https://storage.example.com',
      region: 'auto',
      accessKeyId: 'example-access-key-id',
      secretAccessKey: 'example-secret-access-key',
      secrets: new Map([['INTERBOROUGH_SECRET_API_KEY', 'sk-example']]),
    },
  });

  first.close(); // second and remote stay open
  second.close();
  remote.close();
}
```

## Capabilities and read-only access

A caller asks a handle what its home can do, and never infers it from `mode`. `capabilities` is `{ sharedBetweenInstances, personalMachine }`: a local home reports `false` and `true`, a remote home `true` and `false`. `deploymentSecrets.writable` says whether `write` can succeed: `true` for the local file store, `false` for the environment store. `mode` stays as a label.

`openLocalBungalow({ access: 'read' })` returns a handle that takes no lock and creates, changes, and deletes nothing, so a second process, such as a command-line tool, can read a home the host holds. It reads only files a writer replaces by rename, never the lock file, and refuses a symbolic link, a FIFO, or a multiply linked file at every entry it reads, as a writer does. The root must already exist and hold a `deployment-id`, or the open rejects with `BungalowStateError`; a home with no `workspace-id` opens with its deployment identity as its workspace identity, and a configured `workspaceId` that differs from the stored one is still refused.

On a read-only handle:

- No directory is created and no mode tightened. A loose secret file is read as it is. A missing `secrets/` or `.managed-secrets/` reads as empty: `deploymentSecrets.read` and `secretProvider.readLegacy` resolve `undefined`, `listOperations` resolves `[]`, and `readVersion` rejects with code `missing`. `secretProvider.getOperation` returns an operation record it recovers from its version without saving it.
- `configurationWriteCapability` is `'read-only'` and `writeConfiguration` resolves `{ outcome: 'read-only' }`. `deploymentSecrets.writable` is `false` and `write` rejects with `BungalowStateError`. `secretProvider.capabilities` has `prepare: false` and `transitions: false`, and `prepare`, `transitionOperation`, and `reclaim` reject with a `SecretProviderError` of code `read-only`.
- `content(name)` returns the location of an existing directory and throws `BungalowStateError` for a missing one, and `logs` is the path whether or not the directory exists.
- The open refuses `acquireLock`, `deploymentSecrets`, and `secretProvider` with `BungalowInputError`: a read-only open uses the built-in stores. A read-only open of a remote home does not exist, and `access` is an option of `openLocalBungalow` only: a caller that starts from the environment calls `resolveBungalowDescriptor` first.

```typescript
import { openLocalBungalow, type Bungalow } from '@lostgradient/bungalow';

/** Read the configuration of a home another process holds, without stopping that process. */
async function readConfigurationOf(root: string): Promise<string | undefined> {
  using home: Bungalow = await openLocalBungalow({ name: 'interborough', root, access: 'read' });
  home.capabilities.personalMachine; // true
  home.deploymentSecrets.writable; // false
  home.configurationWriteCapability; // 'read-only'
  return (await home.readConfiguration()).text;
}
```

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
const snapshot = await bungalow.readConfiguration(); // text and revision from the same read
await bungalow.writeConfiguration('{}\n', { expectedRevision: snapshot.revision });
bungalow.deploymentSecrets.location('api-key'); // '<root>/secrets/api-key'

await bungalow.deploymentSecrets.write('api-key', 'sk-example'); // <root>/secrets/api-key, mode 0600
await bungalow.deploymentSecrets.read('api-key'); // the value, or undefined when never written

bungalow.close();
```

`openBungalow` and `openTemporaryBungalow` return a promise, so a mode that reads from a network can open without blocking. A Bungalow hands out locations, not bare paths, so a caller never assumes the home is a directory: `mode` is `'local'` or `'remote'`; `database` is `{ kind: 'sqlite', path }` or `{ kind: 'postgres', url }`; `content(name)` is `{ kind: 'directory', path }` or `{ kind: 's3', bucket, prefix }`; `configurationLocation` and `deploymentSecrets.location(key)` are strings for messages and for a person editing by hand (the file's path in local mode), and `readConfiguration()` returns `{ text, revision }` from one read. Local mode returns the `sqlite` and `directory` variants, remote mode the `postgres` and `s3` ones. `content(name)` rejects the names Bungalow keeps in the root (`secrets`, `logs`, `lock`, `deployment-id`).

Opening for writing, which is the default, creates the root (mode `0700`), `secrets/` (mode `0700`), logs, the lock file, and the deployment identity. It does not create the database or configuration file, and a missing configuration file is valid. `writeConfiguration(text, { expectedRevision })` creates it only when the revision is explicitly `null`, or replaces it only when the observed revision still matches. The awaited result distinguishes `committed`, `conflict`, `read-only`, `unsupported`, `unavailable`, and `unknown`. Local deployment-secret reads tighten a loose secret file back to `0600` before reading it.

A secret is written to a temporary file that is `0600` from its first byte, synced, renamed into place, and the directory entry is synced, so a crash leaves the old value or the new one.

`deploymentId` is a ULID generated on the first open and persisted at `deployment-id`, so every later open of the same root returns it. The generator is a small hand-written one (`src/ulid.ts`), a 48-bit millisecond timestamp followed by 80 random bits from `crypto.getRandomValues`, in Crockford base32, so the package adds no dependency. A `deployment-id` file that does not hold a ULID throws `BungalowStateError` rather than being replaced, because replacing it would change the deployment's identity.

## Remote mode

Remote mode keeps the home in Postgres, an S3-compatible bucket, and environment variables, so that two instances can share it. Every variable is read from the `environment` passed to `openBungalow` (the process environment by default), and an empty value counts as unset. `<NAME>` is the application name uppercased with `-` turned into `_`, as for `<NAME>_HOME`: `INTERBOROUGH` for Interborough.

| Capability | Local | Remote |
| --- | --- | --- |
| Database and content locations | SQLite and directories | PostgreSQL and S3-compatible storage |
| Coordination | Exclusive local home lock | Shared-storage coordination supplied by the application |
| Configuration publication | Revision-checked local writes | Read-only unless trusted composition enables revision-checked writes |
| Managed secret provider | Writable local files | Read-only environment values unless a writable provider is injected |
| Home and logs | Persistent local home and log directory | No local home or log directory; use an external log sink or process output |

Remote application processes may use temporary scratch files and packaged assets, but recovery must not depend on scratch surviving a replacement. Bootstrap credentials and encryption keys are deployment inputs. Bungalow supplies the provider interface and local and environment providers; it does not include a production cloud-secret vendor adapter.

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
| `<prefix>configuration.json` | The configuration, read-only by default. An explicit `writableConfiguration: true` enables conditional writes. Absence returns `{ text: undefined, revision: null }`. |
| `<prefix>deployment-id` | The deployment ID, as `<ULID>\n`, the same as the local file. |
| `<prefix><name>/` | The content named `<name>`, handed out by `content(name)`. |

```typescript
import { openBungalow, type DatabaseWorkspaceClaim } from '@lostgradient/bungalow';

async function openRemoteHome(databaseWorkspaceClaim: DatabaseWorkspaceClaim) {
  const bungalow = await openBungalow({
    name: 'interborough',
    databaseWorkspaceClaim,
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
  await bungalow.readConfiguration(); // the object's text and ETag from one GET
  bungalow.deploymentSecrets.location('api-key'); // 'INTERBOROUGH_SECRET_API_KEY'
  await bungalow.deploymentSecrets.read('api-key'); // 'sk-example', or undefined when the variable is unset or empty
  bungalow.objectStore()?.presign('production/agents/a.md'); // a signed GET URL; objectStore() is undefined locally
  bungalow.logs; // undefined: remote mode has no local directory

  bungalow.close();
}
```

`deploymentSecrets.write` throws `BungalowStateError` in remote mode, since secrets come from the environment. `writeConfiguration` instead returns `read-only` unless the trusted composition explicitly enabled `writableConfiguration`. The remaining remote configuration and S3 behavior is unchanged.

Local homes trust processes running as the same operating-system user; separate directories do not establish separate security principals. The Interborough disposable service fixture exercises a separate profile with service-issued credentials, a fixture-only namespace policy, and ownership-checked resets. That simulated profile does not establish authorization for a production deployment or grant access to production resources.

Remote mode requires the trusted application to supply `databaseWorkspaceClaim`. Before bootstrapping an empty prefix, Bungalow calls it with an undefined identity; the application must reject an existing nonempty database. Once the deployment identity is persisted, Bungalow calls it with that identity and the `s3://` resource location. The application must atomically claim one fixed key in the raw database, accept only an identical existing binding, and reject conflicts regardless of connection URL spelling. Only then does Bungalow publish `workspace-id`. Interborough implements this through its PostgreSQL storage adapter and reuses that adapter for the host. An empty prefix may retain only its newly generated `deployment-id` if the database claim fails; reopening retries that same identity. Existing content without a deployment identity requires restoring the original identity from backup.

Remote mode takes no lock and loads no C library. Two overlapping instances, as in a rolling deploy, agree on one deployment ID: an instance that finds no `<prefix>deployment-id` writes a new ULID with `If-None-Match: *` (through a presigned URL sent with `fetch`, since `Bun.S3Client.write` drops a conditional header, COR-1759), then reads the object back and uses whatever it holds, whether its own write succeeded or got `412`. A stored value that is not a ULID throws `BungalowStateError` and is left as it is. An object still absent after the write is a failed read, not a reason to write again.

Every S3 failure throws `BungalowFilesystemError` whose message names only the operation (`Could not read configuration.`, `Could not read deployment ID.`, `Could not write deployment ID.`). Its `cause` is `{ status }` for an HTTP response, or `{ code }` (the underlying error's `code`, or `'unknown'`) for a failure with no response, such as a refused connection. Neither holds the key, bucket, prefix, URL, credentials, or the underlying message. `close()` ends the handle and is idempotent; a closed handle throws `BungalowStateError` on further use, as locally.

### Signing requests

Every remote request is a presigned URL sent with `fetch`, so a conditional header reaches the store whatever signs it. The signer is a `PresignerFactory`: Bungalow calls it once per open with the validated descriptor, and it returns an `ObjectPresigner`, `(key, { method, expiresIn, bucket, query }) => string`. The default, `defaultPresigner`, is `createSigV4Presigner`: AWS Signature Version 4 query signing over `node:crypto`, synchronous, path-style, for the descriptor's bucket. It signs with exactly the descriptor's credentials and reads no process environment, and `src/presign.test.ts` pins its URLs to the ones `Bun.S3Client.presign` produces.

An injected presigner must also sign a bucket-level request, an empty key with `options.query`, because that is how a listing is made. `Bun.S3Client.presign` cannot, so a presigner over it hands those to `createSigV4Presigner`. `Bun.S3Client` also signs with the `AWS_SESSION_TOKEN` or `S3_SESSION_TOKEN` the process started with whenever no session token is set. Before the first request, Bungalow checks that the presigner signs no session token the given environment does not set, and throws `BungalowInputError` naming both variables if it does. A factory that throws, or returns something other than a function, also throws `BungalowInputError`, and the factory's own message is dropped because it may quote the endpoint.

`objectStore()` hands out the same signer as a `BungalowObjectStore` with `presign(key, options)` and `list(input, { bucket })`. A listing is one `ListObjectsV2` page with `contents`, `isTruncated`, `nextContinuationToken`, and `keyCount`. These are the `presign` and `list` members of `Bun.S3Client`, so code written against that subset, such as Bureau's object sources, accepts it unchanged. A failed listing rejects with `ObjectStoreRequestError`, whose `code` is the store's error code, or `HTTP<status>` when the store sent none, and whose `status` is the HTTP status. It never carries the URL.

## Entries Bungalow does not trust

A root sits in a directory that users and other tools also write to, so an entry inside it can be a symbolic link to somewhere else, a second hard link to a file elsewhere, or a FIFO that would block an `open` forever. `src/entry-guard.ts` is the one place that checks. Every entry Bungalow opens, reads, changes the mode of, truncates, or writes inside the root (the root when it already exists, `secrets/`, `logs/`, content directories, `lock`, `deployment-id`, each secret, and the temporary files) is opened with `O_NOFOLLOW` and `O_NONBLOCK`, and the descriptor is then checked with `fstat`: a directory must be a real directory, and a file must be a regular file with exactly one link. Only then does Bungalow `fchmod`, truncate, or read it, through that descriptor. Anything else throws `BungalowStateError` naming the kind of entry (`lock file`, `secrets directory`) and never a secret's key. Writing a secret renames a new file over the entry, so a write never goes through a link either, and the temporary-file sweep skips symbolic links. Every directory Bungalow creates is made durable by syncing the directory that contains it.

A root that is itself a symbolic link is refused, so point `<NAME>_HOME` at the real directory.

## The single-instance lock

Holding a read-write handle holds an exclusive, non-blocking `flock(2)` on `<root>/lock`, taken through `bun:ffi` (`libSystem.B.dylib` on macOS, `libc.so.6` on Linux). No module of the package imports `bun:ffi` statically: the lock imports it the first time a local open takes the default lock, so importing the package, a remote open, or a local open with an injected `acquireLock` loads no FFI. The default needs Bun; Node injects [the portable lock](#the-portable-lock). The kernel is the arbiter: a second open of a held root, in this process or another, throws `BungalowLockedError`, and when a holder dies without closing, the kernel drops its lock at once. There is no stale lock to detect or reclaim, no process identifier to check for liveness, and no race between two openers.

After taking the lock the holder truncates the file and writes its process identifier as the first line. A contender that is refused reads only that first line to name the holder in `BungalowLockedError.holderProcessIdentifier`, so a later version can add lines. The identifier is advisory: `BungalowLockedError.holderProcessIdentifier` is `undefined` or can still name the previous holder during the short window between a holder taking the lock and writing its own identifier, and a crashed holder's identifier stays in the file until the next holder overwrites it. `close()` clears the file, releases the lock by closing the descriptor, and never removes the file. It is idempotent once it has succeeded, and it can be retried after a failure. A closed handle throws `BungalowStateError` on any further use.

The lock file is opened through that guard, and with close-on-exec.

The root must be on a local filesystem that supports `flock`. Network filesystems that do not honour it are unsupported, and a host that refuses the lock for any reason other than contention throws `BungalowFilesystemError`. On any platform other than macOS and Linux, opening throws `BungalowUnsupportedError`, and so does a Linux whose C library is not glibc, such as Alpine's musl, because the lock is bound to `libc.so.6`.

## Tests

`process.env.NODE_ENV === 'test'` is the guard against a test touching a developer's real home directory. Under it, a local `openBungalow` rejects unless `<NAME>_HOME` is set; a remote one is not refused, because it never touches the home directory. A test calls `openTemporaryBungalow({ name })`, which creates an isolated root under the operating system's temporary directory and removes it on `close()`, points `<NAME>_HOME` at a directory it owns, or calls `openLocalBungalow` with a root it owns, which reads no environment and so applies no `NODE_ENV=test` policy. A test of remote mode runs against `createS3TestServer` from `@lostgradient/testing/s3-server`.

The one place the package reads `process.env` is `src/environment-configuration.ts`. Every function that depends on the environment also accepts it as a value.

## Workspace secret providers

`Bungalow.secretProvider` is bound to `workspaceId` during trusted composition. `OpenBungalowOptions.secretProvider` can supply a provider factory after the backing identity is verified. The default local provider stores immutable versions in guarded 0600 files under `.managed-secrets/`, outside the existing flat `secrets/` key namespace; the default remote provider captures read-only environment values. Capability fields describe the actual backend, independently of the home's local or remote mode. `deploymentSecrets` remains the separate asynchronous source for bootstrap credentials and root encryption keys; `openLocalBungalow` and `openRemoteBungalow` accept a `deploymentSecrets` factory that replaces it without touching the provider (see [Resolving and opening separately](#resolving-and-opening-separately)).

A writable provider prepares a value with an operation ID, logical key, and expected configuration revision. Its private version payload atomically binds these inputs; the separate operation journal contains no value. Reusing an operation ID with different durable input conflicts, including recovery after a crash. References encode validated workspace/key/version identity; foreign workspace references are rejected before value access. `readVersion` resolves exactly that version and never falls back to a logical key or latest value.

The application owns configuration bindings and the publication state machine: claim `prepared` to `publishing`, attempt one conditional configuration write, then record `published`, `abandoned`, or `unknown`. A committed reference activates even if the provider acknowledgement fails. An uncertain attempt is reconciled, never resent; a superseded uncertain version remains retained. Reclamation accepts only abandoned versions, and the application must first prove that no active binding references the version. Published versions and unknown operations have no automatic expiry. The local adapter relies on Bungalow's held root lock; a hosted adapter must implement its conditional transitions atomically across clients and pass the conformance checks before use (see [Adding an environment](#adding-an-environment)).

## Adding an environment

An environment is a place a home can live: a different lock, a different store for deployment secrets, a different secret provider, or a whole new kind of home. Adding one is five steps.

1. **Write an open function that returns a `Bungalow`.** A variation on a local home wraps `openLocalBungalow` (or `openRemoteBungalow`) and passes its own parts. A new kind of home builds the handle itself, with every member of the `Bungalow` type, and its methods and its `deploymentSecrets` throw `BungalowStateError` once it is closed. A secret provider takes only a workspace identity from its factory, so Bungalow cannot close one for you, and the checks do not ask a provider to throw after `close`.
2. **Pass a lock and stores, or reuse the defaults.** `openLocalBungalow` takes `acquireLock` (a function from a root to a `RootLock`, which throws `BungalowLockedError` when the root is held), `deploymentSecrets` (a factory that receives the workspace identity and an `assertOpen` to call before every use), and `secretProvider` (a factory from a workspace identity to a `SecretProvider`). Leave one out and the default for that part applies: `flock(2)`, one file per key under `secrets/`, and the local managed provider.
3. **State capabilities.** Say what the home is and what it can do, and never leave a caller to infer it from `mode`: `capabilities.sharedBetweenInstances` and `capabilities.personalMachine` describe the home, `configurationWriteCapability` says whether configuration can be written, `deploymentSecrets.writable` whether a deployment secret can, and `secretProvider.capabilities` whether the provider can prepare versions.
4. **Add entries to Interborough's kind tables when the storage kind is new.** Interborough resolves the database and each content location through tables keyed by the `kind` string of the location: `DEFAULT_DATABASE_KINDS` and `DEFAULT_CONTENT_KINDS` in `applications/interborough/src/host/locations.ts`. `startHost` takes replacements as `databaseKinds` and `contentKinds`, and takes `openHome` to open the home through your function. An environment whose database and content are of a kind the tables already hold needs no entry.
5. **Run the conformance checks.** `@lostgradient/bungalow/conformance` exports one check for each part. Each `check…` function rejects with a message naming the first rule the subject broke and nothing else (never a compared value, key, path, or cause, because the subject may hold a secret), and each `describe…` function takes a runner, `{ describe, test }` from `bun:test` or `node:test`, and registers the same rules as its cases:

| Check | Takes | Rules it holds the subject to |
| --- | --- | --- |
| `checkRootLock` and `describeRootLock` | `acquireLock`, which the check calls on a temporary root of its own | A second acquisition of a held root throws `BungalowLockedError`; release allows the next acquisition; release is safe to call twice. |
| `checkDeploymentSecrets` and `describeDeploymentSecrets` | A function that returns a fresh store, and for a store that is not writable, the key and value it was seeded with | An unwritten key reads `undefined`; on a writable store a written key reads back; a store that is not writable rejects `write`; `read` and `write` reject an invalid key with `BungalowInputError`; `location` returns a string that does not contain the value. |
| `checkSecretProvider` and `describeSecretProvider` | A function that returns a fresh provider for a workspace identity, and for a provider that cannot prepare, optionally the key and value it was seeded with | Chosen from the provider's own `capabilities`. One that can prepare keeps preparation idempotent, enforces the publication state machine, refuses a foreign reference, reclaims only an abandoned version, and refuses a malformed digest without echoing it. One that cannot prepare reads an unwritten or seeded key through `readLegacy`, rejects `prepare`, `transitionOperation`, and `reclaim` with code `read-only`, and rejects `readVersion` of a reference that names no stored version. |
| `checkBungalow` and `describeBungalow` | `open`, which opens the same backing home on every call | Identity and capabilities are the same on reopen; a different configured `workspaceId` is refused; `content`, `objectStore`, `readConfiguration`, `writeConfiguration`, and the three members of `deploymentSecrets` throw `BungalowStateError` after `close`, and `close` is idempotent; `content` refuses reserved and malformed names; configuration writes and deployment-secret writes follow what the handle states with `configurationWriteCapability` and `deploymentSecrets.writable`. |

The checks run on every part Bungalow ships, so a subject is held to the same rules as the defaults. A secret-provider case that writes a provider's files directly or reopens its root is not a rule a provider factory can express, and stays in this package's own tests. The example below brings its own lock and its own deployment-secret store, reuses the local secret provider, and runs all four checks:

```typescript
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BungalowInputError,
  BungalowLockedError,
  createLocalSecretProvider,
  openLocalBungalow,
  type Bungalow,
  type DeploymentSecrets,
  type DeploymentSecretsContext,
  type RootLock,
} from '@lostgradient/bungalow';
import {
  checkBungalow,
  checkDeploymentSecrets,
  checkRootLock,
  checkSecretProvider,
} from '@lostgradient/bungalow/conformance';

/** A lock for a host that runs one process: a root is held from `acquire` until `release`. */
const heldRoots = new Set<string>();
function acquireLock(root: string): RootLock {
  if (heldRoots.has(root)) throw new BungalowLockedError(root, undefined);
  heldRoots.add(root);
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      heldRoots.delete(root);
    },
  };
}

/** Deployment secrets kept in memory, which refuse use once the handle is closed. */
function memorySecrets({ assertOpen }: DeploymentSecretsContext): DeploymentSecrets {
  const values = new Map<string, string>();
  const assertKey = (key: string): void => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) throw new BungalowInputError('A secret key is invalid.');
  };
  return {
    writable: true,
    async read(key) {
      assertOpen();
      assertKey(key);
      return values.get(key);
    },
    async write(key, value) {
      assertOpen();
      assertKey(key);
      values.set(key, value);
    },
    location(key) {
      assertOpen();
      assertKey(key);
      return `memory:${key}`;
    },
  };
}

/** The open function: a local home with this lock, these secrets, and the local managed provider. */
function openExample(root: string, options: { workspaceId?: string }): Promise<Bungalow> {
  return openLocalBungalow({
    name: 'example',
    root,
    ...options,
    acquireLock,
    deploymentSecrets: memorySecrets,
    secretProvider: (workspaceId) => createLocalSecretProvider({ root, workspaceId }),
  });
}

const root = mkdtempSync(join(tmpdir(), 'example-'));
await checkRootLock(acquireLock);
await checkDeploymentSecrets(() => memorySecrets({ workspaceId: 'example', assertOpen() {} }));
await checkSecretProvider((workspaceId) =>
  createLocalSecretProvider({ root: mkdtempSync(join(tmpdir(), 'example-secrets-')), workspaceId }),
);
await checkBungalow((options) => openExample(root, options));
```

Inside a test file, call `describeRootLock({ describe, test }, acquireLock)` and the other `describe…` functions in place of `check…` to get each rule as its own case, with `describe` and `test` from `bun:test` or `node:test`. The conformance module imports no test runner, and `@lostgradient/bungalow` itself never reaches it.

Bungalow keeps its one Bun-only API, the default lock's dynamic `bun:ffi` import, in `lock.ts`. `src/bun-only-apis.test.ts` fails when another module imports a `bun:` module or uses the `Bun` global as a value, when any module imports `bun:ffi` statically or names the `Bun` namespace even as a type, or when a listed module no longer needs to be listed. `src/node-runtime.integration.test.ts` runs the [Node subset](#running-on-node).
