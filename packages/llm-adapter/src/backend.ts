import { getModel, type Model, type Api } from "@mariozechner/pi-ai";
import {
  createAgentSession,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  codingTools,
  type AgentSession,
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

export interface PiAgentBackendOptions {
  /** Default model provider (e.g. "anthropic", "openai") */
  defaultProvider?: string;
  /** Default model ID (e.g. "claude-sonnet-4-5-20250929") */
  defaultModel?: string;
  /** Default thinking level */
  defaultThinkingLevel?: ThinkingLevel;
  /** Working directory for coding tools */
  cwd?: string;
  /** Event listener for agent events */
  onAgentEvent?: (event: AgentSessionEvent) => void;
  /** Reuse sessions across nodes sharing a thread_id */
  reuseSessions?: boolean;
}

/**
 * CodergenBackend implementation using pi-mono's coding agent.
 *
 * Each node execution creates (or reuses) an AgentSession with
 * read/write/edit/bash tools, sends the prompt, waits for completion,
 * and returns the assistant's text response.
 */
export class PiAgentCodergenBackend implements CodergenBackend {
  private options: Required<PiAgentBackendOptions>;
  private sessions = new Map<string, AgentSession>();
  private authStorage: AuthStorage;
  private modelRegistry: ModelRegistry;

  constructor(opts?: PiAgentBackendOptions) {
    this.options = {
      defaultProvider: opts?.defaultProvider ?? "anthropic",
      defaultModel: opts?.defaultModel ?? "claude-sonnet-4-5-20250929",
      defaultThinkingLevel: opts?.defaultThinkingLevel ?? "high",
      cwd: opts?.cwd ?? process.cwd(),
      onAgentEvent: opts?.onAgentEvent ?? (() => {}),
      reuseSessions: opts?.reuseSessions ?? true,
    };
    this.authStorage = new AuthStorage();
    this.modelRegistry = new ModelRegistry(this.authStorage);
  }

  async run(
    node: GraphNode,
    prompt: string,
    context: Context,
  ): Promise<string | Outcome> {
    const model = this.resolveModel(node);
    const thinkingLevel = this.resolveThinkingLevel(node);
    const threadKey = this.resolveThreadKey(node, context);

    // Get or create session
    let session: AgentSession;
    if (this.options.reuseSessions && this.sessions.has(threadKey)) {
      session = this.sessions.get(threadKey)!;
      // Update model if different
      const currentModel = session.model;
      if (currentModel && (currentModel.id !== model.id)) {
        await session.setModel(model);
      }
      session.setThinkingLevel(thinkingLevel);
    } else {
      const result = await createAgentSession({
        model,
        thinkingLevel,
        cwd: this.options.cwd,
        authStorage: this.authStorage,
        modelRegistry: this.modelRegistry,
        sessionManager: SessionManager.inMemory(),
      });
      session = result.session;

      if (result.modelFallbackMessage) {
        context.appendLog(`[${node.id}] Model fallback: ${result.modelFallbackMessage}`);
      }

      session.subscribe(this.options.onAgentEvent);

      if (this.options.reuseSessions) {
        this.sessions.set(threadKey, session);
      }
    }

    // Send prompt and wait for completion
    try {
      await session.prompt(prompt);
      await session.agent.waitForIdle();
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

  /** Resolve a pi-ai Model from node attributes */
  private resolveModel(node: GraphNode): Model<Api> {
    const provider = node.llmProvider || this.options.defaultProvider;
    const modelId = node.llmModel || this.options.defaultModel;

    try {
      return getModel(provider as any, modelId as any);
    } catch {
      // Fallback: try finding via registry
      const found = this.modelRegistry.find(provider, modelId);
      if (found) return found;

      // Last resort: use defaults
      return getModel(
        this.options.defaultProvider as any,
        this.options.defaultModel as any,
      );
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
      session.dispose();
    }
    this.sessions.clear();
  }
}
