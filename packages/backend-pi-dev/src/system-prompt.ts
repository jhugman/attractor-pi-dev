import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export interface EnvironmentContext {
  workingDirectory: string;
  platform: string;
  osVersion: string;
  date: string;
  modelName: string;
  knowledgeCutoff?: string;
  isGitRepo: boolean;
  gitBranch?: string;
  gitStatus?: string;
  recentCommits?: string;
}

/**
 * Gather environment context at session start.
 */
export function gatherEnvironmentContext(
  cwd: string,
  modelName: string,
  knowledgeCutoff?: string,
): EnvironmentContext {
  const platform = process.platform;
  let osVersion = "";
  try {
    osVersion = execSync("uname -r", { encoding: "utf-8" }).trim();
  } catch {
    osVersion = platform;
  }

  const date = new Date().toISOString().split("T")[0]!;

  // Git info
  let isGitRepo = false;
  let gitBranch: string | undefined;
  let gitStatus: string | undefined;
  let recentCommits: string | undefined;

  try {
    const gitRoot = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    isGitRepo = existsSync(join(gitRoot, ".git"));

    if (isGitRepo) {
      gitBranch = execSync("git branch --show-current", {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();

      // Short status: just counts
      const statusOutput = execSync("git status --porcelain", {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (statusOutput) {
        const lines = statusOutput.split("\n");
        const modified = lines.filter((l) => l.startsWith(" M") || l.startsWith("M ")).length;
        const untracked = lines.filter((l) => l.startsWith("??")).length;
        const parts: string[] = [];
        if (modified > 0) parts.push(`${modified} modified`);
        if (untracked > 0) parts.push(`${untracked} untracked`);
        gitStatus = parts.join(", ");
      }

      recentCommits = execSync("git log --oneline -5", {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    }
  } catch {
    // Not a git repo or git not available
  }

  return {
    workingDirectory: cwd,
    platform,
    osVersion,
    date,
    modelName,
    knowledgeCutoff,
    isGitRepo,
    gitBranch,
    gitStatus,
    recentCommits,
  };
}

/**
 * Format environment context into a structured block for the system prompt.
 */
export function formatEnvironmentContext(ctx: EnvironmentContext): string {
  const lines = [
    "<environment>",
    `Working directory: ${ctx.workingDirectory}`,
    `Is git repository: ${ctx.isGitRepo}`,
  ];

  if (ctx.gitBranch) lines.push(`Git branch: ${ctx.gitBranch}`);
  if (ctx.gitStatus) lines.push(`Git status: ${ctx.gitStatus}`);
  if (ctx.recentCommits) {
    lines.push(`Recent commits:`);
    lines.push(ctx.recentCommits);
  }

  lines.push(`Platform: ${ctx.platform}`);
  lines.push(`OS version: ${ctx.osVersion}`);
  lines.push(`Today's date: ${ctx.date}`);
  lines.push(`Model: ${ctx.modelName}`);

  if (ctx.knowledgeCutoff) {
    lines.push(`Knowledge cutoff: ${ctx.knowledgeCutoff}`);
  }

  lines.push("</environment>");
  return lines.join("\n");
}

export interface SystemPromptOptions {
  /** Provider-specific base instructions */
  baseInstructions?: string;
  /** Working directory */
  cwd: string;
  /** Model display name */
  modelName: string;
  /** Knowledge cutoff date */
  knowledgeCutoff?: string;
  /** User instruction overrides (appended last, highest priority) */
  userInstructions?: string;
  /** Active tool names */
  selectedTools?: string[];
  /** Context files (AGENTS.md, CLAUDE.md, etc.) */
  contextFiles?: Array<{ path: string; content: string }>;
}

/**
 * Build the full system prompt by layering:
 * 1. Provider-specific base instructions (from ProviderProfile)
 * 2. Environment context (platform, git, working dir, date, model info)
 * 3. Project-specific instructions (AGENTS.md, CLAUDE.md, etc.)
 * 4. User instructions override (appended last, highest priority)
 *
 * Note: pi-mono's AgentSession rebuilds its own system prompt internally
 * with tool descriptions. This function builds the custom prompt + env
 * context that gets passed to the session's system prompt.
 */
export function buildFullSystemPrompt(opts: SystemPromptOptions): string {
  const parts: string[] = [];

  // 1. Provider-specific base instructions
  if (opts.baseInstructions) {
    parts.push(opts.baseInstructions);
  }

  // 2. Environment context
  const envCtx = gatherEnvironmentContext(
    opts.cwd,
    opts.modelName,
    opts.knowledgeCutoff,
  );
  parts.push(formatEnvironmentContext(envCtx));

  // 3. Project-specific instructions
  if (opts.contextFiles && opts.contextFiles.length > 0) {
    parts.push("# Project Context\n");
    for (const { path: filePath, content } of opts.contextFiles) {
      parts.push(`## ${filePath}\n\n${content}`);
    }
  }

  // 4. User instructions (highest priority)
  if (opts.userInstructions) {
    parts.push(opts.userInstructions);
  }

  return parts.join("\n\n");
}

// ─── Project Document Discovery (spec Section 6.5) ───────────────────────────

const PROJECT_DOC_BUDGET = 32 * 1024; // 32KB

/**
 * Discover project documentation files by walking from git root to cwd.
 * Root-level files are loaded first; subdirectory files are appended
 * (deeper = higher precedence). Respects a 32KB total budget.
 *
 * @param cwd - Current working directory
 * @param patterns - File patterns to look for (e.g. ["AGENTS.md", "CLAUDE.md"])
 * @returns Array of {path, content} for discovered files
 */
export async function discoverProjectDocs(
  cwd: string,
  patterns: string[],
): Promise<Array<{ path: string; content: string }>> {
  if (!patterns || patterns.length === 0) return [];

  // Find git root (or fall back to cwd)
  let root = cwd;
  try {
    root = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    // Not a git repo, use cwd as root
  }

  // Build list of directories from root to cwd
  const dirs: string[] = [root];
  if (root !== cwd) {
    const rel = relative(root, cwd);
    const segments = rel.split(sep);
    let current = root;
    for (const seg of segments) {
      current = join(current, seg);
      if (current !== root) {
        dirs.push(current);
      }
    }
  }

  // Walk directories and collect matching files
  const results: Array<{ path: string; content: string }> = [];
  let totalBytes = 0;

  for (const dir of dirs) {
    for (const pattern of patterns) {
      const filePath = join(dir, pattern);
      if (!existsSync(filePath)) continue;

      try {
        let content = readFileSync(filePath, "utf-8");
        const remaining = PROJECT_DOC_BUDGET - totalBytes;
        if (remaining <= 0) {
          // Budget exhausted
          return results;
        }
        if (content.length > remaining) {
          content = content.slice(0, remaining) + "\n[Project instructions truncated at 32KB]";
        }
        totalBytes += content.length;
        results.push({ path: relative(root, filePath), content });
      } catch {
        // Skip unreadable files
      }
    }
  }

  return results;
}
