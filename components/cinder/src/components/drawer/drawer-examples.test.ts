import { describe, expect, test } from 'bun:test';

// COR-2443 AC2: the detent bottom sheet COR-2322 shipped has a documented example, and the
// playground shows it from a file of the same name.
const examples = (await Bun.file(new URL('./drawer.examples.json', import.meta.url)).json()) as {
  examples: { id: string; code: string }[];
};

describe('Drawer examples', () => {
  test('a detents example shows the sheet with its count and footer', () => {
    const example = examples.examples.find((candidate) => candidate.id === 'detents');
    expect(example).toBeDefined();
    expect(example!.code).toContain("detents={['peek', 'medium', 'large']}");
    expect(example!.code).toContain('placement="bottom"');
    expect(example!.code).toContain('count=');
    expect(example!.code).toContain('{#snippet footer()}');
  });

  test('the playground shows it, with the same code as the example body', async () => {
    const file = await Bun.file(
      new URL(
        '../../../../../applications/playground/src/examples/drawer/detents.example.svelte',
        import.meta.url,
      ),
    ).text();
    const example = examples.examples.find((candidate) => candidate.id === 'detents')!;
    const script = file.slice(file.indexOf('<script lang="ts">\n'));
    expect(script.trim()).toBe(example.code.trim());
  });
});
