import { getModel, type Model, type Api } from "@mariozechner/pi-ai";
import type { AgentTool, ThinkingLevel } from "@mariozechner/pi-agent-core";
import {
  createReadTool,
  createWriteTool,
  createEditTool,
  createBashTool,
  createGrepTool,
  createFindTool,
  createLsTool,
} from "@mariozechner/pi-coding-agent";
import {
  LocalExecutionEnvironment,
  type ExecutionEnvironment,
  createReadOperations,
  createWriteOperations,
  createBashOperations,
  createGrepOperations,
  createFindOperations,
  createLsOperations,
} from "./execution-env.js";
import { createApplyPatchTool } from "./tools/apply-patch.js";

// Helper to cast specific AgentTool<T> to the base AgentTool type.
// pi-mono's AgentTool generic is contravariant in params but we know
// the concrete tools are safe to use in a collection.
function asToolArray(...tools: AgentTool<any>[]): AgentTool[] {
  return tools as AgentTool[];
}

// ─── Tool Output Truncation Defaults (per spec Section 5.2) ─────────────────

export interface TruncationDefaults {
  /** Max characters per tool output */
  charLimits: Record<string, number>;
  /** Max lines per tool output */
  lineLimits: Record<string, number>;
  /** Truncation mode per tool */
  modes: Record<string, "head_tail" | "tail">;
}

const DEFAULT_TRUNCATION: TruncationDefaults = {
  charLimits: {
    read_file: 50_000,
    shell: 30_000,
    bash: 30_000,
    grep: 20_000,
    glob: 20_000,
    find: 20_000,
    edit_file: 10_000,
    edit: 10_000,
    apply_patch: 10_000,
    write_file: 1_000,
    write: 1_000,
    spawn_agent: 20_000,
  },
  lineLimits: {
    shell: 256,
    bash: 256,
    grep: 200,
    glob: 500,
    find: 500,
    ls: 500,
  },
  modes: {
    read_file: "head_tail",
    read: "head_tail",
    shell: "head_tail",
    bash: "head_tail",
    grep: "tail",
    glob: "tail",
    find: "tail",
    ls: "tail",
    edit_file: "tail",
    edit: "tail",
    apply_patch: "tail",
    write_file: "tail",
    write: "tail",
    spawn_agent: "head_tail",
  },
};

// ─── ProviderProfile Interface ───────────────────────────────────────────────

export interface ProviderProfile {
  /** Provider identifier: "anthropic", "openai", "gemini" */
  id: string;
  /** The pi-ai Model object */
  model: Model<Api>;
  /** All tools available to this profile */
  tools: AgentTool[];
  /** Tool names (for buildSystemPrompt selectedTools) */
  toolNames: string[];
  /** Default thinking level */
  defaultThinkingLevel: ThinkingLevel;
  /** Default command timeout in ms */
  defaultCommandTimeoutMs: number;
  /** Whether this profile supports parallel tool calls */
  supportsParallelToolCalls: boolean;
  /** Whether this profile supports reasoning/thinking */
  supportsReasoning: boolean;
  /** Context window size in tokens */
  contextWindowSize: number;
  /** Truncation defaults for this profile */
  truncation: TruncationDefaults;
  /** Base system prompt instructions specific to this provider */
  baseInstructions: string;
  /** Provider-specific options to pass through */
  providerOptions?: Record<string, unknown>;
  /** Project doc file patterns to discover (e.g. ["AGENTS.md", "CLAUDE.md"]) */
  projectDocPatterns: string[];
}

// ─── Profile Options ─────────────────────────────────────────────────────────

export interface CreateProfileOptions {
  /** Override the model (provider + modelId) */
  provider?: string;
  modelId?: string;
  /** Override thinking level */
  thinkingLevel?: ThinkingLevel;
  /** Working directory */
  cwd: string;
  /** Execution environment (for operations adapters) */
  executionEnv?: ExecutionEnvironment;
  /** Additional custom tools to register */
  customTools?: AgentTool[];
  /** Override truncation defaults */
  truncationOverrides?: Partial<TruncationDefaults>;
  /** Extra base instructions to prepend */
  extraInstructions?: string;
}

// ─── Anthropic Profile ───────────────────────────────────────────────────────

const ANTHROPIC_BASE_INSTRUCTIONS = `You are an AI coding assistant. You help users with software engineering tasks including solving bugs, adding functionality, refactoring code, and explaining code.

Key guidelines:
- Read files before modifying them. Understand existing code before suggesting modifications.
- Use edit_file with old_string/new_string for precise edits. The old_string must be unique in the file.
- Prefer editing existing files over creating new ones to prevent file bloat.
- Use the shell tool for running commands, tests, and builds.
- Use grep and glob to search the codebase before making changes.
- Keep changes focused and minimal. Only make changes that are directly requested.
- Write safe, secure code. Avoid introducing security vulnerabilities.`;

