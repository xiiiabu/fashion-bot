/**
 * Server-only entry point for @fashion/core.
 *
 * Everything reachable from here may use Node builtins. The package's main
 * entry point stays free of them so the Mini App, the admin panel and the
 * seller cabinet can import the money, taxonomy and state-machine code into a
 * browser bundle without a polyfill.
 */

export * from './telegram.js';
