import { spawn, execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, access, readdir, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { glob } from "glob";
import type { ReadOperations, WriteOperations, EditOperations, BashOperations } from "@mariozechner/pi-coding-agent";
import type { GrepOperations } from "@mariozechner/pi-coding-agent";
import type { FindOperations } from "@mariozechner/pi-coding-agent";
import type { LsOperations } from "@mariozechner/pi-coding-agent";
import { filterEnv, type EnvFilterPolicy } from "./env-filter.js";

// ─── ExecutionEnvironment Interface ──────────────────────────────────────────

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number | undefined;
}

export interface GrepOptions {
  caseInsensitive?: boolean;
  globFilter?: string;
  maxResults?: number;
  literal?: boolean;
  context?: number;
}

/**
 * Unified execution environment interface per spec Section 4.1.
 * All tool operations pass through this interface, decoupling tool logic
 * from where it runs (local, Docker, K8s, SSH, WASM, etc.).
 */
export interface ExecutionEnvironment {
  // File operations
  readFile(path: string, offset?: number, limit?: number): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;
  listDirectory(path: string, depth?: number): Promise<DirEntry[]>;

  // Command execution
  execCommand(
    command: string,
    timeoutMs: number,
    workingDir?: string,
    envVars?: Record<string, string>,
  ): Promise<ExecResult>;

  // Search operations
  grep(pattern: string, path: string, options?: GrepOptions): Promise<string>;
  glob(pattern: string, path?: string): Promise<string[]>;

  // Lifecycle
  initialize(): Promise<void>;
  cleanup(): Promise<void>;

  // Metadata
  workingDirectory(): string;
  platform(): string;
  osVersion(): string;
}

// ─── LocalExecutionEnvironment ───────────────────────────────────────────────

export interface LocalExecutionEnvironmentOptions {
  cwd: string;
  envFilterPolicy?: EnvFilterPolicy;
  defaultCommandTimeoutMs?: number;
  maxCommandTimeoutMs?: number;
}

export class LocalExecutionEnvironment implements ExecutionEnvironment {
  private readonly cwd: string;
  private readonly envPolicy: EnvFilterPolicy;
  private readonly defaultTimeout: number;
  private readonly maxTimeout: number;
  private _hasRipgrep: boolean | null = null;

  constructor(opts: LocalExecutionEnvironmentOptions) {
    this.cwd = opts.cwd;
    this.envPolicy = opts.envFilterPolicy ?? "inherit_all";
    this.defaultTimeout = opts.defaultCommandTimeoutMs ?? 10_000;
    this.maxTimeout = opts.maxCommandTimeoutMs ?? 600_000;
  }

  /** Check if ripgrep is available (cached). */
  private hasRipgrep(): boolean {
    if (this._hasRipgrep === null) {
      try {
        execFileSync("rg", ["--version"], { stdio: "pipe" });
        this._hasRipgrep = true;
      } catch {
        this._hasRipgrep = false;
      }
    }
    return this._hasRipgrep;
  }

  async readFile(path: string, offset?: number, limit?: number): Promise<string> {
    const absPath = resolve(this.cwd, path);
    const buf = await readFile(absPath, "utf-8");
    const lines = buf.split("\n");

    const start = offset ? offset - 1 : 0; // 1-based to 0-based
    const end = limit ? start + limit : lines.length;
    const selected = lines.slice(start, end);

    // Format with line numbers
    return selected
      .map((line, i) => `${String(start + i + 1).padStart(4)} | ${line}`)
      .join("\n");
  }

