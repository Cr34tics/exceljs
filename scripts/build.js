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
// 'fs' and 'crypto' are only used in Node-specific code paths, so they can be stubbed as empty.
// 'stream' and 'events' are actively used and need real polyfills.

// Create a plugin to handle Node builtins for browser builds
const nodeBrowserPlugin = {
  name: 'node-browser-shims',
  setup(build) {
    const emptyPath = path.join(__dirname, 'empty-module.js');

    // Modules that need real browser-compatible polyfills
    const polyfilled = new Set(['stream', 'events', 'buffer']);

    // 'stream' polyfill via stream-browserify
    build.onResolve({filter: /^stream$/}, () => ({
      path: require.resolve('stream-browserify'),
    }));

    // 'events' polyfill via the events npm package
    build.onResolve({filter: /^events$/}, () => ({
      path: require.resolve('events/'),
    }));

    // 'buffer' polyfill via the buffer npm package
    build.onResolve({filter: /^buffer$/}, () => ({
      path: require.resolve('buffer/'),
    }));

    // All other Node builtins get stubbed as empty modules
    const builtins = require('module').builtinModules
      .filter(m => !m.startsWith('_') && !polyfilled.has(m));

    for (const mod of builtins) {
      // Escape special regex chars in module names (e.g. node:fs)
      const escaped = mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      build.onResolve({filter: new RegExp(`^${escaped}$`)}, () => ({
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

  // 1. Bundle lib/exceljs.browser.js -> dist/exceljs.js (with source map)
  await esbuild.build({
    ...browserBuildOptions,
    entryPoints: ['lib/exceljs.browser.js'],
    outfile: 'dist/exceljs.js',
    sourcemap: true,
  });

  // 2. Bundle lib/exceljs.bare.js -> dist/exceljs.bare.js (with source map)
  await esbuild.build({
    ...browserBuildOptions,
    entryPoints: ['lib/exceljs.bare.js'],
    outfile: 'dist/exceljs.bare.js',
    sourcemap: true,
  });

  // 3. Minified versions
  await esbuild.build({
    ...browserBuildOptions,
    entryPoints: ['lib/exceljs.browser.js'],
    outfile: 'dist/exceljs.min.js',
    sourcemap: true,
    minify: true,
  });

  await esbuild.build({
    ...browserBuildOptions,
    entryPoints: ['lib/exceljs.bare.js'],
    outfile: 'dist/exceljs.bare.min.js',
    sourcemap: true,
    minify: true,
  });

  // 4. Transpile lib/ to dist/es5/ (Node-compatible build)
  const libDir = path.resolve(__dirname, '..', 'lib');
  const es5Dir = path.join(distDir, 'es5');

  await esbuild.build({
    entryPoints: collectJsFiles(libDir),
    outdir: es5Dir,
    outbase: libDir,
    platform: 'node',
    format: 'cjs',
    sourcemap: true,
    target: ['node20'],
  });

  // Copy the nodejs entry as index.js
  const nodejsEntry = path.join(es5Dir, 'exceljs.nodejs.js');
  const indexEntry = path.join(es5Dir, 'index.js');
  if (fs.existsSync(nodejsEntry)) {
    fs.copyFileSync(nodejsEntry, indexEntry);
  }

  // Copy LICENSE to dist/
  const licenseSrc = path.resolve(__dirname, '..', 'LICENSE');
  const licenseDest = path.join(distDir, 'LICENSE');
  if (fs.existsSync(licenseSrc)) {
    fs.copyFileSync(licenseSrc, licenseDest);
  }

  // 5. Build browser spec for testing
  const specEntry = path.resolve(__dirname, '..', 'spec', 'browser', 'exceljs.spec.js');
  if (fs.existsSync(specEntry)) {
    const webDir = path.resolve(__dirname, '..', 'build', 'web');
    fs.mkdirSync(webDir, {recursive: true});
    await esbuild.build({
      entryPoints: [specEntry],
      bundle: false,
      outfile: path.join(webDir, 'exceljs.spec.js'),
      platform: 'browser',
      target: ['es2015'],
    });
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
