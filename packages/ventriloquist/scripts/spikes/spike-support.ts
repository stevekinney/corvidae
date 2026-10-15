/* oxlint-disable -- COR-1522 throwaway spike: measures behavior, is not production code, and is deleted or promoted by the implementation. */
/**
 * Shared helpers for the COR-1522 pause spikes. Throwaway-quality, not production code.
 *
 * Safety: every spike calls `guard()` first. It starts a separate `sh` sidecar that polls this
 * process's resident size and a wall-clock deadline, and kills this process and its direct
 * children with SIGKILL when either is exceeded. The sidecar is independent of this process's
 * event loop, so it still fires when a flooded main thread starves every timer.
 */
import { spawnSync } from 'node:child_process';

export const MEGABYTE = 1024 * 1024;

const SIDECAR = `
host=$1; cap_kb=$2; deadline=$3; start=$(date +%s)
while kill -0 "$host" 2>/dev/null; do
  rss=$(ps -o rss= -p "$host" 2>/dev/null | tr -d ' ')
  now=$(date +%s)
  if [ -n "$rss" ] && [ "$rss" -gt "$cap_kb" ]; then why="rss $rss kB over cap $cap_kb kB"; fi
  if [ $((now - start)) -gt "$deadline" ]; then why="deadline $deadline s"; fi
  if [ -n "$why" ]; then
    echo "WATCHDOG: killing $host ($why)" >&2
    for c in $(ps -A -o pid=,ppid= | awk -v p="$host" '$2 == p { print $1 }'); do kill -9 "$c" 2>/dev/null; done
    kill -9 "$host" 2>/dev/null
    exit 0
  fi
  sleep 0.1
done
`;

/** Arm the independent watchdog for this process. */
export function guard(options: { maximumRssMegabytes: number; maximumSeconds: number }): void {
  const sidecar = Bun.spawn(
    [
      '/bin/sh',
      '-c',
      SIDECAR,
      'watchdog',
      String(process.pid),
      String(options.maximumRssMegabytes * 1024),
      String(options.maximumSeconds),
    ],
    { stdio: ['ignore', 'inherit', 'inherit'], detached: true },
  );
  sidecar.unref();
}

/** Resident set size of `pid` in kilobytes, or `undefined` if it is gone. */
export function residentKilobytes(pid: number): number | undefined {
  const out = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], {
    encoding: 'utf8',
  }).stdout.trim();
  return out === '' ? undefined : Number(out);
}

/** `ps` state letters and wait channel for `pid`: e.g. `S` / `Ss`, plus the kernel wait channel on Linux. */
export function stateOf(pid: number): string {
  const wchan = process.platform === 'linux' ? 'wchan:24=' : 'wchan=';
  const out = spawnSync('ps', ['-o', `stat=,${wchan}`, '-p', String(pid)], {
    encoding: 'utf8',
  }).stdout;
  return out.trim().replace(/\s+/g, ' ') || 'gone';
}

/** CPU seconds consumed so far by `pid` (cputime), as `ps` prints it. */
export function cpuTimeOf(pid: number): string {
  return (
    spawnSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim() ||
    'gone'
  );
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Kill a pid we started; ignore a pid that is already gone. */
export function kill(pid: number, signal: NodeJS.Signals = 'SIGKILL'): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Gone already.
  }
}

/** Kill a process group we started (its leader pid); ignore a group that is already gone. */
export function killGroup(pid: number, signal: NodeJS.Signals = 'SIGKILL'): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Gone already.
  }
}

/** Small incremental FNV-1a-ish checksum plus count, cheap enough for hundreds of MB. */
export class Tally {
  bytes = 0;
  newlines = 0;
  #hasher = new Bun.CryptoHasher('sha256');
  update(chunk: Uint8Array): void {
    this.bytes += chunk.length;
    this.#hasher.update(chunk);
  }
  digest(): string {
    return this.#hasher.digest('hex');
  }
}

/** Print a JSON result line the aggregator can grep. */
export function report(label: string, data: Record<string, unknown>): void {
  console.log(
    `RESULT ${label} ${JSON.stringify({ platform: process.platform, arch: process.arch, ...data })}`,
  );
}

/** Expected sha256 of the first `count` lines of `seq 1 N` style data, via the platform tools. */
export function sha256OfCommand(command: string): string {
  const out = spawnSync('sh', ['-c', `${command} | (sha256sum 2>/dev/null || shasum -a 256)`], {
    encoding: 'utf8',
    maxBuffer: 1 << 20,
  }).stdout;
  return out.trim().split(/\s+/)[0] ?? '';
}
