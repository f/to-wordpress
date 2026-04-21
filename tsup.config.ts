import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.tsx"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: false,
  splitting: false,
  shims: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
  loader: {
    ".md": "text",
  },
});
