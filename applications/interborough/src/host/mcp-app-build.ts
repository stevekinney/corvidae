/**
 * Builds an MCP App's page into one self-contained HTML document (COR-910): the script and the
 * styles are inline, so the document needs no origin to load from and runs under the deny-all
 * content security policy a host gives a `ui://` resource. The digest names the exact bytes.
 */
import { fileURLToPath } from 'node:url';

/** A built page and the digest of its bytes. */
export type BuiltMcpApp = {
  readonly html: string;
  /** `sha256:<64 hex>`, the form `bureau.interactive-surface.v1` names. */
  readonly contentDigest: string;
};

/** Escape what would end the inline script early. */
function inlineScript(code: string): string {
  return code.replaceAll('</script', '<\\/script').replaceAll('<!--', '<\\!--');
}

/** Compute the contract's digest of `html`. */
export function digestOf(html: string): string {
  return `sha256:${new Bun.CryptoHasher('sha256').update(html).digest('hex')}`;
}

/** Bundle `entry` and wrap it in a page with `title` and `styles`. */
export async function buildMcpAppPage(options: {
  readonly entry: string;
  readonly title: string;
  readonly styles: string;
}): Promise<BuiltMcpApp> {
  const result = await Bun.build({
    entrypoints: [fileURLToPath(options.entry)],
    target: 'browser',
    format: 'esm',
    minify: true,
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  });
  if (!result.success || result.outputs.length !== 1) {
    throw new AggregateError(result.logs, `The ${options.title} page did not build`);
  }
  const script = await result.outputs[0]!.text();
  const html = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${options.title}</title><style>${options.styles}</style><div id="root"></div><script type="module">${inlineScript(script)}</script>`;
  return { html, contentDigest: digestOf(html) };
}
