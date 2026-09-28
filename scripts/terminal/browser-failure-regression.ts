import { chromium } from '@playwright/test';
import { classifyBrowserFailure } from './engine-probe.ts';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent('<main>terminal probe fixture</main>');
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { probePhase?: unknown }).probePhase = {
      phase: 'after-init',
    };
  });
  const requests = ['/'];
  const diagnostics = ['console:info:fixture'];
  const result = await classifyBrowserFailure(
    () => page.evaluate(() => (globalThis as { probePhase?: unknown }).probePhase ?? 'not-started'),
    new Error('TimeoutError: forced probe failure'),
    requests,
    diagnostics,
  );
  if (
    result.status !== 'unavailable' ||
    !result.diagnostics.includes('phase:{"phase":"after-init"}') ||
    !result.cells['input-return-semantics']?.observation.includes(
      'unavailable:timeout:{"phase":"after-init"}',
    )
  )
    throw new Error(`browser failure regression failed: ${JSON.stringify(result)}`);
  console.log('browser failure regression passed');
} finally {
  await browser.close();
}
