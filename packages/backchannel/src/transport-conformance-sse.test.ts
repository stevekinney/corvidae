import { describeTransportConformance } from './testing.ts';
import { connectHttp } from './transport-conformance-http.test-support.ts';

describeTransportConformance('SSE', (fixture) => ({
  ...connectHttp(fixture),
  expectHttpSubscriptionFaults: true,
}));
