/**
 * The application fixtures in `fixtures/`, by component, that every package's browser suite
 * serves and this one owns (COR-2092).
 */
export const appFixtureDeclarations = {
  'area-chart': ['assertion'],
  'bar-chart': ['assertion'],
  'donut-chart': ['assertion'],
  'line-chart': ['assertion'],
  'matrix-chart': ['assertion'],
  sparkbar: ['assertion'],
  spectrogram: ['assertion'],
  'spectrum-chart': ['assertion'],
  waveform: ['assertion'],
} as const satisfies Record<string, readonly string[]>;
