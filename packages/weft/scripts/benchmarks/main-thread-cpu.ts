/**
 * The CPU time the calling thread spends, for throughput benchmarks that have to hold their
 * targets on a host other work is loading.
 *
 * Wall-clock throughput on a shared host measures the other processes as much as the code: on
 * one machine at a load average of 120, workflow-start admissions measured anywhere from 22,927
 * to 37,980 per second across six runs. The CPU time the benchmark's own main thread spent over
 * the same runs gave 51,586 to 54,186 per second. On an idle host the main thread is busy for
 * the whole window, so its CPU time is the wall time and a target keeps the meaning it had;
 * under load the reading drifts slightly low from cache and frequency contention, so it cannot
 * pass a run that the code did not earn. Helper threads (garbage collection and the like) are
 * left out because they run in parallel with the main thread rather than in its place.
 */

/** Starts a clock and returns a function that reads the main-thread CPU milliseconds since. */
export function startMainThreadCpuClock(): () => number {
  const started = process.threadCpuUsage();
  return () => {
    const spent = process.threadCpuUsage(started);
    return (spent.user + spent.system) / 1000;
  };
}
