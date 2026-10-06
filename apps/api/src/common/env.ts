/**
 * Loads the repository's .env into process.env before anything reads it.
 *
 * This existed only by accident: importing @prisma/client has the side effect
 * of loading .env, so the API happened to see its configuration because the
 * Prisma client was imported early enough. Nothing guaranteed that order, and
 * if Prisma ever drops the behaviour the API boots with an empty configuration
 * and fails in a way that points nowhere near the cause.
 *
 * Uses Node's own loader, so there is no dependency to add. A real environment
 * (a container, a platform's secret store) sets the variables directly, and
 * those always win: this only fills what is not already set.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

let loaded = false;

export function loadEnvFile(): void {
  if (loaded) return;
  loaded = true;

  // apps/api -> repository root. Also check the working directory, so the API
  // runs from either place.
  const candidates = [
    process.env.ENV_FILE,
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '../../.env'),
    resolve(__dirname, '../../../../.env'),
  ].filter((path): path is string => Boolean(path));

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      process.loadEnvFile(path);
      return;
    } catch {
      // A malformed .env should not take the process down here; the config
      // validation that follows reports precisely what is missing.
      return;
    }
  }
}
