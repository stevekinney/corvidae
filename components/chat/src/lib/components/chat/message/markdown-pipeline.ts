import type { RenderOptions } from '@lostgradient/markdown';

type MarkdownPipeline = {
  renderMarkdownWithMath: (content: string, options?: RenderOptions) => Promise<{ html: string }>;
};

type MarkdownPipelineLoader = () => Promise<MarkdownPipeline>;

let pipelinePromise: Promise<MarkdownPipeline | undefined> | undefined;

/**
 * Forgets the loaded pipeline, so the next preload loads again. The cache lives for the whole
 * process: a test that preloads a stand-in pipeline forgets it afterwards, so a later file in the
 * same process (Bun runs many in one) starts from no pipeline, as a page does.
 */
export function forgetMarkdownPipeline(): void {
  pipelinePromise = undefined;
}

/** Start loading the markdown renderer before the first streamed token arrives. */
export function preloadMarkdownPipeline(
  loadPipeline?: MarkdownPipelineLoader,
): Promise<MarkdownPipeline | undefined> | undefined {
  // Only preload in a real browser realm. This also keeps SSR and DOM-test
  // harnesses from evaluating the browser-only rendering graph.
  if (typeof window === 'undefined' || window !== globalThis) return undefined;

  if (pipelinePromise !== undefined) return pipelinePromise;
  const loading: Promise<MarkdownPipeline | undefined> = (
    loadPipeline?.() ?? import('@lostgradient/markdown')
  )
    .then(({ renderMarkdownWithMath }) => ({ renderMarkdownWithMath }))
    .catch(() => {
      // Allow a later stream to retry after a transient chunk-load failure. Only this load's own
      // cache entry is cleared: a load that was forgotten, and rejects after a newer one began,
      // must not throw the newer one away.
      if (pipelinePromise === loading) pipelinePromise = undefined;
      return undefined;
    });
  pipelinePromise = loading;
  return loading;
}
