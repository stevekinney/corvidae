import { typesafeProvider } from './index.ts';

/** Exercises the Typesafe provider catalog without a network request. */
export async function runRuntimeSmoke(): Promise<void> {
  let requests = 0;
  const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests += 1;
    if (init?.method !== 'POST') throw new Error('Typesafe request was not a POST.');
    return new Response(
      JSON.stringify({
        model: 'jev-smoke',
        answers: { decision: { type: 'noul', noul: 1 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  }) as typeof globalThis.fetch;
  const model = typesafeProvider.decide({
    provider: 'typesafe',
    model: 'jev',
    apiKey: 'smoke-key',
    fetch,
  });
  const decision = await model.decide({ kind: 'boolean', question: 'Is this portable?' });
  if (decision.value !== true || requests !== 1)
    throw new Error('Typesafe provider did not construct one request.');
}
