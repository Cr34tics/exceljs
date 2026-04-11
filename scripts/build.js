'use strict';

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const distDir = path.resolve(__dirname, '..', 'dist');

// Ensure dist directory exists
fs.mkdirSync(distDir, {recursive: true});

const today = new Date();
const dd = String(today.getDate()).padStart(2, '0');
const mm = String(today.getMonth() + 1).padStart(2, '0');
const yyyy = today.getFullYear();
const banner = `/*! ExcelJS ${dd}-${mm}-${yyyy} */`;

// Node built-in modules that need to be shimmed for browser builds.
// 'stream', 'events', 'buffer', 'crypto', and 'process' get real browser-compatible polyfills.
// All other Node builtins (e.g., 'fs') are stubbed as empty modules.

// Create a plugin to handle Node builtins for browser builds
const nodeBrowserPlugin = {
  name: 'node-browser-shims',
  setup(build) {
    const emptyPath = path.join(__dirname, 'empty-module.js');

    // Modules that need real browser-compatible polyfills (both bare and node:-prefixed)
    const polyfilled = new Set(['stream', 'events', 'buffer', 'crypto', 'process']);

    const polyfilledResolvers = {
      stream: () => require.resolve('stream-browserify'),
      // Trailing slash forces resolution to the npm package, not the Node built-in
      events: () => require.resolve('events/'),
      buffer: () => require.resolve('buffer/'),
      crypto: () => path.join(__dirname, 'shims', 'crypto-shim.js'),
      process: () => path.join(__dirname, 'shims', 'process-shim.js'),
    };

    // Register resolvers for both bare and node:-prefixed imports
    for (const [mod, resolver] of Object.entries(polyfilledResolvers)) {
      const escaped = mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      build.onResolve({filter: new RegExp(`^(node:)?${escaped}$`)}, () => ({
        path: resolver(),
      }));
    }

    // All other Node builtins get stubbed as empty modules
    const builtins = require('module').builtinModules
      .filter(m => !m.startsWith('_') && !m.startsWith('node:') && !polyfilled.has(m));

    for (const mod of builtins) {
      // Handle both bare and node:-prefixed imports
      const escaped = mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      build.onResolve({filter: new RegExp(`^(node:)?${escaped}$`)}, () => ({
        path: emptyPath,
      }));
    }
  },
};

const browserBuildOptions = {
  bundle: true,
  platform: 'browser',
  globalName: 'ExcelJS',
  banner: {js: banner},
  // UMD-compatible footer: allows the bundle to work with CommonJS require()
  // in addition to the browser global (var ExcelJS = ...)
  footer: {js: 'if(typeof module!=="undefined")module.exports=ExcelJS;'},
  target: ['es2015'],
  plugins: [nodeBrowserPlugin],
  // Inject process and Buffer shims so they are available as globals in the browser bundle
  inject: [
    path.join(__dirname, 'shims', 'process-shim.js'),
    path.join(__dirname, 'shims', 'buffer-shim.js'),
  ],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
};

async function build() {
  // Ensure the empty module shim exists
  const emptyModulePath = path.join(__dirname, 'empty-module.js');
  if (!fs.existsSync(emptyModulePath)) {
    fs.writeFileSync(emptyModulePath, 'module.exports = {};\n');
  }

  const repoRoot = path.resolve(__dirname, '..');

  // 1. Bundle lib/exceljs.browser.js -> dist/exceljs.js (with source map)
  await esbuild.build({
    ...browserBuildOptions,
    entryPoints: [path.join(repoRoot, 'lib', 'exceljs.browser.js')],
    outfile: path.join(distDir, 'exceljs.js'),
    sourcemap: true,
  });

  // 2. Bundle lib/exceljs.bare.js -> dist/exceljs.bare.js (with source map)
  await esbuild.build({
    ...browserBuildOptions,
    entryPoints: [path.join(repoRoot, 'lib', 'exceljs.bare.js')],
    outfile: path.join(distDir, 'exceljs.bare.js'),
    sourcemap: true,
  });

  // 3. Minified versions
  await esbuild.build({
    ...browserBuildOptions,
    entryPoints: [path.join(repoRoot, 'lib', 'exceljs.browser.js')],
    outfile: path.join(distDir, 'exceljs.min.js'),
    sourcemap: true,
    minify: true,
  });

  await esbuild.build({
    ...browserBuildOptions,
    entryPoints: [path.join(repoRoot, 'lib', 'exceljs.bare.js')],
    outfile: path.join(distDir, 'exceljs.bare.min.js'),
    sourcemap: true,
    minify: true,
  });

  // 4. Transpile lib/ to dist/cjs/ (Node 20+ CJS build)
  const libDir = path.resolve(__dirname, '..', 'lib');
  const cjsDir = path.join(distDir, 'cjs');

  await esbuild.build({
    entryPoints: collectJsFiles(libDir),
    outdir: cjsDir,
    outbase: libDir,
    platform: 'node',
    format: 'cjs',
    sourcemap: true,
    target: ['node20'],
  });

  // Copy the nodejs entry as index.js
  const nodejsEntry = path.join(cjsDir, 'exceljs.nodejs.js');
  const indexEntry = path.join(cjsDir, 'index.js');
  if (fs.existsSync(nodejsEntry)) {
    fs.copyFileSync(nodejsEntry, indexEntry);
  }

  // Copy LICENSE to dist/
  const licenseSrc = path.resolve(__dirname, '..', 'LICENSE');
  const licenseDest = path.join(distDir, 'LICENSE');
  if (fs.existsSync(licenseSrc)) {
    fs.copyFileSync(licenseSrc, licenseDest);
  }

  console.log('Build complete.');
}

function collectJsFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJsFiles(fullPath));
    } else if (entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

build().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
