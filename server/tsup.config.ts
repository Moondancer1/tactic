import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  // node:sqlite has no un-prefixed alias; keep the protocol on all builtins.
  removeNodeProtocol: false,
  // shared is TypeScript source: inline it. Everything else stays in node_modules.
  noExternal: ['@tactic/shared'],
});
