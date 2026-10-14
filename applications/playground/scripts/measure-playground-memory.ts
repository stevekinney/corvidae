/**
 * Process and host memory readings for `measure-playground.ts` (CIN-585), macOS-first.
 *
 * `footprint <pid>` attributes a process's physical footprint to memory categories (malloc zones,
 * the JavaScript heap's regions, mapped files, and so on), which is the allocation evidence a
 * growing resident size needs. `vm_stat` and `kern.memorystatus_level` record how much memory
 * pressure the host was under when a sample ran. Every value returned is in bytes or a percentage.
 */

const UNIT_BYTES: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };

/** Parse a `footprint` size such as `576 KB` or `1.2 GB` into bytes. */
export function parseFootprintSize(value: string): number {
  const match = /^([\d.]+)\s*(B|KB|MB|GB)$/u.exec(value.trim());
  if (match === null) throw new RangeError(`Unrecognized footprint size: ${JSON.stringify(value)}`);
  return Math.round(Number(match[1]) * UNIT_BYTES[match[2]!]!);
}

export type FootprintCategory = {
  dirtyBytes: number;
  cleanBytes: number;
  reclaimableBytes: number;
  regions: number;
};

export type Footprint = { footprintBytes: number; categories: Record<string, FootprintCategory> };

/** Parse `footprint <pid>` output: the total and the per-category dirty/clean/reclaimable table. */
export function parseFootprint(output: string): Footprint {
  const total = /Footprint:\s*([\d.]+\s*(?:B|KB|MB|GB))/u.exec(output);
  if (total === null) throw new RangeError('footprint output has no Footprint total.');
  const categories: Record<string, FootprintCategory> = {};
  const size = String.raw`([\d.]+\s(?:B|KB|MB|GB))`;
  const row = new RegExp(String.raw`^\s*${size}\s+${size}\s+${size}\s+(\d+)\s+(.+?)\s*$`, 'u');
  for (const line of output.split('\n')) {
    const match = row.exec(line);
    if (match === null || match[5] === 'TOTAL') continue;
    categories[match[5]!] = {
      dirtyBytes: parseFootprintSize(match[1]!),
      cleanBytes: parseFootprintSize(match[2]!),
      reclaimableBytes: parseFootprintSize(match[3]!),
      regions: Number(match[4]),
    };
  }
  return { footprintBytes: parseFootprintSize(total[1]!), categories };
}

/** Read `footprint <pid>`; null when the tool is unavailable or the process is gone. */
/**
 * Read `footprint <pid>`. The tool exists only on macOS, so any other platform, a tool that cannot
 * be spawned, or a process that is gone yields null rather than an exception.
 */
export function captureFootprint(
  pid: number,
  options: MemoryPressureOptions = {},
): Footprint | null {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') return null;
  const result = tryRun(options.run ?? runCommand, ['footprint', String(pid)]);
  return result === null ? null : parseFootprint(result.stdout);
}

/** Dirty bytes per footprint category across checkpoints, for categories every checkpoint reports. */
export function footprintCategorySeries(
  footprints: readonly (Footprint | null)[],
): Record<string, number[]> {
  const present = footprints.filter((footprint): footprint is Footprint => footprint !== null);
  if (present.length !== footprints.length || present.length === 0) return {};
  const series: Record<string, number[]> = {
    'footprint total': present.map((footprint) => footprint.footprintBytes),
  };
  for (const category of Object.keys(present[0]!.categories)) {
    if (!present.every((footprint) => footprint.categories[category] !== undefined)) continue;
    series[`footprint ${category} dirty`] = present.map(
      (footprint) => footprint.categories[category]!.dirtyBytes,
    );
  }
  return series;
}

export type VmStat = {
  pageSizeBytes: number;
  freeBytes: number;
  activeBytes: number;
  inactiveBytes: number;
  wiredBytes: number;
  occupiedByCompressorBytes: number;
  swapins: number;
  swapouts: number;
};

/** Parse `vm_stat`: page counts become bytes; swap counters stay cumulative counts. */
export function parseVmStat(output: string): VmStat | null {
  const pageSize = /page size of (\d+) bytes/u.exec(output);
  if (pageSize === null) return null;
  const pageSizeBytes = Number(pageSize[1]);
  const count = (label: string): number => {
    const match = new RegExp(String.raw`^${label}:\s+(\d+)\.`, 'mu').exec(output);
    return match === null ? 0 : Number(match[1]);
  };
  return {
    pageSizeBytes,
    freeBytes: count('Pages free') * pageSizeBytes,
    activeBytes: count('Pages active') * pageSizeBytes,
    inactiveBytes: count('Pages inactive') * pageSizeBytes,
    wiredBytes: count('Pages wired down') * pageSizeBytes,
    occupiedByCompressorBytes: count('Pages occupied by compressor') * pageSizeBytes,
    swapins: count('Swapins'),
    swapouts: count('Swapouts'),
  };
}

export type MemoryPressure = {
  /** `kern.memorystatus_level`: the percentage of memory the kernel counts as available. */
  availablePercentage: number | null;
  vmStat: VmStat | null;
};

export type CommandResult = { exitCode: number | null; stdout: string };

export type MemoryPressureOptions = {
  platform?: NodeJS.Platform;
  /** Runs one command synchronously; it may throw when the executable is missing. */
  run?: (command: string[]) => CommandResult;
};

function runCommand(command: string[]): CommandResult {
  const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'ignore' });
  return { exitCode: result.exitCode, stdout: result.stdout.toString() };
}

/** Run a command, treating a missing executable or a spawn failure as no reading. */
function tryRun(
  run: (command: string[]) => CommandResult,
  command: string[],
): CommandResult | null {
  try {
    const result = run(command);
    return result.exitCode === 0 ? result : null;
  } catch {
    return null;
  }
}

/**
 * Read host memory pressure. `kern.memorystatus_level` and `vm_stat` exist only on macOS, so any
 * other platform, or a tool that cannot be spawned, yields nulls rather than an exception.
 */
export function captureMemoryPressure(options: MemoryPressureOptions = {}): MemoryPressure {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') return { availablePercentage: null, vmStat: null };
  const run = options.run ?? runCommand;
  const level = tryRun(run, ['sysctl', '-n', 'kern.memorystatus_level']);
  const parsedLevel = level === null ? Number.NaN : Number(level.stdout.trim());
  const vmStat = tryRun(run, ['vm_stat']);
  return {
    availablePercentage: Number.isFinite(parsedLevel) ? parsedLevel : null,
    vmStat: vmStat === null ? null : parseVmStat(vmStat.stdout),
  };
}
