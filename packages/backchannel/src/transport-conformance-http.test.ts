import { describeTransportConformance } from './testing.ts';
import { connectHttp } from './transport-conformance-http.test-support.ts';

describeTransportConformance('JSON-RPC HTTP', (fixture) => ({ call: connectHttp(fixture).call }), {
  subscriptions: false,
});
