/**
 * Visual-regression fixtures for ConnectionIndicator.
 *
 * The default `assertion` fixture renders the `live` status, so each of the
 * other five statuses has its own fixture, and every status keeps a committed
 * baseline.
 */
export default [
  {
    name: 'connecting',
    host: './connection-indicator.fixture.svelte',
    props: {
      status: 'connecting',
    },
  },
  {
    name: 'reconnecting',
    host: './connection-indicator.fixture.svelte',
    props: {
      status: 'reconnecting',
    },
  },
  {
    name: 'polling',
    host: './connection-indicator.fixture.svelte',
    props: {
      status: 'polling',
    },
  },
  {
    name: 'stale',
    host: './connection-indicator.fixture.svelte',
    props: {
      status: 'stale',
    },
  },
  {
    name: 'closed',
    host: './connection-indicator.fixture.svelte',
    props: {
      status: 'closed',
    },
  },
];