  async writeFile(path: string, content: string): Promise<void> {
    const absPath = resolve(this.cwd, path);
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, content, "utf-8");
  }

  async fileExists(path: string): Promise<boolean> {
    try {
      await access(resolve(this.cwd, path));
      return true;
    } catch {
      return false;
    }
  }

  async listDirectory(path: string, _depth?: number): Promise<DirEntry[]> {
    const absPath = resolve(this.cwd, path);
    const entries = await readdir(absPath, { withFileTypes: true });
    const results: DirEntry[] = [];
    for (const entry of entries) {
      let size: number | undefined;
      if (!entry.isDirectory()) {
        try {
          const s = await stat(resolve(absPath, entry.name));
          size = s.size;
        } catch { /* ignore */ }
      }
      results.push({
        name: entry.name,
        isDir: entry.isDirectory(),
        size,
      });
    }
    return results;
  }

  async execCommand(
    command: string,
    timeoutMs: number,
    workingDir?: string,
    envVars?: Record<string, string>,
  ): Promise<ExecResult> {
    const effectiveTimeout = Math.min(
      timeoutMs || this.defaultTimeout,
      this.maxTimeout,
    );
    const effectiveCwd = workingDir ? resolve(this.cwd, workingDir) : this.cwd;
    const filteredEnv = filterEnv(process.env, this.envPolicy);
    const env = envVars ? { ...filteredEnv, ...envVars } : filteredEnv;

    const startTime = Date.now();

    return new Promise<ExecResult>((resolvePromise) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let totalBytes = 0;
      const maxBuffer = 10 * 1024 * 1024; // 10MB
      let settled = false;
      let timedOut = false;

      // Spawn in a new process group for clean killability
      const child = spawn("/bin/bash", ["-c", command], {
        cwd: effectiveCwd,
        env: env as NodeJS.ProcessEnv,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });

      child.stdout?.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes <= maxBuffer) stdoutChunks.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes <= maxBuffer) stderrChunks.push(chunk);
      });

      // Timeout handler: SIGTERM → 2s grace → SIGKILL
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        if (child.pid) {
          try {
            // Send SIGTERM to the process group
            process.kill(-child.pid, "SIGTERM");
          } catch { /* process may already be gone */ }

          // After 2 seconds, escalate to SIGKILL
          setTimeout(() => {
            try {
              process.kill(-child.pid!, "SIGKILL");
            } catch { /* process may already be gone */ }
          }, 2000);
        }
      }, effectiveTimeout);

      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);

        const durationMs = Date.now() - startTime;
        let stdoutStr = Buffer.concat(stdoutChunks).toString("utf-8");
        let stderrStr = Buffer.concat(stderrChunks).toString("utf-8");

        if (timedOut) {
          stderrStr += `\n[ERROR: Command timed out after ${effectiveTimeout}ms. Partial output is shown above. You can retry with a longer timeout by setting the timeout_ms parameter.]`;
        }

        resolvePromise({
          stdout: stdoutStr,
          stderr: stderrStr,
          exitCode: exitCode ?? 1,
          timedOut,
          durationMs,
        });
      };

      child.on("close", (code) => finish(code));
      child.on("error", () => finish(1));
    });
  }

  async grep(
    pattern: string,
    path: string,
    options?: GrepOptions,
  ): Promise<string> {
    const absPath = resolve(this.cwd, path);

    // Prefer ripgrep if available (respects .gitignore, faster)
    if (this.hasRipgrep()) {
      const args = ["-n"]; // line numbers
      if (options?.caseInsensitive) args.push("-i");
      if (options?.literal) args.push("-F");
      if (options?.context) args.push(`-C`, String(options.context));
      if (options?.globFilter) args.push(`--glob`, options.globFilter);
      if (options?.maxResults) args.push(`-m`, String(options.maxResults));
      args.push("--", pattern, absPath);

      try {
        const result = await this.execCommand(
          `rg ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`,
          this.defaultTimeout,
        );
        return result.stdout;
      } catch {
        return "";
      }
    }

    // Fallback to GNU grep
    const args = ["-rn"];
    if (options?.caseInsensitive) args.push("-i");
    if (options?.literal) args.push("-F");
    if (options?.context) args.push(`-C${options.context}`);
    if (options?.globFilter) args.push(`--include=${options.globFilter}`);
    if (options?.maxResults) args.push(`-m${options.maxResults}`);
    args.push(pattern, absPath);

    try {
      const result = await this.execCommand(
        `grep ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`,
        this.defaultTimeout,
      );
      return result.stdout;
    } catch {
      return "";
    }
  }

  async glob(pattern: string, basePath?: string): Promise<string[]> {
    const cwd = basePath ? resolve(this.cwd, basePath) : this.cwd;
    return glob(pattern, { cwd, absolute: true });
  }

  async initialize(): Promise<void> {
    // Ensure working directory exists
    await mkdir(this.cwd, { recursive: true });
  }

  async cleanup(): Promise<void> {
    // No-op for local env
  }

  workingDirectory(): string {
    return this.cwd;
  }

  platform(): string {
    return process.platform;
  }

  osVersion(): string {
    try {
      const { execSync } = require("node:child_process");
      return (execSync("uname -r", { encoding: "utf-8" }) as string).trim();
    } catch {
      return process.platform;
    }
  }
}

// ─── Operations Adapters ─────────────────────────────────────────────────────

/**
 * Create pi-mono ReadOperations from an ExecutionEnvironment.
 */
