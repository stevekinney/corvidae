export type ProductOracle = {
  selector: string;
  text?: string;
  descendant?: string;
  attribute?: { name: string; value: string };
  visibility?: 'visible' | 'attached';
  behavior?:
    | 'alert-dialog'
    | 'backdrop'
    | 'command-palette'
    | 'confirm-dialog'
    | 'drawer'
    | 'focus-trap'
    | 'portal'
    | 'sidebar'
    | 'toast-region';
};

export const productOracles: Record<string, ProductOracle> = {
  'action-row': { selector: `[class*="cinder-action-row"]`, text: 'Morning sync' },
  alert: { selector: `[class*="cinder-alert"]`, text: 'You have 3 unread notifications.' },
  'alert-dialog': {
    selector: 'button',
    text: 'Open alert dialog',
    behavior: 'alert-dialog',
  },
  'approval-card': { selector: `[class*="cinder-approval-card"]`, text: 'deploy-cloud' },
  'aspect-ratio': { selector: `[class*="cinder-aspect-ratio"]`, text: '16:9' },
  autocomplete: { selector: `[class*="cinder-autocomplete"]`, text: 'Destination city' },
  avatar: { selector: `[class*="cinder-avatar"]`, descendant: 'img' },
  backdrop: { selector: 'button', text: 'Show dimmed backdrop', behavior: 'backdrop' },
  badge: { selector: `[class*="cinder-badge"]`, text: 'Extra small' },
  breadcrumbs: { selector: `[class*="cinder-breadcrumbs"]`, descendant: ':scope > *' },
  'button-group': {
    selector: `[class*="cinder-button-group"]`,
    attribute: { name: 'aria-label', value: 'Document actions' },
  },
  calendar: { selector: `[class*="cinder-calendar"]`, descendant: '[role="grid"]' },
  callout: { selector: `[class*="cinder-callout"]`, text: 'Note' },
  'capability-gate': { selector: `[class*="cinder-capability-gate"]`, text: 'Allow microphone' },
  checkbox: { selector: `[class*="cinder-checkbox"]`, text: 'I accept the terms of service' },
  chip: { selector: `[class*="cinder-chip"]`, text: 'Disabled toggle' },
  'choice-grid': { selector: `[class*="cinder-choice-grid"]`, text: 'London' },
  'click-away-listener': {
    selector: 'button',
    text: 'Open inline editor',
  },
  'code-block': { selector: `[class*="cinder-code-block"]`, descendant: 'pre' },
  collapsible: { selector: `[class*="cinder-collapsible"]`, descendant: ':scope > *' },
  'color-field': {
    selector: `[class*="cinder-color-field"] button`,
    attribute: {
      name: 'aria-label',
      value: 'Choose a color, current color #3b82f6',
    },
  },
  'color-swatch-picker': {
    selector: `[class*="cinder-color-swatch-picker"]`,
    descendant: '[role="option"]',
  },
  'command-palette': { selector: 'button', text: 'Open palette', behavior: 'command-palette' },
  'confirm-dialog': { selector: 'button', text: 'Delete item', behavior: 'confirm-dialog' },
  'connection-indicator': {
    selector: `[class*="cinder-connection-indicator"]`,
    attribute: { name: 'data-cinder-status', value: 'live' },
  },
  container: { selector: `[class*="cinder-container"]`, descendant: ':scope > *' },
  'context-menu': { selector: `[class*="cinder-context-menu"]`, descendant: ':scope > *' },
  'copy-button': {
    selector: `[class*="cinder-copy-button"]`,
    attribute: { name: 'aria-label', value: 'Copy install command' },
  },
  'data-list': { selector: `[class*="cinder-data-list"]`, text: 'Alice Chen' },
  'description-list': { selector: `[class*="cinder-description-list"]`, text: 'Component' },
  'diff-statistics': {
    selector: `[class*="cinder-diff-statistics"]`,
    descendant: '.cinder-diff-statistics__stat',
  },
  divider: {
    selector: `[class*="cinder-divider"]`,
    attribute: { name: 'data-cinder-orientation', value: 'horizontal' },
  },
  text: { selector: `[class*="cinder-text"]`, text: 'Heading 1' },
  drawer: { selector: 'button', text: 'Open drawer', behavior: 'drawer' },
  'empty-state': { selector: `[class*="cinder-empty-state"]`, text: 'No results found' },
  'error-state': { selector: `[class*="cinder-error-state"]`, text: 'Could not load runs' },
  feed: {
    selector: `[class*="cinder-feed"]`,
    attribute: { name: 'aria-label', value: 'Project activity' },
  },
  'feed-boundary': {
    selector: `[class*="cinder-feed-boundary"]`,
    text: 'Connection lost — retrying',
  },
  'file-upload': { selector: `[class*="cinder-file-upload"]`, text: 'Click to upload' },
  'filter-bar': {
    selector: `[class*="cinder-filter-bar"]`,
    attribute: { name: 'aria-label', value: 'Workflow filters' },
  },
  'focus-trap': { selector: 'button', behavior: 'focus-trap' },
  'form-field': { selector: `[class*="cinder-form-field"]`, text: 'Full name' },
  'form-section': { selector: `[class*="cinder-form-section"]`, text: 'Account' },
  'grid-list': { selector: `[class*="cinder-grid-list"]`, text: 'Phoenix' },
  image: { selector: `[class*="cinder-image"]`, descendant: 'img' },
  'inline-loading': {
    selector: `[class*="cinder-inline-loading"]`,
    attribute: { name: 'data-cinder-status', value: 'active' },
  },
  'invocation-rule-builder': {
    selector: `[class*="cinder-invocation-rule-builder"]`,
    attribute: { name: 'aria-label', value: 'PR routing rules' },
  },
  'json-editor': { selector: `[class*="cinder-json-editor"]`, text: 'Request payload' },
  'json-viewer': { selector: `[class*="cinder-json-viewer"]`, text: 'wf_3c4fce' },
  'kanban-board': {
    selector: `[class*="cinder-kanban-board"]`,
    attribute: { name: 'aria-label', value: 'Project work board' },
  },
  kbd: { selector: `[class*="cinder-kbd"]`, text: 'Esc' },
  link: { selector: `[class*="cinder-link"]`, text: 'documentation' },
  'load-more': { selector: `[class*="cinder-load-more"]`, descendant: 'button' },
  'matrix-chart': {
    selector: `[class*="cinder-matrix-chart"]`,
    text: 'Confusion matrix — Animal classifier',
  },
  'media-controls': { selector: `[class*="cinder-media-controls"]`, descendant: 'button' },
  message: { selector: `[class*="cinder-message"]`, text: 'Ada Lovelace' },
  'page-header': { selector: `[class*="cinder-page-header"]`, text: 'Approvals' },
  pagination: { selector: `[class*="cinder-pagination"]`, descendant: 'button' },
  'payload-inspector': {
    selector: `[class*="cinder-payload-inspector"]`,
    text: 'Checkout payload',
  },
  'permission-matrix': {
    selector: `[class*="cinder-permission-matrix"]`,
    text: 'Operation scope matrix',
  },
  portal: { selector: 'button', behavior: 'portal' },
  'pricing-card': { selector: `[class*="cinder-pricing-card"]`, descendant: ':scope > *' },
  'qr-code': {
    selector: `[class*="cinder-qr-code"]`,
    attribute: { name: 'aria-label', value: 'Scan to open the cinder components page' },
  },
  'radio-group': { selector: `[class*="cinder-radio-group"]`, text: 'Pricing tier' },
  'resizable-panels': {
    selector: `[class*="cinder-resizable-panels"]`,
    descendant: '[role="separator"]',
  },
  'run-step-timeline': {
    selector: `[class*="cinder-run-step-timeline"]`,
    attribute: { name: 'aria-label', value: 'Deployment run' },
  },
  'schedule-builder': {
    selector: `[class*="cinder-schedule-builder"]`,
    attribute: { name: 'aria-label', value: 'Data sync schedule' },
  },
  'scroll-area': { selector: `[class*="cinder-scroll-area"]`, descendant: ':scope > *' },
  'search-field': {
    selector: `[class*="cinder-search-field"] input`,
    attribute: { name: 'aria-label', value: 'Search components' },
  },
  'secret-value-field': {
    selector: `[class*="cinder-secret-value-field"]`,
    text: 'API Key',
  },
  'share-card': { selector: `[class*="cinder-share-card"]`, text: 'Invite a teammate' },
  'shortcut-hint': { selector: `[class*="cinder-shortcut-hint"]`, descendant: ':scope > *' },
  sidebar: { selector: 'button', text: 'sidebar', behavior: 'sidebar' },
  skeleton: { selector: `[class*="cinder-skeleton"]` },
  'skip-link': {
    selector: 'a[href="#main"]',
    text: 'Skip to main content',
    visibility: 'attached',
  },
  slider: { selector: `[class*="cinder-slider"]`, text: 'Volume' },
  'source-diff-viewer': {
    selector: `[class*="cinder-source-diff-viewer"]`,
    descendant: `[class*="__line-code"]`,
  },
  sparkbar: { selector: `[class*="cinder-sparkbar"]`, text: 'Draft weekly changelog' },
  spectrogram: { selector: `[class*="cinder-spectrogram"]`, text: 'Voice spectrogram' },
  'spectrum-chart': {
    selector: `[class*="cinder-spectrum-chart"]`,
    text: 'Frequency spectrum — A4 note (440 Hz)',
  },
  spinner: { selector: `[class*="cinder-spinner"]` },
  'stacked-list-item': { selector: `[class*="cinder-stacked-list-item"]`, text: 'Getting started' },
  'statistic-group': {
    selector: `[class*="cinder-statistic-group"]`,
    attribute: { name: 'aria-label', value: 'Workspace usage' },
  },
  'status-dot': { selector: `[class*="cinder-status-dot"]`, text: 'Online' },
  surface: { selector: `[class*="cinder-surface"]`, descendant: ':scope > *' },
  'table-of-contents': {
    selector: `[class*="cinder-table-of-contents"]`,
    descendant: ':scope > *',
  },
  'tag-input': {
    selector: `[class*="cinder-tag-input"] input`,
    attribute: { name: 'placeholder', value: 'Add a topic…' },
  },
  textarea: { selector: `[class*="cinder-textarea"]`, text: 'Bio' },
  'time-field': { selector: `[class*="cinder-time-field"]`, text: 'Reminder time' },
  timeline: {
    selector: `[class*="cinder-timeline"]`,
    attribute: { name: 'aria-label', value: 'Incident timeline' },
  },
  'toast-region': { selector: 'button', text: 'Dismiss-after-action', behavior: 'toast-region' },
  toolbar: {
    selector: `[class*="cinder-toolbar"]`,
    attribute: { name: 'aria-label', value: 'Document actions' },
  },
  'transfer-list': { selector: `[class*="cinder-transfer-list"]`, text: 'Available permissions' },
  waveform: { selector: `[class*="cinder-waveform"]`, text: 'Voice recording waveform' },
  label: { selector: `[class*="cinder-label"]`, text: 'Project name' },
  'locale-provider': { selector: 'p[lang="en-US"]', text: 'Localized content' },
  'chat-composer-popover': {
    selector: '.chat-input-editor',
    attribute: { name: 'role', value: 'combobox' },
  },
  'chat-conversation-header': {
    selector: `[class*="chat-conversation-header"]`,
    text: 'Launch support',
  },
  'chat-conversation-list': {
    selector: `[class*="chat-conversation-list"]`,
    text: 'Launch support',
  },
  'diff-viewer': { selector: `[class*="diff-viewer"]`, text: 'Project Plan' },
};
