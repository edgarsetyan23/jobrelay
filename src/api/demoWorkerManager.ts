// Manages the isolated pool of "demo" worker child processes. This is what
// makes the "Stop this worker" control safe: the API can only ever kill a
// process it spawned right here, and every such process is launched with
// WORKER_KIND=demo -- meaning it only ever pulls jobs off the demo queue,
// never the main queue a normal visitor's upload goes through. There is no
// general process-control surface exposed anywhere else.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "../logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TSX_CLI = join(__dirname, "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
const WORKER_SCRIPT = join(__dirname, "..", "worker", "worker.ts");

interface DemoWorkerHandle {
  id: string;
  child: ChildProcess;
}

export interface DemoWorkerManagerOptions {
  count: number;
  logger: Logger;
  env: NodeJS.ProcessEnv;
  respawnDelayMs?: number;
}

export class DemoWorkerManager {
  private readonly workers = new Map<string, DemoWorkerHandle>();
  private stopping = false;

  constructor(private readonly opts: DemoWorkerManagerOptions) {}

  start(): void {
    for (let i = 0; i < this.opts.count; i++) this.spawnOne();
  }

  ids(): string[] {
    return [...this.workers.keys()];
  }

  isDemoWorker(id: string): boolean {
    return this.workers.has(id);
  }

  /** Hard-kills one demo worker process -- exactly like `kill -9` on a real crash, no graceful shutdown hook runs. Returns false if `id` isn't a currently-tracked demo worker. */
  stop(id: string): boolean {
    const handle = this.workers.get(id);
    if (!handle) return false;
    handle.child.kill("SIGKILL");
    return true;
  }

  /** Called on API shutdown so demo workers don't outlive it as orphans. */
  stopAll(): void {
    this.stopping = true;
    for (const handle of this.workers.values()) handle.child.kill("SIGKILL");
  }

  private spawnOne(): void {
    const id = `demo-${randomUUID().slice(0, 8)}`;
    const child = spawn(process.execPath, [TSX_CLI, WORKER_SCRIPT], {
      env: { ...this.opts.env, WORKER_KIND: "demo", WORKER_ID_OVERRIDE: id },
      stdio: "inherit",
    });
    this.workers.set(id, { id, child });

    child.on("exit", (code, signal) => {
      this.opts.logger.info({ workerId: id, code, signal }, "demo worker process exited");
      this.workers.delete(id);
      if (this.stopping) return;
      // Keep the demo pool at full strength so the demonstration can be run
      // repeatedly -- respawn a replacement shortly after any exit.
      const timer = setTimeout(() => this.spawnOne(), this.opts.respawnDelayMs ?? 3000);
      timer.unref();
    });
  }
}
