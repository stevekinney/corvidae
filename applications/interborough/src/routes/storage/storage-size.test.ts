/** How large the storage is, said once for the Overview and the details: reported, alerted, then the backend's own. */
import { describe, expect, test } from 'bun:test';

import { latestStorageBytes } from './storage-size.ts';

const sample = (bytes: number) => ({ at: 0, bytes });

describe('latestStorageBytes', () => {
  test('the latest reported size comes first, then the firing alert, then the backend', () => {
    expect(
      latestStorageBytes({ samples: [sample(1), sample(2)], alertBytes: 3, hostBytes: 4 }),
    ).toBe(2);
    expect(latestStorageBytes({ samples: [], alertBytes: 3, hostBytes: 4 })).toBe(3);
    expect(latestStorageBytes({ samples: [], alertBytes: undefined, hostBytes: 4 })).toBe(4);
  });

  test('a size of zero is a size, and a backend that cannot say leaves none', () => {
    expect(latestStorageBytes({ samples: [sample(0)], alertBytes: 3, hostBytes: 4 })).toBe(0);
    expect(latestStorageBytes({ samples: [], alertBytes: undefined, hostBytes: null })).toBe(
      undefined,
    );
    expect(latestStorageBytes({ samples: [], alertBytes: undefined, hostBytes: undefined })).toBe(
      undefined,
    );
  });
});
