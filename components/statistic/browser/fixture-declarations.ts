/**
 * The application fixtures in `fixtures/`, by component, that every package's browser suite
 * serves and this one owns (COR-2092).
 */
export const appFixtureDeclarations = {
  'statistic-group': ['assertion'],
  'statistic-group-nested': ['assertion'],
  'statistic-group-six-cell': ['assertion'],
} as const satisfies Record<string, readonly string[]>;
