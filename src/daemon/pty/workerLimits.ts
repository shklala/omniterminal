// node-pty starts one worker thread per terminal (lib/worker/conoutSocketWorker.js) whose only job is
// to copy the ConPTY output pipe to a socket off the main thread (avoids a known ClosePseudoConsole
// deadlock). V8 gives every worker default heap sizing, which costs ~17 MB per terminal for a script
// that just moves bytes. This wraps worker_threads.Worker so *that* worker gets tight limits.
// Must be imported before node-pty creates any terminal.
import type * as WorkerThreadsModule from 'node:worker_threads';

// The real module object (an `import * as` namespace would be a bundler-made copy).
const workerThreads = process.getBuiltinModule('node:worker_threads') as typeof WorkerThreadsModule;
const OriginalWorker = workerThreads.Worker;

class LeanConoutWorker extends OriginalWorker {
  constructor(filename: string | URL, options: WorkerThreadsModule.WorkerOptions = {}) {
    const isConout = String(filename).replace(/\\/g, '/').endsWith('/worker/conoutSocketWorker.js');
    super(
      filename,
      isConout
        ? {
            ...options,
            resourceLimits: { maxYoungGenerationSizeMb: 1, maxOldGenerationSizeMb: 12, codeRangeSizeMb: 2, stackSizeMb: 1, ...options.resourceLimits },
            // The pipe copier needs no environment or V8 flags of its own.
            env: {},
            execArgv: [],
          }
        : options,
    );
  }
}

// node-pty reads `require("worker_threads").Worker` at construction time, so replacing the export works.
(workerThreads as { Worker: typeof OriginalWorker }).Worker = LeanConoutWorker;
