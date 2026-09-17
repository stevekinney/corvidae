<script lang="ts">
  import {
    STORAGE_KEY_PREFIX,
    addDraftComment,
    clearAllPersistedSessions,
    createSession,
    getStorageKey,
    hasPersistedSession,
    listPersistedSessions,
    loadSession,
    saveSession,
    submitSession,
    type ReviewSession,
  } from '@repo/editor';
  import {
    T_LATEST,
    T_LATER,
    T_START,
    draftThreadComment,
    keysOf,
    validationBase,
  } from './state-session-utilities';

  const BASIC_KEY = 'sess-basic';
  const SUBMITTED_KEY = 'sess-submitted';
  const BAD_JSON_KEY = 'sess-badjson';
  const BAD_SHAPE_KEY = 'sess-badshape';
  const LIST_KEY_A = 'sess-a';
  const LIST_KEY_B = 'sess-b';

  const storagePrefix = STORAGE_KEY_PREFIX;
  const basicStorageKey = getStorageKey(BASIC_KEY);

  function basicSession(): ReviewSession {
    return addDraftComment(
      createSession('session-basic', T_START),
      draftThreadComment('draft-1', T_LATER),
    ).session;
  }

  let saveResult = $state('(not saved)');
  let storedTopLevelKeys = $state('(not saved)');
  let storedAnchorKeys = $state('(not saved)');
  let storedAnchorFromTo = $state('(not saved)');
  let loadedAnchorFromTo = $state('(not loaded)');
  let loadedRoundTrip = $state('(not loaded)');
  let hasAfterLoad = $state('(not loaded)');
  let loadSubmitted = $state('(not run)');
  let loadBadJson = $state('(not run)');
  let loadBadShape = $state('(not run)');
  let sessionList = $state('(not listed)');
  let listAfterClearAll = $state('(not cleared)');

  function clearAllStorage(): void {
    clearAllPersistedSessions();
    saveResult = '(not saved)';
    storedTopLevelKeys = '(not saved)';
    storedAnchorKeys = '(not saved)';
    storedAnchorFromTo = '(not saved)';
    loadedAnchorFromTo = '(not loaded)';
    loadedRoundTrip = '(not loaded)';
    hasAfterLoad = '(not loaded)';
    loadSubmitted = '(not run)';
    loadBadJson = '(not run)';
    loadBadShape = '(not run)';
    sessionList = '(not listed)';
    listAfterClearAll = '(not cleared)';
  }

  function saveBasicSession(): void {
    saveResult = String(saveSession(BASIC_KEY, basicSession()));
    const raw = sessionStorage.getItem(basicStorageKey);
    if (!raw) {
      storedTopLevelKeys = '(nothing stored)';
      storedAnchorKeys = '(nothing stored)';
      storedAnchorFromTo = '(nothing stored)';
      return;
    }
    const stored = JSON.parse(raw) as Record<string, unknown> & {
      draftComments: Array<{ anchor?: Record<string, unknown> }>;
    };
    storedTopLevelKeys = keysOf(stored);
    const anchor = stored.draftComments[0]?.anchor;
    storedAnchorKeys = anchor ? keysOf(anchor) : '(no anchor)';
    storedAnchorFromTo = anchor
      ? `from-key=${'from' in anchor} to-key=${'to' in anchor}`
      : '(no anchor)';
  }

  function loadBasicSession(): void {
    const restored = loadSession(BASIC_KEY);
    if (!restored) {
      loadedAnchorFromTo = '(null)';
      loadedRoundTrip = '(null)';
      hasAfterLoad = String(hasPersistedSession(BASIC_KEY));
      return;
    }
    const anchor = restored.draftComments[0]?.anchor;
    loadedAnchorFromTo = anchor ? `from=${anchor.from} to=${anchor.to}` : '(no anchor)';
    loadedRoundTrip = `id=${restored.id} status=${restored.status} drafts=${restored.draftComments.length} quote=${anchor?.quote} authorId=${restored.draftComments[0]?.authorId} createdAt=${restored.draftComments[0]?.createdAt}`;
    hasAfterLoad = String(hasPersistedSession(BASIC_KEY));
  }

  function runSubmittedLoad(): void {
    const session = submitSession(basicSession(), 'approve', T_LATEST).session;
    saveSession(SUBMITTED_KEY, session);
    const before = hasPersistedSession(SUBMITTED_KEY);
    const restored = loadSession(SUBMITTED_KEY);
    loadSubmitted = `stored-before=${before} loaded=${String(restored)} stored-after=${hasPersistedSession(SUBMITTED_KEY)}`;
  }

  function runBadJsonLoad(): void {
    sessionStorage.setItem(getStorageKey(BAD_JSON_KEY), '{ this is not json');
    const before = hasPersistedSession(BAD_JSON_KEY);
    const restored = loadSession(BAD_JSON_KEY);
    loadBadJson = `stored-before=${before} loaded=${String(restored)} stored-after=${hasPersistedSession(BAD_JSON_KEY)}`;
  }

  function runBadShapeLoad(): void {
    sessionStorage.setItem(
      getStorageKey(BAD_SHAPE_KEY),
      JSON.stringify({ ...validationBase, status: 'archived' }),
    );
    const before = hasPersistedSession(BAD_SHAPE_KEY);
    const restored = loadSession(BAD_SHAPE_KEY);
    loadBadShape = `stored-before=${before} loaded=${String(restored)} stored-after=${hasPersistedSession(BAD_SHAPE_KEY)}`;
  }

  function runListSessions(): void {
    saveSession(LIST_KEY_A, createSession('session-a', T_START));
    saveSession(LIST_KEY_B, createSession('session-b', T_START));
    sessionList = listPersistedSessions().toSorted().join(',');
  }

  function runClearAllSessions(): void {
    clearAllPersistedSessions();
    listAfterClearAll = `count=${listPersistedSessions().length} raw-keys=${Object.keys(sessionStorage).filter((key) => key.startsWith(STORAGE_KEY_PREFIX)).length}`;
  }

  const SSR_PROBE_KEY = 'ssr-probe-never-written';
  const ssrProbe = ((): string => {
    try {
      const loaded = loadSession(SSR_PROBE_KEY);
      const present = hasPersistedSession(SSR_PROBE_KEY);
      const listed = listPersistedSessions();
      return `threw=false loadSession=${String(loaded)} hasPersistedSession=${present} listed-is-array=${Array.isArray(listed)}`;
    } catch (error) {
      return `threw=true ${String(error)}`;
    }
  })();

  let browserStorageProbe = $state('(not yet run)');
  let browserProbeHasRun = false;
  $effect(() => {
    if (browserProbeHasRun) return;
    browserProbeHasRun = true;
    browserStorageProbe = `saveSession=${saveSession(SSR_PROBE_KEY, createSession('probe', T_START))} listed=${listPersistedSessions().includes(SSR_PROBE_KEY)}`;
    clearAllPersistedSessions();
  });
