/** Proof-only marker check. Run on a disposable clean checkout after its warm start. */
import { chromium, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const [checkoutArgument, homeArgument, driverArgument, outputArgument, mode] = process.argv.slice(2);
if (!checkoutArgument || !homeArgument || !driverArgument || !outputArgument || !['token', 'panel'].includes(mode ?? '')) throw new Error('Usage: marker-probe.ts <checkout> <home> <driver> <output> <token|panel>');
const checkout = resolve(checkoutArgument);
const home = resolve(homeArgument);
const driver = resolve(driverArgument);
const output = resolve(outputArgument);
const status = Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: checkout, stdout: 'pipe', stderr: 'pipe' });
if (status.exitCode !== 0 || status.stdout.length !== 0) throw new Error('Marker checkout must begin clean');
const source = join(checkout, mode === 'token' ? 'components/cinder/src/tokens/sets/foundation.tokens.json' : 'plugins/inspectors/src/run-inspector/inspector.svelte');
const original = await readFile(source, 'utf8');
const expression = mode === 'token' ? /("one":\s*\{\s*"\$value":\s*\{\s*"value":\s*)0\.25/ : /id="inspector-status"/;
const matches = [...original.matchAll(new RegExp(expression.source, 'g'))];
if (matches.length !== 1) throw new Error('Expected exactly one marker insertion point');
const modified = mode === 'token'
  ? original.replace(expression, (_match, prefix: string) => `${prefix}0.3125`)
  : original.replace(expression, 'id="inspector-status" data-cor2654-marker="cor2654-panel-marker"');
const receipt: Record<string, unknown> = { mode, source: mode === 'token' ? 'foundation.tokens.json' : 'inspector.svelte', startedAt: new Date().toISOString() };
const started = performance.now();
const lines: Array<{ milliseconds: number; text: string }> = [];
let host: ReturnType<typeof Bun.spawn<'ignore', 'pipe', 'pipe'>> | undefined;
let interrupted = false;
const stop = () => {
  interrupted = true;
  if (host !== undefined && host.exitCode === null && host.signalCode === null) host.kill('SIGTERM');
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  await writeFile(source, modified);
  if (interrupted) throw new Error('Marker probe interrupted before startup');
  host = Bun.spawn(['bun', driver, '--supervise', checkout, 'dev'], {
    cwd: checkout,
    env: { ...process.env, INTERBOROUGH_HOME: home, INTERBOROUGH_PORT: '0', INTERBOROUGH_STARTUP_PROFILE: '1' },
    stdout: 'pipe', stderr: 'pipe',
  });
  let found!: (url: string) => void;
  const listener = new Promise<string>((resolveListener) => { found = resolveListener; });
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      const parts = pending.split('\n');
      pending = parts.pop() ?? '';
      for (const text of parts) {
        lines.push({ milliseconds: performance.now() - started, text });
        const match = /Interborough is listening on (http:\/\/\S+)/.exec(text);
        if (match?.[1]) found(match[1]);
      }
    }
    pending += decoder.decode();
    if (pending) lines.push({ milliseconds: performance.now() - started, text: pending });
  };
  const streams = Promise.all([collect(host.stdout), collect(host.stderr)]);
  try {
    const url = await Promise.race([listener, host.exited.then((code) => { throw new Error(`Host exited before listening: ${code}`); })]);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      let consoleErrors = 0;
      page.on('pageerror', (error) => pageErrors.push(error.name));
      page.on('console', (message) => { if (message.type() === 'error') consoleErrors += 1; });
      const navigation = await page.goto(new URL('/settings/data-and-retention', url).href);
      const row = page.locator('[data-setting="retention.audit"]');
      const input = row.getByRole('spinbutton');
      const previous = await input.inputValue();
      const next = previous === '365' ? '90' : '365';
      await input.fill(next);
      await input.blur();
      await row.getByText('Saved just now').waitFor();
      await page.reload();
      await expect(input).toHaveValue(next);
      let markerObserved = false;
      if (mode === 'token') {
        const computed = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--cinder-space-1').trim());
        const generatedCss = await readFile(join(checkout, 'components/cinder/src/styles/tokens-base.css'), 'utf8');
        const declaration = /--cinder-space-1\s*:\s*([^;]+);/.exec(generatedCss);
        receipt['computedTokenValue'] = computed;
        receipt['generatedTokenDeclaration'] = declaration?.[0] ?? null;
        const expected = /^0?\.3125rem$/;
        markerObserved = expected.test(computed) && declaration !== null && expected.test(declaration[1]!.trim());
      } else {
        const response = await fetch(new URL('/host/plugins/inspectors/apps/run-inspector', url));
        const body: unknown = await response.json();
        markerObserved = response.ok && typeof body === 'object' && body !== null && 'html' in body && typeof body.html === 'string' && body.html.includes('cor2654-panel-marker');
      }
      receipt['navigationStatus'] = navigation?.status() ?? null;
      receipt['settingsPersisted'] = await input.inputValue() === next;
      const events = lines.flatMap(({ text }) => {
        const start = text.indexOf('STARTUP {');
        return start < 0 ? [] : [JSON.parse(text.slice(start + 'STARTUP '.length)) as Record<string, unknown>];
      });
      const producerRan = mode === 'token'
        ? events.some((event) => event['stage'] === 'cinder' && event['generated'] === true)
        : events.some((event) => event['stage'] === 'panel' && event['plugin'] === 'inspectors' &&
            event['panel'] === 'run-inspector' && event['outcome'] === 'ready' && event['built'] === true);
      receipt['producerRan'] = producerRan;
      receipt['markerObserved'] = markerObserved;
      receipt['pageErrors'] = pageErrors;
      receipt['consoleErrors'] = consoleErrors;
      receipt['actionMilliseconds'] = performance.now() - started;
      if (navigation?.status() !== 200 || !markerObserved || !producerRan || pageErrors.length > 0 || consoleErrors > 0 || interrupted) throw new Error('Required marker or browser action failed');
    } finally { await browser.close(); }
  } finally {
    if (host.exitCode === null && host.signalCode === null) host.kill('SIGTERM');
    const exit = await host.exited;
    receipt['hostExit'] = exit;
    if (exit !== 0 && exit !== 143) {
      receipt['cleanupError'] = `The supervised host exited ${exit}`;
      process.exitCode = 1;
    }
    await streams;
  }
} catch (error) {
  receipt['error'] = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  await writeFile(source, original);
  const restored = Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: checkout, stdout: 'pipe', stderr: 'pipe' });
  receipt['restoredClean'] = restored.exitCode === 0 && restored.stdout.length === 0;
  receipt['lines'] = lines;
  if (!receipt['restoredClean']) process.exitCode = 1;
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`);
}