export function createAnthropicProfile(opts: CreateProfileOptions): ProviderProfile {
  const provider = opts.provider ?? "anthropic";
  const modelId = opts.modelId ?? "claude-sonnet-4-5-20250929";

  let model: Model<Api>;
  try {
    model = getModel(provider as any, modelId as any);
  } catch {
    model = getModel("anthropic" as any, "claude-sonnet-4-5-20250929" as any);
  }

  // Create tools, optionally with ExecutionEnvironment-backed operations
  let tools: AgentTool[];
  if (opts.executionEnv) {
    const env = opts.executionEnv;
    tools = asToolArray(
      createReadTool(opts.cwd, { operations: createReadOperations(env) }),
      createWriteTool(opts.cwd, { operations: createWriteOperations(env) }),
      createEditTool(opts.cwd),
      createBashTool(opts.cwd, { operations: createBashOperations(env) }),
      createGrepTool(opts.cwd, { operations: createGrepOperations(env) }),
      createFindTool(opts.cwd, { operations: createFindOperations(env) }),
      createLsTool(opts.cwd, { operations: createLsOperations(env) }),
    );
  } else {
    tools = asToolArray(
      createReadTool(opts.cwd),
      createWriteTool(opts.cwd),
      createEditTool(opts.cwd),
      createBashTool(opts.cwd),
      createGrepTool(opts.cwd),
      createFindTool(opts.cwd),
      createLsTool(opts.cwd),
    );
  }

  // Add custom tools (latest-wins for name collisions)
  if (opts.customTools) {
    for (const custom of opts.customTools) {
      const idx = tools.findIndex((t) => t.name === custom.name);
      if (idx >= 0) {
        tools[idx] = custom;
      } else {
        tools.push(custom);
      }
    }
  }

  const truncation = mergeTruncation(DEFAULT_TRUNCATION, opts.truncationOverrides);

  const baseInstructions = opts.extraInstructions
    ? opts.extraInstructions + "\n\n" + ANTHROPIC_BASE_INSTRUCTIONS
    : ANTHROPIC_BASE_INSTRUCTIONS;

  return {
    id: "anthropic",
    model,
    tools,
    toolNames: tools.map((t) => t.name),
    defaultThinkingLevel: opts.thinkingLevel ?? "high",
    defaultCommandTimeoutMs: 120_000, // Claude Code convention: 120s
    supportsParallelToolCalls: true,
    supportsReasoning: true,
    contextWindowSize: model.contextWindow,
    truncation,
    baseInstructions,
    projectDocPatterns: ["AGENTS.md", "CLAUDE.md"],
  };
}

// ─── OpenAI Profile ──────────────────────────────────────────────────────────

const OPENAI_BASE_INSTRUCTIONS = `You are an AI coding assistant. You help users with software engineering tasks including solving bugs, adding functionality, refactoring code, and explaining code.

Key guidelines:
- Use apply_patch for file modifications. It supports creating, deleting, and modifying files using the v4a diff format.
- Use read_file to examine files before editing.
- Use the shell tool for running commands, tests, and builds. Default timeout is 10 seconds.
- Use grep and glob to search the codebase.
- Keep changes focused and minimal.
- Write safe, secure code.

apply_patch format:
- Patches start with "*** Begin Patch" and end with "*** End Patch"
- Use "*** Add File: <path>" with + prefixed lines to create files
- Use "*** Delete File: <path>" to delete files
- Use "*** Update File: <path>" with @@ hunks to modify files
- In hunks: space prefix = context (unchanged), - prefix = delete, + prefix = add`;

