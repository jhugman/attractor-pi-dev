import { getModel, type Model, type Api } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  ModelRegistry,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type {
  CodergenBackend,
  GraphNode,
  Context,
  Outcome,
} from "@attractor/core";
import { StageStatus } from "@attractor/core";
import {
  Session,
  SessionState,
  type SessionConfig,
  type SessionEvent,
} from "./session.js";
import {
  createAnthropicProfile,
  createOpenAIProfile,
  createGeminiProfile,
  type ProviderProfile,
} from "./provider-profile.js";
import {
  LocalExecutionEnvironment,
  type ExecutionEnvironment,
} from "./execution-env.js";

export interface PiAgentBackendOptions {
  /** Default model provider (e.g. "anthropic", "openai", "google") */
  defaultProvider?: string;
  /** Default model ID (e.g. "claude-sonnet-4-5-20250929") */
  defaultModel?: string;
  /** Default thinking level */
  defaultThinkingLevel?: ThinkingLevel;
  /** Working directory for coding tools */
  cwd?: string;
  /** Event listener for session events */
  onSessionEvent?: (event: SessionEvent) => void;
  /** Legacy event listener for raw agent events */
  onAgentEvent?: (event: AgentSessionEvent) => void;
  /** Reuse sessions across nodes sharing a thread_id */
  reuseSessions?: boolean;
  /** Session configuration overrides */
  sessionConfig?: Partial<SessionConfig>;
  /** Custom execution environment (default: local) */
  executionEnv?: ExecutionEnvironment;
  /** Custom provider profile factory override */
  createProfile?: (provider: string, cwd: string) => ProviderProfile;
}

/**
 * CodergenBackend implementation using pi-mono's coding agent,
 * wrapped with spec-compliant Session (state machine, limits, loop detection).
 *
 * Each node execution creates (or reuses) a Session with provider-specific
 * tools, sends the prompt, waits for completion, and returns the response.
 */
export class PiAgentCodergenBackend implements CodergenBackend {
  private options: Required<
    Pick<
      PiAgentBackendOptions,
      "defaultProvider" | "defaultModel" | "defaultThinkingLevel" | "cwd" | "reuseSessions"
    >
  > & PiAgentBackendOptions;
  private sessions = new Map<string, Session>();
  private authStorage: AuthStorage;
  private modelRegistry: ModelRegistry;
  private executionEnv?: ExecutionEnvironment;

  constructor(opts?: PiAgentBackendOptions) {
    this.options = {
      defaultProvider: opts?.defaultProvider ?? "anthropic",
      defaultModel: opts?.defaultModel ?? "claude-sonnet-4-5-20250929",
      defaultThinkingLevel: opts?.defaultThinkingLevel ?? "high",
      cwd: opts?.cwd ?? process.cwd(),
      reuseSessions: opts?.reuseSessions ?? true,
      ...opts,
    };
    this.authStorage = new AuthStorage();
    this.modelRegistry = new ModelRegistry(this.authStorage);
    this.executionEnv = opts?.executionEnv;
  }

  async run(
    node: GraphNode,
    prompt: string,
    context: Context,
  ): Promise<string | Outcome> {
    const provider = node.llmProvider || this.options.defaultProvider;
    const modelId = node.llmModel || this.options.defaultModel;
    const thinkingLevel = this.resolveThinkingLevel(node);
    const threadKey = this.resolveThreadKey(node, context);
    const cwd = this.options.cwd;

    // Get or create session
    let session: Session;
    if (this.options.reuseSessions && this.sessions.has(threadKey)) {
      session = this.sessions.get(threadKey)!;
      // Update reasoning effort if needed
      session.setReasoningEffort(thinkingLevel);
    } else {
      // Resolve profile
      const profile = this.resolveProfile(provider, modelId, thinkingLevel, cwd);

      // Create execution environment if not provided
      const execEnv = this.executionEnv ?? new LocalExecutionEnvironment({ cwd });

      session = new Session({
        profile,
        executionEnv: execEnv,
        config: this.options.sessionConfig,
        authStorage: this.authStorage,
        modelRegistry: this.modelRegistry,
      });

      // Wire up event listeners
      if (this.options.onSessionEvent) {
        session.subscribe(this.options.onSessionEvent);
      }

      if (this.options.reuseSessions) {
        this.sessions.set(threadKey, session);
      }
    }

    // Send prompt and wait for completion
    try {
      await session.submit(prompt);
    } catch (err) {
      return {
        status: StageStatus.FAIL,
        failureReason: `Agent execution failed: ${err}`,
      };
    }

    // Extract the assistant's text response
    const responseText = session.getLastAssistantText() ?? "";

    if (!responseText) {
      return {
        status: StageStatus.FAIL,
        failureReason: "Agent returned empty response",
      };
    }

    return responseText;
  }

  /** Resolve a ProviderProfile from provider name */
  private resolveProfile(
    provider: string,
    modelId: string,
    thinkingLevel: ThinkingLevel,
    cwd: string,
  ): ProviderProfile {
    if (this.options.createProfile) {
      return this.options.createProfile(provider, cwd);
    }

    const execEnv = this.executionEnv;
    const profileOpts = {
      provider,
      modelId,
      thinkingLevel,
      cwd,
      executionEnv: execEnv,
    };

    switch (provider) {
      case "openai":
      case "azure-openai-responses":
      case "openai-codex":
        return createOpenAIProfile(profileOpts);
      case "google":
      case "google-gemini-cli":
      case "google-vertex":
        return createGeminiProfile(profileOpts);
      default:
        // Anthropic is the default for all other providers
        return createAnthropicProfile(profileOpts);
    }
  }

  /** Map reasoning_effort to pi-mono ThinkingLevel */
  private resolveThinkingLevel(node: GraphNode): ThinkingLevel {
    switch (node.reasoningEffort) {
      case "low":
        return "low";
      case "medium":
        return "medium";
      case "high":
        return "high";
      default:
        return this.options.defaultThinkingLevel;
    }
  }

  /** Determine session reuse key from node/context */
  private resolveThreadKey(node: GraphNode, context: Context): string {
    // 1. Explicit thread_id on node
    if (node.threadId) return node.threadId;
    // 2. Derived from class (subgraph)
    if (node.classes.length > 0) return node.classes[0]!;
    // 3. Fallback to node ID
    return node.id;
  }

  /** Clean up all sessions */
  async dispose(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.dispose();
    }
    this.sessions.clear();
  }
}
