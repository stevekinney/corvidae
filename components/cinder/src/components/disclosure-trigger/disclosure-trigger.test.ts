import { expect, test } from 'bun:test';

test('keeps disclosure controls reachable without moving the chevron from its first text line', async () => {
  const css = await Bun.file(new URL('./disclosure-trigger.css', import.meta.url)).text();

  expect(css).toMatch(
    /\.cinder-disclosure-trigger__chevron\s*\{[^}]*margin-block-start:\s*0\.125rem/s,
  );
  expect(css).toMatch(
    /@media \(any-pointer: coarse\)\s*\{\s*\.cinder-disclosure-trigger\s*\{[^}]*min-block-size:\s*var\(--cinder-touch-target-min\)/s,
  );
});
