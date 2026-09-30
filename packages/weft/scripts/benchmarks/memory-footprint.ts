import { dlopen, FFIType, ptr } from 'bun:ffi';

/**
 * How a memory reading was taken.
 *
 * - `physical-footprint`: the kernel's `phys_footprint` ledger, the number
 *   Activity Monitor calls "Memory" and `vmmap -summary` calls "Physical
 *   footprint". It counts dirty and compressed pages the process owns and
 *   ignores clean pages the allocator has not returned yet.
 * - `resident-set-size`: `process.memoryUsage().rss`. Used only where the
 *   kernel offers no footprint ledger.
 */
export type MemoryMeasure = 'physical-footprint' | 'resident-set-size';

export type MemoryReading = {
  bytes: number;
  measure: MemoryMeasure;
};

/** `RUSAGE_INFO_V2` is the first flavor whose struct carries `ri_phys_footprint`. */
const RUSAGE_INFO_V2 = 2;
/**
 * `struct rusage_info_v2` starts with a 16-byte `ri_uuid`, then 64-bit counters:
 * user time, system time, package idle wakeups, interrupt wakeups, page-ins,
 * wired size, resident size, and finally `ri_phys_footprint`.
 */
const PHYSICAL_FOOTPRINT_WORD_INDEX = 9;
/** The V2 struct is 19 64-bit words including the uuid; 64 leaves ample room. */
const RUSAGE_BUFFER_WORDS = 64;

type ProcessResourceUsage = ReturnType<typeof openProcessResourceUsage>;

let cachedProcessResourceUsage: ProcessResourceUsage | undefined;
const rusageBuffer = new BigUint64Array(RUSAGE_BUFFER_WORDS);

function openProcessResourceUsage() {
  return dlopen('/usr/lib/libSystem.B.dylib', {
    proc_pid_rusage: {
      args: [FFIType.i32, FFIType.i32, FFIType.ptr],
      returns: FFIType.i32,
    },
  }).symbols.proc_pid_rusage;
}

function loadProcessResourceUsage(): ProcessResourceUsage {
  cachedProcessResourceUsage ??= openProcessResourceUsage();

  return cachedProcessResourceUsage;
}

/**
 * Reads the calling process's physical footprint through `proc_pid_rusage`,
 * which returns the same `phys_footprint` ledger value as `task_info` with
 * `TASK_VM_INFO` without needing a Mach task port.
 *
 * Throws when the call fails. A benchmark that silently fell back to another
 * measure on macOS would compare readings that are not comparable.
 */
function readDarwinPhysicalFootprintBytes(): number {
  const status = loadProcessResourceUsage()(process.pid, RUSAGE_INFO_V2, ptr(rusageBuffer));
  if (status !== 0) {
    throw new Error(`proc_pid_rusage failed with status ${status}`);
  }

  return Number(rusageBuffer[PHYSICAL_FOOTPRINT_WORD_INDEX]);
}

export function readMemoryFootprint(): MemoryReading {
  if (process.platform === 'darwin') {
    return { bytes: readDarwinPhysicalFootprintBytes(), measure: 'physical-footprint' };
  }

  return { bytes: process.memoryUsage().rss, measure: 'resident-set-size' };
}
