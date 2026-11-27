# Process Lease

`@lostgradient/process-lease` holds the process ownership primitives that both repository tooling and the Interborough supervisor use, on macOS and Linux under Bun. It has no scheduling policy: the host lock's queue, the test slots, memory admission and the Turborepo environment stay in the repository's root `scripts/`, which import this library.

- Identity. `processStartTime` reads a process's start time as `ps` reports it, in the host's own time zone and the C locale, so a recycled pid is never mistaken for the process that held a lease. `processTableEnvironment` is the environment `ps` runs under, and `isProcessAlive`, `isSameProcess` and `isProcessGroupAlive` judge a recorded pid or group against it.
- Owner records. A lock is a directory holding `owner.json`, installed whole by one rename. `readOwner`, `removeLock` and `recordProcessGroup` read, remove and extend it; `removeLock` moves aside only the lock whose token it names.
- Reclaim. `takeReclaimGuard` serializes the reclaimers of one lock, `judgeByProcess` decides whether an owner is still alive, and `reclaimAbandonedAs` removes an abandoned lock under the guard.
- Owned leases. `acquireOwnedProcessLease` takes a lease bound to one canonical worktree, publishing its owner record atomically. `retireOwnedProcessLease` reclaims only a dead owner that carries this worktree's identity, and ends only a process group it can verify by its start time and its gate token. A reused pid, a lease of another worktree, an ownerless directory, or a group whose leader is not the recorded gate fails closed and leaves the process alone.
- Owned groups. `runOwnedProcessGroup` starts a command as the leader of a new process group behind a gate (`owned-process-gate.ts`) that runs it only after the owner has durably registered the group, and retires the group when the command ends.

```ts
import { acquireOwnedProcessLease, runOwnedProcessGroup } from '@lostgradient/process-lease';

const lease = await acquireOwnedProcessLease(lockPath, worktree, 'my supervisor');
try {
  await runOwnedProcessGroup({
    command: ['bun', 'host.ts'],
    cwd: worktree,
    environment: { PATH: '/usr/bin' },
    token: lease.token,
    register: (pid) => lease.recordProcessGroup(pid),
  });
} finally {
  await lease.release();
}
```

A packaged executable started outside a checkout acquires no lease and needs none of this on disk: the supervisor takes the lease only when it runs inside a git worktree.