export function createReadOperations(env: ExecutionEnvironment): ReadOperations {
  return {
    readFile: async (absolutePath: string): Promise<Buffer> => {
      const content = await env.readFile(absolutePath);
      return Buffer.from(content, "utf-8");
    },
    access: async (absolutePath: string): Promise<void> => {
      const exists = await env.fileExists(absolutePath);
      if (!exists) throw new Error(`ENOENT: no such file or directory: ${absolutePath}`);
    },
  };
}

/**
 * Create pi-mono WriteOperations from an ExecutionEnvironment.
 */
export function createWriteOperations(env: ExecutionEnvironment): WriteOperations {
  return {
    writeFile: async (absolutePath: string, content: string): Promise<void> => {
      await env.writeFile(absolutePath, content);
    },
    mkdir: async (dir: string): Promise<void> => {
      await mkdir(dir, { recursive: true });
    },
  };
}

/**
 * Create pi-mono EditOperations from an ExecutionEnvironment.
 * EditOperations: { readFile, writeFile, access } (no mkdir)
 */
export function createEditOperations(env: ExecutionEnvironment): EditOperations {
  return {
    readFile: async (absolutePath: string): Promise<Buffer> => {
      const content = await env.readFile(absolutePath);
      return Buffer.from(content, "utf-8");
    },
    access: async (absolutePath: string): Promise<void> => {
      const exists = await env.fileExists(absolutePath);
      if (!exists) throw new Error(`ENOENT: no such file or directory: ${absolutePath}`);
    },
    writeFile: async (absolutePath: string, content: string): Promise<void> => {
      await env.writeFile(absolutePath, content);
    },
  };
}

/**
 * Create pi-mono BashOperations from an ExecutionEnvironment.
 */
export function createBashOperations(env: ExecutionEnvironment): BashOperations {
  return {
    exec: async (
      command: string,
      cwd: string,
      options: {
        onData: (data: Buffer) => void;
        signal?: AbortSignal;
        timeout?: number;
        env?: NodeJS.ProcessEnv;
      },
    ): Promise<{ exitCode: number | null }> => {
      const timeout = options.timeout ?? 10_000;
      const result = await env.execCommand(
        command,
        timeout,
        cwd,
        options.env as Record<string, string> | undefined,
      );
      // Deliver output via onData callback
      if (result.stdout) options.onData(Buffer.from(result.stdout));
      if (result.stderr) options.onData(Buffer.from(result.stderr));
      return { exitCode: result.exitCode };
    },
  };
}

/**
 * Create pi-mono GrepOperations from an ExecutionEnvironment.
 * GrepOperations: { isDirectory, readFile (returns string) }
 */
export function createGrepOperations(env: ExecutionEnvironment): GrepOperations {
  return {
    isDirectory: async (absolutePath: string): Promise<boolean> => {
      const entries = await env.listDirectory(dirname(absolutePath));
      const name = absolutePath.split("/").pop()!;
      const entry = entries.find((e) => e.name === name);
      return entry?.isDir ?? false;
    },
    readFile: async (absolutePath: string): Promise<string> => {
      return env.readFile(absolutePath);
    },
  };
}

/**
 * Create pi-mono FindOperations from an ExecutionEnvironment.
 * FindOperations: { exists, glob }
 */
export function createFindOperations(env: ExecutionEnvironment): FindOperations {
  return {
    exists: async (absolutePath: string): Promise<boolean> => {
      return env.fileExists(absolutePath);
    },
    glob: async (
      pattern: string,
      cwd: string,
      options: { ignore: string[]; limit: number },
    ): Promise<string[]> => {
      const results = await env.glob(pattern, cwd);
      return results.slice(0, options.limit);
    },
  };
}

/**
 * Create pi-mono LsOperations from an ExecutionEnvironment.
 * LsOperations: { exists, stat, readdir }
 */
export function createLsOperations(env: ExecutionEnvironment): LsOperations {
  return {
    exists: async (absolutePath: string): Promise<boolean> => {
      return env.fileExists(absolutePath);
    },
    readdir: async (absolutePath: string): Promise<string[]> => {
      const entries = await env.listDirectory(absolutePath);
      return entries.map((e) => e.name);
    },
    stat: async (absolutePath: string): Promise<{ isDirectory: () => boolean }> => {
      const entries = await env.listDirectory(dirname(absolutePath));
      const name = absolutePath.split("/").pop()!;
      const entry = entries.find((e) => e.name === name);
      return {
        isDirectory: () => entry?.isDir ?? false,
      };
    },
  };
}
