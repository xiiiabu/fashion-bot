#!/usr/bin/env node
/**
 * Local orchestrator: starts Postgres/Redis checks, then the API, the bot and
 * both web apps together, with one log stream and one Ctrl-C.
 *
 * `node scripts/dev.mjs` runs everything. Pass names to run a subset, e.g.
 * `node scripts/dev.mjs api miniapp`.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SERVICES = {
  api: { cwd: 'apps/api', command: 'pnpm', args: ['dev'], color: '\x1b[36m', label: 'api    ' },
  bot: { cwd: 'apps/bot', command: 'pnpm', args: ['dev'], color: '\x1b[35m', label: 'bot    ' },
  miniapp: { cwd: 'apps/miniapp', command: 'pnpm', args: ['dev'], color: '\x1b[32m', label: 'miniapp' },
  admin: { cwd: 'apps/admin', command: 'pnpm', args: ['dev'], color: '\x1b[33m', label: 'admin  ' },
};

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

function env() {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    out[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(900);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function preflight() {
  const config = { ...env(), ...process.env };
  const database = config.DATABASE_URL ?? '';
  const dbPort = Number(database.match(/:(\d+)\//)?.[1] ?? 5432);
  const redisPort = Number((config.REDIS_URL ?? '').match(/:(\d+)/)?.[1] ?? 6379);

  const problems = [];
  if (!(await portOpen(dbPort))) {
    problems.push(`PostgreSQL is not reachable on port ${dbPort}. Start it, or run: docker compose up -d postgres`);
  }
  if (config.REDIS_URL && !(await portOpen(redisPort))) {
    console.log(
      `${DIM}Redis is not reachable on ${redisPort}; the API will fall back to an in-process cache.${RESET}`,
    );
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`\x1b[31m✗ ${problem}${RESET}`);
    process.exit(1);
  }
  if (!existsSync(join(ROOT, '.env'))) {
    console.log(`${DIM}No .env found — copy .env.example to .env first.${RESET}`);
  }
  if (!existsSync(join(ROOT, 'packages/core/dist/index.js'))) {
    console.log(`${DIM}Building @fashion/core (first run)…${RESET}`);
    await run('pnpm', ['--filter', '@fashion/core', 'build'], ROOT);
  }
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: false });
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
    child.once('error', reject);
  });
}

const children = [];

function start(name) {
  const service = SERVICES[name];
  const child = spawn(service.command, service.args, {
    cwd: join(ROOT, service.cwd),
    env: { ...process.env, FORCE_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  children.push(child);

  const prefix = `${service.color}${service.label}${RESET} ${DIM}│${RESET} `;
  const pipe = (stream) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) process.stdout.write(`${prefix}${line}\n`);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);

  child.on('exit', (code) => {
    process.stdout.write(`${prefix}exited with code ${code}\n`);
  });
}

function shutdown() {
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(0), 600);
}

const requested = process.argv.slice(2).filter((name) => name in SERVICES);
const names = requested.length > 0 ? requested : Object.keys(SERVICES);

await preflight();

console.log(`\n\x1b[1mFashion marketplace — local stack${RESET}`);
for (const name of names) console.log(`  ${SERVICES[name].color}●${RESET} ${name}`);
console.log(`${DIM}Ctrl-C stops everything.${RESET}\n`);

for (const name of names) start(name);

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
