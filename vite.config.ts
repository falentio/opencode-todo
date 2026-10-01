import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {},
  lint: {
    // Type-aware linting runs `tsgolint`, a separate native process that this
    // machine's memory limit kills before it starts. `tsc --noEmit` already
    // covers the type errors it would report.
    options: { typeAware: false },
    ignorePatterns: ["node_modules/**", "dist/**", "pnpm-lock.yaml", "skills/**", "*.md"],
    rules: {
      // Both occurrences are deliberate: one matches every Unicode space
      // separator, the other detects a non-Latin closing question.
      "no-control-regex": "off",
    },
  },
  pack: {
    entry: ["src/index.ts"],
    format: ["esm"],
    platform: "node",
    target: "node22",
    outDir: "dist",
    clean: true,
    dts: true,
    // The host provides these; bundling them would duplicate the runtime the
    // plugin is loaded into and break plugin identity checks.
    deps: {
      neverBundle: [
        "@opencode/plugin",
        "@opencode/schema",
        "@opencode/client",
        "@opencode/ai",
        "effect",
      ],
    },
  },
});