export function createOpenAIProfile(opts: CreateProfileOptions): ProviderProfile {
  const provider = opts.provider ?? "openai";
  const modelId = opts.modelId ?? "gpt-4o";

  let model: Model<Api>;
  try {
    model = getModel(provider as any, modelId as any);
  } catch {
    model = getModel("openai" as any, "gpt-4o" as any);
  }

  let tools: AgentTool[];
  if (opts.executionEnv) {
    const env = opts.executionEnv;
    tools = asToolArray(
      createReadTool(opts.cwd, { operations: createReadOperations(env) }),
      createWriteTool(opts.cwd, { operations: createWriteOperations(env) }),
      createBashTool(opts.cwd, { operations: createBashOperations(env) }),
      createGrepTool(opts.cwd, { operations: createGrepOperations(env) }),
      createFindTool(opts.cwd, { operations: createFindOperations(env) }),
      createLsTool(opts.cwd, { operations: createLsOperations(env) }),
      createApplyPatchTool(env),
    );
  } else {
    const localEnv = new LocalExecutionEnvironment({ cwd: opts.cwd });
    tools = asToolArray(
      createReadTool(opts.cwd),
      createWriteTool(opts.cwd),
      createBashTool(opts.cwd),
      createGrepTool(opts.cwd),
      createFindTool(opts.cwd),
      createLsTool(opts.cwd),
      createApplyPatchTool(localEnv),
    );
  }

  if (opts.customTools) {
    for (const custom of opts.customTools) {
      const idx = tools.findIndex((t) => t.name === custom.name);
      if (idx >= 0) {
        tools[idx] = custom;
      } else {
        tools.push(custom);
      }
    }
  }

  const truncation = mergeTruncation(DEFAULT_TRUNCATION, opts.truncationOverrides);

  const baseInstructions = opts.extraInstructions
    ? opts.extraInstructions + "\n\n" + OPENAI_BASE_INSTRUCTIONS
    : OPENAI_BASE_INSTRUCTIONS;

  return {
    id: "openai",
    model,
    tools,
    toolNames: tools.map((t) => t.name),
    defaultThinkingLevel: opts.thinkingLevel ?? "medium",
    defaultCommandTimeoutMs: 10_000, // codex-rs convention: 10s
    supportsParallelToolCalls: true,
    supportsReasoning: true,
    contextWindowSize: model.contextWindow,
    truncation,
    baseInstructions,
    projectDocPatterns: ["AGENTS.md", ".codex/instructions.md"],
  };
}

// ─── Gemini Profile ──────────────────────────────────────────────────────────

const GEMINI_BASE_INSTRUCTIONS = `You are an AI coding assistant. You help users with software engineering tasks including solving bugs, adding functionality, refactoring code, and explaining code.

Key guidelines:
- Use read_file to examine files before modifying them.
- Use edit_file with old_string/new_string for precise edits.
- Use the shell tool for running commands. Default timeout is 10 seconds.
- Use grep and glob to search the codebase.
- Use list_dir for directory listings.
- Keep changes focused and minimal.
- Write safe, secure code.`;

export function createGeminiProfile(opts: CreateProfileOptions): ProviderProfile {
  const provider = opts.provider ?? "google";
  const modelId = opts.modelId ?? "gemini-2.5-pro";

  let model: Model<Api>;
  try {
    model = getModel(provider as any, modelId as any);
  } catch {
    model = getModel("google" as any, "gemini-2.5-pro" as any);
  }

  let tools: AgentTool[];
  if (opts.executionEnv) {
    const env = opts.executionEnv;
    tools = asToolArray(
      createReadTool(opts.cwd, { operations: createReadOperations(env) }),
      createWriteTool(opts.cwd, { operations: createWriteOperations(env) }),
      createEditTool(opts.cwd),
      createBashTool(opts.cwd, { operations: createBashOperations(env) }),
      createGrepTool(opts.cwd, { operations: createGrepOperations(env) }),
      createFindTool(opts.cwd, { operations: createFindOperations(env) }),
      createLsTool(opts.cwd, { operations: createLsOperations(env) }),
    );
  } else {
    tools = asToolArray(
      createReadTool(opts.cwd),
      createWriteTool(opts.cwd),
      createEditTool(opts.cwd),
      createBashTool(opts.cwd),
      createGrepTool(opts.cwd),
      createFindTool(opts.cwd),
      createLsTool(opts.cwd),
    );
  }

  if (opts.customTools) {
    for (const custom of opts.customTools) {
      const idx = tools.findIndex((t) => t.name === custom.name);
      if (idx >= 0) {
        tools[idx] = custom;
      } else {
        tools.push(custom);
      }
    }
  }

  const truncation = mergeTruncation(DEFAULT_TRUNCATION, opts.truncationOverrides);

  const baseInstructions = opts.extraInstructions
    ? opts.extraInstructions + "\n\n" + GEMINI_BASE_INSTRUCTIONS
    : GEMINI_BASE_INSTRUCTIONS;

  return {
    id: "gemini",
    model,
    tools,
    toolNames: tools.map((t) => t.name),
    defaultThinkingLevel: opts.thinkingLevel ?? "medium",
    defaultCommandTimeoutMs: 10_000,
    supportsParallelToolCalls: true,
    supportsReasoning: true,
    contextWindowSize: model.contextWindow,
    truncation,
    baseInstructions,
    projectDocPatterns: ["AGENTS.md", "GEMINI.md"],
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mergeTruncation(
  defaults: TruncationDefaults,
  overrides?: Partial<TruncationDefaults>,
): TruncationDefaults {
  if (!overrides) return defaults;
  return {
    charLimits: { ...defaults.charLimits, ...overrides.charLimits },
    lineLimits: { ...defaults.lineLimits, ...overrides.lineLimits },
    modes: { ...defaults.modes, ...overrides.modes },
  };
}
