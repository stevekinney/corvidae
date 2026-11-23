import { createProbeClientWithFetch } from '../../__fixtures__/probe-client/fetch-operation-client.generated.ts';

export const client = createProbeClientWithFetch({ baseUrl: '/api' });
