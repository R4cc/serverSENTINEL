import { constants, brotliCompress, gzip } from "node:zlib";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const backendTarget = process.env.VITE_SERVERSENTINEL_API_TARGET ?? "http://localhost:8080";
const backendWsTarget = backendTarget.replace(/^http/, "ws");

const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);

/**
 * Bundled dependencies that never change when the application does. Splitting each one out of the
 * chunk that imports it means a release only invalidates the application code: a returning visitor
 * keeps the cached copy of ECharts, xterm, and CodeMirror instead of re-downloading them, which is
 * most of the bundle. They stay behind the same lazy boundaries as before, because the chunk that
 * imports them is still only fetched when its page is.
 */
function vendorChunk(id: string) {
  if (!/[\\/]node_modules[\\/]/.test(id)) return undefined;
  if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "react-vendor";
  if (/[\\/]node_modules[\\/](echarts|zrender)[\\/]/.test(id)) return "echarts-vendor";
  // The WebGL addon is imported dynamically so a browser without WebGL never downloads it.
  // Grouping it with the rest of xterm would pull it back into the eager path.
  if (/[\\/]node_modules[\\/]@xterm[\\/](?!addon-webgl)/.test(id)) return "xterm-vendor";
  // The grammars are imported on demand, one per file type, and are most of CodeMirror's weight.
  // They have to stay outside the vendor chunk or every one of them loads with the editor again.
  // Their own split is left to Rolldown: the grammars share dependencies with each other, and a
  // forced grouping merges the shared ones back into a single download.
  if (/[\\/]node_modules[\\/](?:@codemirror[\\/](?:lang-|legacy-modes)|@lezer[\\/](?:javascript|markdown|json|yaml|html|css)[\\/])/.test(id)) {
    return undefined;
  }
  // The React wrapper stays with lazy CodeEditor; forcing it here creates an eager cycle via React.
  if (/[\\/]node_modules[\\/](@codemirror|@lezer|style-mod|w3c-keyname|crelt)[\\/]/.test(id)) {
    return "codemirror-vendor";
  }
  return undefined;
}

/** Keeps the lazy editor out of Vite's initial dependency preloads. */
function assertLazyCodeMirror(): Plugin {
  return {
    name: "serversentinel-assert-lazy-codemirror",
    apply: "build",
    enforce: "post",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        for (const [tag] of html.matchAll(/<link\b[^>]*>/g)) {
          if (!/\brel=["']modulepreload["']/.test(tag)) continue;
          const href = /\bhref=["']([^"']+)["']/.exec(tag)?.[1]?.replace(/^\//, "");
          const chunk = href ? ctx.bundle?.[href] : undefined;
          if (chunk?.type === "chunk" && Object.keys(chunk.modules).some((id) => /[\\/]node_modules[\\/](?:@codemirror|@uiw[\\/]react-codemirror)[\\/]/.test(id))) {
            throw new Error(`CodeMirror must remain lazy, but ${href} is modulepreloaded by index.html`);
          }
        }
        return html;
      }
    }
  };
}

/**
 * A chunk takes its name from the module it starts at, which for a dependency is whatever that
 * package calls its entry file — `dist`, `index.esm`, and so on. Naming those after the package
 * instead is what makes the build output, and a network panel during a slow load, readable.
 */
function chunkName(moduleIds: readonly string[]) {
  // Only a chunk that is entirely dependency code can be named after a package. A chunk holding
  // application modules keeps whatever Rolldown derived from the source tree.
  const packages = moduleIds.map((id) => /[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(id)?.[1]);
  if (packages.length === 0 || packages.some((name) => name === undefined)) return undefined;
  return packages[0]!.replace("@", "").replace(/[\\/]/g, "-");
}

/**
 * Precompresses the emitted assets so the panel serves a stored `.br`/`.gz` body instead of
 * encoding one per request. Build-time Brotli runs at maximum quality, which the request path
 * cannot afford, so the transfer is smaller *and* costs the host no CPU. `@fastify/static`
 * picks the sibling file up through `preCompressed`.
 *
 * Only text-shaped assets are worth it. Fonts and images are already compressed, and a second
 * pass over them adds files that are never smaller than the original.
 */
function precompressAssets(): Plugin {
  const compressible = /\.(?:js|mjs|css|html|json|svg|txt|webmanifest|map)$/;
  return {
    name: "serversentinel-precompress-assets",
    apply: "build",
    enforce: "post",
    async writeBundle(options, bundle) {
      const outputDirectory = options.dir ?? resolve("dist");
      const written = await Promise.all(
        Object.entries(bundle).map(async ([fileName, chunk]) => {
          if (!compressible.test(fileName)) return 0;
          const source = chunk.type === "chunk" ? chunk.code : chunk.source;
          const body = typeof source === "string" ? Buffer.from(source) : Buffer.from(source);
          // Below roughly a packet the stored copy saves nothing over encoding on the fly.
          if (body.byteLength < 1024) return 0;
          const target = resolve(outputDirectory, fileName);
          const [brotli, gzipped] = await Promise.all([
            compressBrotli(body, {
              params: {
                [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
                [constants.BROTLI_PARAM_SIZE_HINT]: body.byteLength
              }
            }),
            compressGzip(body, { level: 9 })
          ]);
          await Promise.all([
            writeFile(`${target}.br`, brotli),
            writeFile(`${target}.gz`, gzipped)
          ]);
          return 1;
        })
      );
      const count = written.reduce((total, value) => total + value, 0);
      this.info(`precompressed ${count} assets as .br and .gz`);
    }
  };
}

/**
 * The font faces are declared inside the stylesheet, so the browser cannot discover them until it
 * has downloaded and parsed 400 KiB of CSS — a full round trip after the request that would have
 * revealed them. Every weight declared here is on the first screen (body, labels, headings), so
 * announcing them in the markup lets them arrive alongside the stylesheet instead of after it,
 * which is what removes the fallback-to-Switzer swap.
 */
function preloadFonts(base: string): Plugin {
  return {
    name: "serversentinel-preload-fonts",
    apply: "build",
    enforce: "post",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const fonts = Object.keys(ctx.bundle ?? {}).filter((fileName) => fileName.endsWith(".woff2")).sort();
        return {
          html,
          tags: fonts.map((fileName) => ({
            tag: "link",
            attrs: {
              rel: "preload",
              as: "font",
              type: "font/woff2",
              href: `${base}${fileName}`,
              // Fonts are fetched in CORS mode even same-origin, and a preload whose mode does not
              // match the stylesheet's request is downloaded a second time rather than reused.
              crossorigin: ""
            },
            injectTo: "head-prepend" as const
          }))
        };
      }
    }
  };
}

export default defineConfig(({ command }) => ({
  plugins: [react(), ...(command === "build" ? [preloadFonts("/"), assertLazyCodeMirror(), precompressAssets()] : [])],
  build: {
    rollupOptions: {
      output: {
        manualChunks: vendorChunk,
        chunkFileNames(chunk) {
          const readableName = /^(?:dist|index|index\.esm|src)$/.test(chunk.name)
            ? chunkName(chunk.moduleIds) ?? chunk.name
            : chunk.name;
          return `assets/${readableName}-[hash].js`;
        }
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: backendTarget,
        // Preserve the browser-facing Vite host so the backend's same-origin
        // CSRF check can validate requests made through the development proxy.
        changeOrigin: false
      },
      "/ws": {
        target: backendWsTarget,
        changeOrigin: false,
        ws: true
      }
    }
  }
}));
