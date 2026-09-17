import { greet } from '@repo/shared';

if (import.meta.main) {
  console.log(greet('Turborepo'));
}
