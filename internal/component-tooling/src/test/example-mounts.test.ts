import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { exampleFiles, mountExample } from './example-mounts.ts';

// A package's source in miniature: one component with three examples, and an example-named file
// outside its `examples/` directory, which is not one.
const source = join(import.meta.dir, 'fixtures', 'example-mounts');
const examples = join(source, 'components', 'widget', 'examples');

describe('exampleFiles', () => {
  test('finds each example in an examples/ directory, and nothing else', () => {
    expect(exampleFiles(source)).toEqual(
      ['noisy', 'quiet', 'throws'].map((name) => join(examples, `${name}.example.svelte`)),
    );
  });
});

describe('mountExample', () => {
  test('mounts and unmounts a clean example with no error', async () => {
    expect(await mountExample(join(examples, 'quiet.example.svelte'))).toEqual([]);
    expect(document.querySelector('.example-mounts-widget')).toBeNull();
  });

  test('returns what an example writes to console.error', async () => {
    expect(await mountExample(join(examples, 'noisy.example.svelte'))).toEqual([
      'the widget is broken',
    ]);
  });

  test('throws what an example throws', async () => {
    let message = '';
    try {
      await mountExample(join(examples, 'throws.example.svelte'));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('cannot render');
  });
});
