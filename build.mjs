import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { posix } from 'node:path';

const require = createRequire(import.meta.url);
let esbuild;
try {
  esbuild = require('esbuild');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
  esbuild = createRequire(require.resolve('vite'))('esbuild');
}
const { build } = esbuild;
const relative = (path) => new URL(path, import.meta.url);
const localModules = {
  name: 'xps-source',
  setup(builder) {
    builder.onResolve({ filter: /^jszip$/ }, () => ({
      namespace: 'xps-vendor',
      path: require.resolve('jszip/dist/jszip.min.js'),
    }));
    builder.onLoad({ filter: /.*/, namespace: 'xps-vendor' }, async ({ path }) => ({
      contents: await readFile(path, 'utf-8'),
      loader: 'js',
    }));
    builder.onResolve({ filter: /.*/ }, ({ importer, path }) => ({
      namespace: 'xps-source',
      path: posix.join(posix.dirname(importer), path),
    }));
    builder.onLoad({ filter: /\.js$/, namespace: 'xps-source' }, async ({ path }) => ({
      contents: await readFile(relative(path), 'utf-8'),
      loader: 'js',
    }));
  },
};
const buildOptions = {
  bundle: true,
  format: 'esm',
  target: ['safari16.4', 'chrome110', 'firefox115'],
  write: false,
  plugins: [localModules],
};
const { outputFiles: [worker] } = await build({ ...buildOptions, entryPoints: ['src/fit-worker.js'] });
const { outputFiles: [app] } = await build({
  ...buildOptions,
  entryPoints: ['src/app.js'],
  define: { __XPS_WORKER_SOURCE__: JSON.stringify(worker.text) },
});
const [html, css, numberCss, favicon, manifest] = await Promise.all([
  readFile(relative('index.html'), 'utf-8'),
  readFile(relative('style.css'), 'utf-8'),
  readFile(relative('number-input.css'), 'utf-8'),
  readFile(relative('favicon.svg'), 'utf-8'),
  readFile(relative('package.json'), 'utf-8'),
]);
const { version } = JSON.parse(manifest);
if (!/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(version)) {
  throw new Error('package.json must include an XPS Workbench release version in MAJOR.MINOR.PATCH form.');
}
const buildId = createHash('sha256')
  .update(JSON.stringify([version, html, css, numberCss, favicon, app.text]))
  .digest('hex').slice(0, 12);
const release = JSON.stringify({ version, build: buildId }) + '\n';
const result = html
  .replace('__XPS_VERSION__', version)
  .replace('__XPS_BUILD__', buildId)
  .replace('href="./favicon.svg"', () => `href="data:image/svg+xml,${encodeURIComponent(favicon)}"`)
  .replace('<link rel="stylesheet" href="./style.css">', () => `<style>\n${css}</style>`)
  .replace('<link rel="stylesheet" href="./number-input.css">', () => `<style>\n${numberCss}</style>`)
  .replace('<script type="module" src="./src/app.js"></script>', () =>
    `<script type="module">\n${app.text.replace(/<\/script/gi, '<\\/script')}</script>`);
await mkdir(relative('dist'), { recursive: true });
await writeFile(relative('dist/XPS-Workbench.html'), result);
if (process.argv.includes('--pages')) {
  await mkdir(relative('docs'), { recursive: true });
  await Promise.all([
    writeFile(relative('docs/index.html'), result),
    writeFile(relative('docs/.nojekyll'), ''),
    writeFile(relative('docs/version.json'), release),
  ]);
}
