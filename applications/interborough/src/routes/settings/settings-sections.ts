/**
 * The sections of Settings, in the order the section navigation lists them: the Bureau's runtime
 * settings, the data and retention overview, and the API reference. Each is a route of its own
 * (`app/routes.ts`), so a section is linked to, and survives a reload.
 */
import { SETTINGS_SECTION_COPY } from '../../app/copy.ts';

/** One section of Settings. */
export interface SettingsSection {
  readonly path: string;
  readonly label: string;
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { path: '/settings', label: SETTINGS_SECTION_COPY.general },
  { path: '/settings/model-policy', label: SETTINGS_SECTION_COPY.modelPolicy },
  { path: '/settings/data-and-retention', label: SETTINGS_SECTION_COPY.dataAndRetention },
  { path: '/settings/api-reference', label: SETTINGS_SECTION_COPY.apiReference },
];
