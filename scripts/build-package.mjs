import { builtinModules } from "node:module";

import { build } from "esbuild";

const external = builtinModules.flatMap((name) => [name, `node:${name}`]);

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  legalComments: "none",
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);'
  },
  external
});
