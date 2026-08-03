/**
 * Builds the Custom Wake Words webapp (src/webapp) into public/.
 *
 * IMPORTANT — public/ is shared. Signal K serves a package's `public/` dir as
 * the webapp root (see mountWebModules in the server's interfaces/webapps.ts),
 * and this package ALSO emits its Module Federation config panel there
 * (remoteEntry.js + chunks, see webpack.config.cjs). The two coexist as plain
 * static files, which only works because:
 *
 *   - `emptyOutDir: false` here, so building the webapp never deletes the
 *     panel's remoteEntry.js, and
 *   - `output.clean: false` in webpack.config.cjs, so building the panel never
 *     deletes the webapp.
 *
 * Both must stay false. Webapp assets are namespaced under `owwapp/` so a
 * chunk can never collide with a federation chunk — and because that
 * subdirectory belongs solely to this build, the plugin below can safely empty
 * it. Without that, `emptyOutDir: false` would leave every previous build's
 * hashed chunks behind to accumulate and ship in the npm package.
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

/** Clear only owwapp/, leaving the federation bundle in public/ untouched. */
function cleanWebappAssets(dir) {
  return {
    name: "clean-webapp-assets",
    apply: "build",
    buildStart() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export default defineConfig({
  root: path.resolve(import.meta.dirname, "src/webapp"),
  base: "./",
  plugins: [
    react(),
    cleanWebappAssets(path.resolve(import.meta.dirname, "public/owwapp")),
  ],
  build: {
    outDir: path.resolve(import.meta.dirname, "public"),
    emptyOutDir: false,
    assetsDir: "owwapp",
    rollupOptions: {
      output: {
        entryFileNames: "owwapp/[name]-[hash].js",
        chunkFileNames: "owwapp/[name]-[hash].js",
        assetFileNames: "owwapp/[name]-[hash][extname]",
      },
    },
  },
});
