/**
 * Visual-regression fixtures for Chip.
 *
 * The default `assertion` fixture is the application's own. `suggested` renders a suggested chip
 * beside an unsuggested one, as a display chip and as a toggle chip, so the glyph that tells a
 * sighted person apart from colour alone (COR-2441) can be judged.
 */
export default [
  {
    name: 'suggested',
    host: './chip-suggested.fixture.svelte',
  },
];
