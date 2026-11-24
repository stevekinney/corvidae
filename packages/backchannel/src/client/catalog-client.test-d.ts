import { createProbeClientWithTransport } from '../__fixtures__/probe-client/portable-operation-client.generated.ts';
import type { CatalogCallOptions, CatalogClient, CatalogTransport } from './catalog-client.ts';

type Operations = {
  'probe.echo': {
    readonly input: { message: string };
    readonly output: { message: string };
  };
};

declare const client: CatalogClient<Operations>;

// Every method takes its input, and an options argument that may be left out.
export const withoutOptions: Promise<{ message: string }> = client['probe.echo']({
  message: 'hello',
});
export const withSignal: Promise<{ message: string }> = client['probe.echo'](
  { message: 'hello' },
  { signal: new AbortController().signal },
);
export const withFetch: Promise<{ message: string }> = client['probe.echo'](
  { message: 'hello' },
  { fetch: async () => new Response() },
);
export const withBoth: Promise<{ message: string }> = client['probe.echo'](
  { message: 'hello' },
  { signal: new AbortController().signal, fetch: fetch },
);

// @ts-expect-error the input is required.
export const withoutInput = client['probe.echo']();
// @ts-expect-error an option the call does not know is refused.
export const withUnknownOption = client['probe.echo']({ message: 'hello' }, { timeout: 1 });

// A transport that ignores the options still satisfies the seam, and one that reads them types them.
export const ignoring: CatalogTransport = async (_operationName, _input) => null;
export const reading: CatalogTransport = async (_operationName, _input, options) => {
  const call: CatalogCallOptions | undefined = options;
  return call?.signal?.aborted;
};

const generated = createProbeClientWithTransport(ignoring);
export const generatedResult: Promise<null> = generated['probe.jobs.cancel']({ id: 'job' });
// @ts-expect-error generated input requires an id.
generated['probe.jobs.cancel']({});
