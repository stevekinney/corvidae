/**
 * Run the official A2A Technology Compatibility Kit against Bureau (COR-1543).
 *
 * `bun run --filter=@lostgradient/bureau test:a2a-tck` starts `a2a-tck-host.ts`, reads the agent's
 * URL from the one stdout line `A2A_TCK_SUT_URL=<url>` it prints, and runs Weft's TCK runner
 * (`packages/weft/scripts/run-a2a-tck.ts`) with `--sut-host <url>`. That runner owns the pinned
 * TCK commit, its levels (`must`, `should`, `may`), and its recorded exclusions, so Bureau pins
 * none of them a second time. It needs Python 3.11 or later, `uv`, and network access to clone
 * the TCK; it is not part of `bun run validate`.
 */

import { join } from 'node:path';

const BUREAU_ROOT = join(import.meta.dir, '..');
const HOST_ENTRY = join(import.meta.dir, 'a2a-tck-host.ts');
const WEFT_RUNNER = join(BUREAU_ROOT, '..', 'weft', 'scripts', 'run-a2a-tck.ts');
const URL_PATTERN = /^A2A_TCK_SUT_URL=(\S+)$/m;

/**
 * TCK tests deselected for Bureau on top of Weft's recorded ones, as pytest node identifiers. Each
 * is a capability Bureau does not serve, so it is a Bureau limit and not a TCK defect: the owner
 * rules on each entry before this list is final.
 *
 * - The file, file-URL, and data artifact tests need an agent that answers with a non-text
 *   artifact. A Bureau agent answers in `text/plain` (the card's `defaultOutputModes`), and
 *   COR-788 projects other content.
 * - The message-response test needs an agent that answers a send with a bare `Message`. Every
 *   Bureau send creates a task, whose history holds the reply.
 */
export const BUREAU_TCK_EXCLUSIONS = [
  'tests/compatibility/core_operations/test_artifacts.py::TestFileArtifact::test_task_has_file_artifact[jsonrpc]',
  'tests/compatibility/core_operations/test_artifacts.py::TestFileUrlArtifact::test_task_has_file_url_artifact[jsonrpc]',
  'tests/compatibility/core_operations/test_artifacts.py::TestDataArtifact::test_task_has_data_artifact[jsonrpc]',
  'tests/compatibility/core_operations/test_artifacts.py::TestMessageResponse::test_returns_message_with_text_part[jsonrpc]',
] as const;

/** The agent's URL, from the host's stdout line. */
export function sutUrlOf(output: string): string | undefined {
  return URL_PATTERN.exec(output)?.[1];
}

async function startHost(): Promise<{ url: string; stop(): Promise<void> }> {
  const child = Bun.spawn(['bun', HOST_ENTRY], {
    cwd: BUREAU_ROOT,
    env: { ...Bun.env, PORT: '0' },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const stop = async (): Promise<void> => {
    child.kill('SIGTERM');
    await child.exited;
  };
  const chunks = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let output = '';
  for (let read = await chunks.read(); !read.done; read = await chunks.read()) {
    output += read.value;
    const url = sutUrlOf(output);
    if (url === undefined) continue;
    // Keep reading, so the host never blocks on a full pipe.
    void (async () => {
      for (let rest = await chunks.read(); !rest.done; rest = await chunks.read());
    })();
    return { url, stop };
  }
  throw new Error(`The TCK host exited before it listened:\n${output}`);
}

if (import.meta.main) {
  const host = await startHost();
  let code = 1;
  try {
    const deselect = BUREAU_TCK_EXCLUSIONS.flatMap((test) => ['--deselect', test]);
    const runner = Bun.spawn(['bun', WEFT_RUNNER, '--sut-host', host.url, ...deselect], {
      stdout: 'inherit',
      stderr: 'inherit',
    });
    code = await runner.exited;
  } finally {
    await host.stop();
  }
  process.exit(code);
}
