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

type Preview = { readonly dryRun: true; readonly preview: string };
type Result = { readonly value: string };
type PreviewOperations = {
  flagged: { input: { dryRun?: boolean }; output: Result | Preview };
  unflagged: { input: { dryRun?: boolean }; output: Result | Preview };
};
declare const previews: CatalogClient<PreviewOperations, 'flagged'>;
declare const runtimeBoolean: boolean;
export const omitted: Promise<Result> = previews.flagged({});
export const explicitFalse: Promise<Result> = previews.flagged({ dryRun: false });
export const explicitTrue: Promise<Preview> = previews.flagged({ dryRun: true });
export const dynamic: Promise<Result | Preview> = previews.flagged({ dryRun: runtimeBoolean });
export const control: Promise<Result | Preview> = previews.unflagged({ dryRun: true });

function callGeneric<Name extends keyof PreviewOperations>(
  genericClient: CatalogClient<PreviewOperations>,
  name: Name,
  input: PreviewOperations[Name]['input'],
): Promise<PreviewOperations[Name]['output']> {
  return genericClient[name](input);
}
export { callGeneric };
