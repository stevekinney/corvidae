import { parse, renderMarkdownAsync } from './index.ts';

/** Exercises parsing and server-side asynchronous rendering without a browser worker. */
export async function runRuntimeSmoke(): Promise<void> {
  if (!parse('# portable').success) throw new Error('Markdown parsing failed.');
  await renderMarkdownAsync('# portable');
}
