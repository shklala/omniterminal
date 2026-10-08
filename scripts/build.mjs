// Bundles the Node-side entry points (Electron main, preload, session manager) with esbuild.
// The renderer is built by Vite.
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
  // Only the native PTY module stays external (asar-unpacked); everything else is bundled.
  external: ['electron', 'node-pty'],
};

const builds = [
  { ...common, entryPoints: { main: 'src/main/main.ts' }, outdir: 'dist' },
  { ...common, entryPoints: { preload: 'src/main/preload.ts' }, outdir: 'dist' },
  { ...common, entryPoints: { daemon: 'src/daemon/main.ts' }, outdir: 'dist' },
];

if (watch) {
  for (const b of builds) (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