</script>

<section style="display: grid; gap: 0.5rem;">
  <h2 style="margin: 0;">Persistence (sessionStorage)</h2>
  <div style="display: flex; flex-wrap: wrap; gap: 0.5rem;">
    <button type="button" data-testid="clear-all-storage" onclick={clearAllStorage}>
      reset storage
    </button>
    <button type="button" data-testid="save-basic" onclick={saveBasicSession}>
      saveSession(basic)
    </button>
    <button type="button" data-testid="load-basic" onclick={loadBasicSession}>
      loadSession(basic)
    </button>
    <button type="button" data-testid="load-submitted" onclick={runSubmittedLoad}>
      loadSession(submitted)
    </button>
    <button type="button" data-testid="load-bad-json" onclick={runBadJsonLoad}>
      loadSession(bad JSON)
    </button>
    <button type="button" data-testid="load-bad-shape" onclick={runBadShapeLoad}>
      loadSession(bad shape)
    </button>
    <button type="button" data-testid="list-sessions" onclick={runListSessions}>
      listPersistedSessions()
    </button>
    <button type="button" data-testid="clear-all-sessions" onclick={runClearAllSessions}>
      clearAllPersistedSessions()
    </button>
  </div>
  <p data-testid="storage-prefix" style="margin: 0;">STORAGE_KEY_PREFIX: {storagePrefix}</p>
  <p data-testid="storage-key" style="margin: 0;">getStorageKey: {basicStorageKey}</p>
  <p data-testid="save-result" style="margin: 0;">saveSession returned: {saveResult}</p>
  <p data-testid="stored-top-level-keys" style="margin: 0; overflow-wrap: anywhere;">
    stored keys: {storedTopLevelKeys}
  </p>
  <p data-testid="stored-anchor-keys" style="margin: 0; overflow-wrap: anywhere;">
    stored anchor keys: {storedAnchorKeys}
  </p>
  <p data-testid="stored-anchor-from-to" style="margin: 0;">{storedAnchorFromTo}</p>
  <p data-testid="loaded-anchor-from-to" style="margin: 0;">{loadedAnchorFromTo}</p>
  <p data-testid="loaded-round-trip" style="margin: 0; overflow-wrap: anywhere;">
    {loadedRoundTrip}
  </p>
  <p data-testid="has-after-load" style="margin: 0;">hasPersistedSession: {hasAfterLoad}</p>
  <p data-testid="load-submitted-result" style="margin: 0;">{loadSubmitted}</p>
  <p data-testid="load-bad-json-result" style="margin: 0;">{loadBadJson}</p>
  <p data-testid="load-bad-shape-result" style="margin: 0;">{loadBadShape}</p>
  <p data-testid="session-list" style="margin: 0;">listPersistedSessions: {sessionList}</p>
  <p data-testid="list-after-clear-all" style="margin: 0;">{listAfterClearAll}</p>
</section>

<section style="display: grid; gap: 0.5rem;">
  <h2 style="margin: 0;">SSR safety</h2>
  <p data-testid="ssr-probe" style="margin: 0; overflow-wrap: anywhere;">{ssrProbe}</p>
  <p data-testid="browser-storage-probe" style="margin: 0; overflow-wrap: anywhere;">
    {browserStorageProbe}
  </p>
</section>
