import { describe, expect, it } from 'bun:test';
import { runInNewContext } from 'node:vm';

describe('Anthropic browser boundary', () => {
  it('executes the injected-client path in a browser-like VM without Node credential modules', async () => {
    const build = await Bun.build({
      entrypoints: [`${import.meta.dir}/fixtures/browser-entry.ts`],
      define: { 'import.meta.env': '{}' },
      format: 'cjs',
      target: 'browser',
    });
    expect(build.success).toBe(true);
    if (!build.success) return;
    const output = await new Response(build.outputs[0]).text();
    expect(output).not.toContain('node:fs');
    expect(output).not.toContain('node:path');
    expect(output).not.toContain("import('@anthropic-ai/sdk')");
    expect(output).not.toContain('import("@anthropic-ai/sdk")');
    const moduleExports: Record<string, unknown> = {};
    const context = {
      module: { exports: moduleExports },
      exports: moduleExports,
      crypto: globalThis.crypto,
      performance: globalThis.performance,
      EventTarget: globalThis.EventTarget,
      Event: globalThis.Event,
      CustomEvent: globalThis.CustomEvent,
      AbortController: globalThis.AbortController,
      AbortSignal: globalThis.AbortSignal,
      URL: globalThis.URL,
      TextEncoder: globalThis.TextEncoder,
      TextDecoder: globalThis.TextDecoder,
      DOMException: globalThis.DOMException,
      setTimeout,
      clearTimeout,
      structuredClone: globalThis.structuredClone,
    };
    runInNewContext(output, context);
    const runInjectedClient = context.module.exports['runInjectedClient'];
    const runMissingClient = context.module.exports['runMissingClient'];
    expect(typeof runInjectedClient).toBe('function');
    expect(typeof runMissingClient).toBe('function');
    if (typeof runInjectedClient !== 'function' || typeof runMissingClient !== 'function') {
      throw new TypeError('The browser fixture must export both client probes');
    }
    expect(await runInjectedClient()).toBe('browser-ok');
    const missingClientMessage = await runMissingClient();
    expect(missingClientMessage).toContain('A client option is required in browser environments');
  });
});
