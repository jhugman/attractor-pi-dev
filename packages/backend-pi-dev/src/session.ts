import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type AgentToolResult,
  type ThinkingLevel,
} from "@mariozechner/pi-agent-core";
import { type Model, type Api } from "@mariozechner/pi-ai";
import {
  createAgentSession,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import type { ProviderProfile } from "./provider-profile.js";
import type { ExecutionEnvironment } from "./execution-env.js";
import { buildFullSystemPrompt, discoverProjectDocs } from "./system-prompt.js";
import { detectLoop } from "./loop-detection.js";
import { truncateToolOutput } from "./truncation.js";

// ─── Session State Machine ───────────────────────────────────────────────────

export enum SessionState {
  IDLE = "IDLE",
  PROCESSING = "PROCESSING",
  AWAITING_INPUT = "AWAITING_INPUT",
  CLOSED = "CLOSED",
}

// ─── Session Configuration ───────────────────────────────────────────────────

export interface SessionConfig {
  /** Maximum turns across the entire session (0 = unlimited) */
  maxTurns: number;
  /** Maximum tool rounds per user input */
  maxToolRoundsPerInput: number;
  /** Default command timeout in ms */
  defaultCommandTimeoutMs: number;
  /** Max command timeout in ms */
  maxCommandTimeoutMs: number;
  /** Reasoning effort override */
  reasoningEffort: ThinkingLevel | null;
  /** Enable loop detection */
  enableLoopDetection: boolean;
  /** Window size for loop detection */
  loopDetectionWindow: number;
  /** Max subagent nesting depth */
  maxSubagentDepth: number;
  /** Per-tool character limits */
  toolOutputLimits: Record<string, number>;
  /** Per-tool line limits */
  toolLineLimits: Record<string, number>;
}

const DEFAULT_SESSION_CONFIG: SessionConfig = {
  maxTurns: 0,
  maxToolRoundsPerInput: 200,
  defaultCommandTimeoutMs: 10_000,
  maxCommandTimeoutMs: 600_000,
  reasoningEffort: null,
  enableLoopDetection: true,
  loopDetectionWindow: 10,
  maxSubagentDepth: 1,
  toolOutputLimits: {},
  toolLineLimits: {},
};

// ─── Session Events ──────────────────────────────────────────────────────────

export type SessionEventKind =
  | "session_start"
  | "session_end"
  | "user_input"
  | "assistant_text_start"
  | "assistant_text_delta"
  | "assistant_text_end"
  | "tool_call_start"
  | "tool_call_output_delta"
  | "tool_call_end"
  | "steering_injected"
  | "turn_limit"
  | "loop_detection"
  | "error"
  | "state_change";

export interface SessionEvent {
  kind: SessionEventKind;
  timestamp: number;
  sessionId: string;
  data: Record<string, unknown>;
}

export type SessionEventListener = (event: SessionEvent) => void;

// ─── Session ─────────────────────────────────────────────────────────────────

export interface SessionOptions {
  profile: ProviderProfile;
  executionEnv?: ExecutionEnvironment;
  config?: Partial<SessionConfig>;
  /** Custom system prompt override */
  systemPrompt?: string;
  /** User instructions appended to system prompt */
  userInstructions?: string;
  /** Auth storage for pi-mono */
  authStorage?: AuthStorage;
  /** Model registry for pi-mono */
  modelRegistry?: ModelRegistry;
  /** Depth of this session (for subagent depth limiting) */
  depth?: number;
}

/**
 * Session wraps pi-mono's Agent/AgentSession with spec-compliant behavior:
 * - State machine (IDLE/PROCESSING/AWAITING_INPUT/CLOSED)
 * - Turn/round limits
 * - Loop detection
 * - Event re-emission as spec SessionEvents
 * - Steering and follow-up delegation
 */
export class Session {
  readonly id: string;
  readonly profile: ProviderProfile;
  readonly config: SessionConfig;
  readonly depth: number;

  private _state: SessionState = SessionState.IDLE;
  private agentSession: AgentSession | null = null;
  private listeners: SessionEventListener[] = [];
  private totalTurns = 0;
  private roundCount = 0;
  private abortController = new AbortController();
  private authStorage: AuthStorage;
  private modelRegistry: ModelRegistry;
  private executionEnv?: ExecutionEnvironment;
  private userInstructions?: string;
  private customSystemPrompt?: string;
  /** Stores raw (untruncated) tool outputs keyed by toolCallId */
  private rawToolOutputs = new Map<string, string>();
  /** Set when turn/round limits are hit, checked by tool wrappers */
  private _shouldStop = false;

  constructor(opts: SessionOptions) {
    this.id = crypto.randomUUID();
    this.profile = opts.profile;
    this.config = { ...DEFAULT_SESSION_CONFIG, ...opts.config };
    this.depth = opts.depth ?? 0;
    this.executionEnv = opts.executionEnv;
    this.userInstructions = opts.userInstructions;
    this.customSystemPrompt = opts.systemPrompt;
    this.authStorage = opts.authStorage ?? new AuthStorage();
    this.modelRegistry = opts.modelRegistry ?? new ModelRegistry(this.authStorage);
  }

  get state(): SessionState {
    return this._state;
  }

  get agent(): Agent | undefined {
    return this.agentSession?.agent;
  }

  get session(): AgentSession | null {
    return this.agentSession;
  }

  /** Subscribe to session events. Returns unsubscribe function. */
  subscribe(listener: SessionEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(kind: SessionEventKind, data: Record<string, unknown> = {}): void {
    const event: SessionEvent = {
      kind,
      timestamp: Date.now(),
      sessionId: this.id,
      data,
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Don't let listener errors crash the session
      }
    }
  }

  private setState(newState: SessionState): void {
    const oldState = this._state;
    if (oldState === newState) return;
    this._state = newState;
    this.emit("state_change", { from: oldState, to: newState });
  }

  /**
   * Initialize the underlying pi-mono AgentSession.
   * Must be called before submit(). Idempotent.
   */
  async initialize(): Promise<void> {
    if (this.agentSession) return;

    if (this.executionEnv) {
      await this.executionEnv.initialize();
    }

    const cwd = this.executionEnv?.workingDirectory() ?? process.cwd();

    // Discover project docs (AGENTS.md, CLAUDE.md, etc.)
    const contextFiles = await discoverProjectDocs(cwd, this.profile.projectDocPatterns);

    // Build system prompt
    const systemPrompt = this.customSystemPrompt ?? buildFullSystemPrompt({
      baseInstructions: this.profile.baseInstructions,
      cwd,
      modelName: this.profile.model.name,
      userInstructions: this.userInstructions,
      selectedTools: this.profile.toolNames,
      contextFiles,
    });

    const result = await createAgentSession({
      model: this.profile.model,
      thinkingLevel: this.config.reasoningEffort ?? this.profile.defaultThinkingLevel,
      cwd,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      sessionManager: SessionManager.inMemory(),
    });

    this.agentSession = result.session;

    // Wrap tools with truncation before setting them on the agent
    const wrappedTools = this.wrapToolsWithTruncation(this.profile.tools);

    // Set the system prompt and tools from the profile
    this.agentSession.agent.setSystemPrompt(systemPrompt);
    this.agentSession.agent.setTools(wrappedTools);

    // Subscribe to agent events and re-emit as session events
    this.agentSession.subscribe((agentEvent: AgentSessionEvent) => {
      this.handleAgentEvent(agentEvent);
    });

    this.emit("session_start");
  }

  /**
   * Wrap each tool's execute method to apply truncation.
   * Raw output is stored in rawToolOutputs for the event stream.
   * Truncated output is what goes to the LLM.
   */
  private wrapToolsWithTruncation(tools: AgentTool[]): AgentTool[] {
    const { charLimits, lineLimits, modes } = this.profile.truncation;
    // Merge session-level overrides
    const mergedCharLimits = { ...charLimits, ...this.config.toolOutputLimits };
    const mergedLineLimits = { ...lineLimits, ...this.config.toolLineLimits };

    return tools.map((tool) => ({
      ...tool,
      execute: async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: (partialResult: AgentToolResult<unknown>) => void,
      ): Promise<AgentToolResult<unknown>> => {
        // If session is stopping, return early
        if (this._shouldStop) {
          return {
            content: [{ type: "text" as const, text: "[Session stopped due to turn/round limit]" }],
            details: undefined,
          };
        }

        // Execute the original tool
        const result = await tool.execute(toolCallId, params, signal, onUpdate);

        // Extract text content for truncation
        const rawText = result.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n");

        // Store raw output for events (Gap 8)
        this.rawToolOutputs.set(toolCallId, rawText);

        // Apply truncation to text content (Gap 1)
        const truncatedText = truncateToolOutput(
          rawText,
          tool.name,
          mergedCharLimits,
          mergedLineLimits,
          modes,
        );

        // If text was truncated, replace content
        if (truncatedText !== rawText) {
          return {
            ...result,
            content: [{ type: "text" as const, text: truncatedText }],
          };
        }

        return result;
      },
    })) as AgentTool[];
  }

  /**
   * Submit user input and run the agentic loop.
   */
  async submit(input: string): Promise<void> {
    if (this._state === SessionState.CLOSED) {
      throw new Error("Session is closed");
    }

    await this.initialize();

    this.setState(SessionState.PROCESSING);
    this.roundCount = 0;
    this._shouldStop = false;
    this.emit("user_input", { content: input });

    try {
      await this.agentSession!.prompt(input);
      await this.agentSession!.agent.waitForIdle();
    } catch (err) {
      this.emit("error", { message: String(err) });
      if (isUnrecoverableError(err)) {
        this.setState(SessionState.CLOSED);
        return;
      }
    }

    // Detect if the assistant is asking a question (Gap 5: AWAITING_INPUT)
    const lastText = this.getLastAssistantText()?.trim();
    if (lastText && looksLikeQuestion(lastText)) {
      this.setState(SessionState.AWAITING_INPUT);
    } else {
      this.setState(SessionState.IDLE);
    }

    this.emit("session_end", { totalTurns: this.totalTurns });
  }

  /** Inject a steering message between tool rounds. */
  steer(message: string): void {
    if (!this.agentSession) return;
    this.agentSession.steer(message);
    this.emit("steering_injected", { content: message });
  }

  /** Queue a follow-up message for after the current input completes. */
  followUp(message: string): void {
    if (!this.agentSession) return;
    this.agentSession.followUp(message);
  }

  /** Change the model mid-session. */
  async setModel(model: Model<Api>): Promise<void> {
    if (this.agentSession) {
      await this.agentSession.setModel(model);
    }
  }

  /** Change reasoning effort mid-session. */
  setReasoningEffort(level: ThinkingLevel): void {
    if (this.agentSession) {
      this.agentSession.setThinkingLevel(level);
    }
    this.config.reasoningEffort = level;
  }

  /** Abort the session. */
  async abort(): Promise<void> {
    this.abortController.abort();
    if (this.agentSession) {
      await this.agentSession.abort();
    }
    this.setState(SessionState.CLOSED);
  }

  /** Clean up resources. */
  async dispose(): Promise<void> {
    if (this.agentSession) {
      this.agentSession.dispose();
    }
    if (this.executionEnv) {
      await this.executionEnv.cleanup();
    }
    this.setState(SessionState.CLOSED);
  }

  /** Get the last assistant text response. */
  getLastAssistantText(): string | undefined {
    return this.agentSession?.getLastAssistantText();
  }

  /** Get conversation history. */
  getMessages(): AgentMessage[] {
    return this.agentSession?.messages ?? [];
  }

  // ─── Internal Event Handling ─────────────────────────────────────────────

  private handleAgentEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case "turn_start":
        this.totalTurns++;
        // Check turn limits (Gap 4: set _shouldStop flag)
        if (this.config.maxTurns > 0 && this.totalTurns > this.config.maxTurns) {
          this._shouldStop = true;
          this.emit("turn_limit", { totalTurns: this.totalTurns });
          // Fire abort (async, but _shouldStop prevents further tool execution)
          this.agentSession?.abort();
        }
        break;

      case "turn_end":
        // Check for tool calls in the turn to count rounds
        if (event.toolResults && event.toolResults.length > 0) {
          this.roundCount++;

          // Round limit check (Gap 4: set _shouldStop flag)
          if (this.roundCount >= this.config.maxToolRoundsPerInput) {
            this._shouldStop = true;
            this.emit("turn_limit", { round: this.roundCount });
            this.agentSession?.abort();
          }

          // Loop detection
          if (this.config.enableLoopDetection) {
            const messages = this.agentSession?.messages ?? [];
            if (detectLoop(messages, this.config.loopDetectionWindow)) {
              const warning =
                `Loop detected: the last ${this.config.loopDetectionWindow} ` +
                `tool calls follow a repeating pattern. Try a different approach.`;
              this.emit("loop_detection", { message: warning });
              this.agentSession?.steer(warning);
            }
          }
        }
        break;

      case "message_start":
        if (event.message.role === "assistant") {
          this.emit("assistant_text_start");
        }
        break;

      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          this.emit("assistant_text_delta", {
            delta: event.assistantMessageEvent.delta,
          });
        }
        break;

      case "message_end":
        if (event.message.role === "assistant") {
          const textParts = event.message.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text);
          this.emit("assistant_text_end", { text: textParts.join("") });
        }
        break;

      case "tool_execution_start":
        this.emit("tool_call_start", {
          toolName: event.toolName,
          callId: event.toolCallId,
          args: event.args,
        });
        break;

      case "tool_execution_update":
        this.emit("tool_call_output_delta", {
          callId: event.toolCallId,
          toolName: event.toolName,
          partialResult: event.partialResult,
        });
        break;

      case "tool_execution_end": {
        // Gap 8: Emit FULL untruncated output via event stream
        const rawOutput = this.rawToolOutputs.get(event.toolCallId);
        this.rawToolOutputs.delete(event.toolCallId);
        this.emit("tool_call_end", {
          callId: event.toolCallId,
          toolName: event.toolName,
          output: rawOutput ?? event.result,
          isError: event.isError,
        });
        break;
      }

      case "agent_end":
        // Handled by submit() flow
        break;
    }
  }
}

function isUnrecoverableError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return (
    msg.includes("authentication") ||
    msg.includes("unauthorized") ||
    msg.includes("forbidden") ||
    msg.includes("context_length_exceeded") ||
    msg.includes("context overflow")
  );
}

/**
 * Heuristic to detect if the assistant's response is asking a question.
 * Used for AWAITING_INPUT state transition (spec Section 2.3).
 */
function looksLikeQuestion(text: string): boolean {
  // Check if the text ends with a question mark (after stripping trailing whitespace/newlines)
  const trimmed = text.trimEnd();
  if (trimmed.endsWith("?")) return true;

  // Check for common question patterns in the last paragraph
  const lastParagraph = trimmed.split("\n\n").pop()?.toLowerCase() ?? "";
  const questionStarters = [
    "would you like",
    "do you want",
    "should i",
    "shall i",
    "can you",
    "could you",
    "what would you",
    "how would you",
    "which option",
    "what do you think",
    "what are your thoughts",
    "please let me know",
    "let me know if",
  ];
  return questionStarters.some((q) => lastParagraph.includes(q));
}
