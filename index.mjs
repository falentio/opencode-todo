// Local-discovery entrypoint (OpenCode v2).
// `.opencode/plugins/` discovery resolves a package directory to its root
// index file and does not consult package.json `exports`, so a checkout
// symlinked under `.opencode/plugins/` would otherwise be skipped silently.
// Published installs are unaffected: resolvers prefer `exports`.
export { default } from "./dist/index.mjs";
