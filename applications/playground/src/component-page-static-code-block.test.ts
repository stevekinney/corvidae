import { describe, expect, test } from 'bun:test';

const classNames = (source: string): Set<string> =>
  new Set(source.match(/cinder-code-block(?:__[a-z-]+)?/g) ?? []);

describe('static code block', () => {
  test('uses only class names that CodeBlock itself renders or styles', async () => {
    // The static block repeats CodeBlock's markup so the exported page needs no
    // client script. A class CodeBlock no longer uses leaves the copy unstyled
    // with no error, so the two must name the same parts.
    const staticSource = await Bun.file(
      new URL('./component-page-static-code-block.svelte', import.meta.url),
    ).text();
    const codeBlockDirectory = new URL(
      '../../../components/cinder/src/components/code-block/',
      import.meta.url,
    );
    const codeBlockSource = await Bun.file(new URL('code-block.svelte', codeBlockDirectory)).text();
    const codeBlockStyles = await Bun.file(new URL('code-block.css', codeBlockDirectory)).text();
    const known = new Set([...classNames(codeBlockSource), ...classNames(codeBlockStyles)]);

    const unknown = [...classNames(staticSource)].filter((name) => !known.has(name));
    expect(unknown).toEqual([]);
    expect(staticSource).not.toContain('<header');
  });
});
