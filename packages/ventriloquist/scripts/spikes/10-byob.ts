/* oxlint-disable -- COR-1522 throwaway spike: measures behavior, is not production code, and is deleted or promoted by the implementation. */
/** Spike 10: can a subprocess pipe be read with a BYOB reader, to cap chunk size? And what are the chunk sizes of a default reader? */
import { guard, killGroup, report } from './spike-support.ts';
guard({ maximumRssMegabytes: 300, maximumSeconds: 20 });
const out: Record<string, unknown> = {};
{
  const child = Bun.spawn(['sh', '-c', 'head -c 3000000 /dev/zero | tr "\\0" a'], {
    stdout: 'pipe',
    stdin: 'ignore',
    stderr: 'ignore',
    detached: true,
  });
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const sizes = new Map<number, number>();
  let total = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    total += r.value.length;
    sizes.set(r.value.length, (sizes.get(r.value.length) ?? 0) + 1);
  }
  out['defaultReader'] = {
    total,
    max: Math.max(...sizes.keys()),
    distinct: [...sizes].sort((a, b) => b[1] - a[1]).slice(0, 4),
  };
}
{
  const child = Bun.spawn(['sh', '-c', 'head -c 3000000 /dev/zero | tr "\\0" a'], {
    stdout: 'pipe',
    stdin: 'ignore',
    stderr: 'ignore',
    detached: true,
  });
  try {
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader({
      mode: 'byob',
    } as never) as ReadableStreamBYOBReader;
    let total = 0;
    let max = 0;
    for (;;) {
      const r = await reader.read(new Uint8Array(65536));
      if (r.done) break;
      total += r.value!.length;
      max = Math.max(max, r.value!.length);
    }
    out['byob'] = { works: true, total, max };
  } catch (error) {
    out['byob'] = { works: false, error: String(error).slice(0, 120) };
  }
  killGroup(child.pid);
}
report('byob', out);
process.exit(0);
