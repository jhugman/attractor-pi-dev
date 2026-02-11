import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { TextContent, Model, Api } from "@mariozechner/pi-ai";
import { Session, type SessionConfig, type SessionOptions } from "../session.js";
import type { ProviderProfile } from "../provider-profile.js";
import type { ExecutionEnvironment } from "../execution-env.js";

// ─── SubAgent Handle ─────────────────────────────────────────────────────────

interface SubAgentHandle {
  id: string;
  session: Session;
  status: "running" | "completed" | "failed";
  output?: string;
  /** Promise tracking the submit() call, for reliable wait() */
  submitPromise?: Promise<void>;
}

interface SubAgentManager {
  agents: Map<string, SubAgentHandle>;
  parentSession: Session;
  profile: ProviderProfile;
  executionEnv?: ExecutionEnvironment;
  maxDepth: number;
  currentDepth: number;
}

/**
 * Create the four subagent tools: spawn_agent, send_input, wait, close_agent.
 *
 * These tools allow the parent agent to spawn child sessions for parallel
 * task decomposition. Subagents share the parent's execution environment
 * but maintain independent conversation history.
 */
export function createSubagentTools(
  parentSession: Session,
  profile: ProviderProfile,
  executionEnv?: ExecutionEnvironment,
  maxDepth: number = 1,
  currentDepth: number = 0,
): AgentTool[] {
  const manager: SubAgentManager = {
    agents: new Map(),
    parentSession,
    profile,
    executionEnv,
    maxDepth,
    currentDepth,
  };

  // Cast needed due to AgentTool<TSchema> contravariance with specific param types
  return [
    createSpawnAgentTool(manager) as unknown as AgentTool,
    createSendInputTool(manager) as unknown as AgentTool,
    createWaitTool(manager) as unknown as AgentTool,
    createCloseAgentTool(manager) as unknown as AgentTool,
  ];
}

// ─── spawn_agent ─────────────────────────────────────────────────────────────

const SpawnAgentParams = Type.Object({
  task: Type.String({ description: "Natural language task description" }),
  working_dir: Type.Optional(
    Type.String({ description: "Subdirectory to scope the agent to" }),
  ),
  model: Type.Optional(
    Type.String({ description: "Model override (default: parent's model)" }),
  ),
  max_turns: Type.Optional(
    Type.Number({ description: "Turn limit (default: 50)" }),
  ),
});

function createSpawnAgentTool(
  manager: SubAgentManager,
): AgentTool<typeof SpawnAgentParams> {
  return {
    name: "spawn_agent",
    label: "Spawn Agent",
    description:
      "Spawn a subagent to handle a scoped task autonomously. " +
      "The subagent shares the same filesystem but has independent conversation history.",
    parameters: SpawnAgentParams,

    async execute(
      _toolCallId: string,
      params: Static<typeof SpawnAgentParams>,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<unknown>> {
      // Depth check
      if (manager.currentDepth >= manager.maxDepth) {
        return errorResult(
          `Cannot spawn subagent: max depth ${manager.maxDepth} reached. ` +
          `Current depth: ${manager.currentDepth}.`,
        );
      }

      const agentId = crypto.randomUUID().slice(0, 8);

      // Create child session
      const childSession = new Session({
        profile: manager.profile,
        executionEnv: manager.executionEnv,
        config: {
          maxTurns: params.max_turns ?? 50,
          maxToolRoundsPerInput: 200,
        },
        depth: manager.currentDepth + 1,
      });

      const handle: SubAgentHandle = {
        id: agentId,
        session: childSession,
        status: "running",
      };
      manager.agents.set(agentId, handle);

      // Track the submit promise for reliable wait() (Gap 7)
      handle.submitPromise = childSession
        .submit(params.task)
        .then(() => {
          handle.status = "completed";
          handle.output = childSession.getLastAssistantText() ?? "";
        })
        .catch((err) => {
          handle.status = "failed";
          handle.output = `Error: ${err}`;
        });

      return textResult(
        `Subagent spawned with ID: ${agentId}\n` +
        `Task: ${params.task}\n` +
        `Status: running`,
      );
    },
  };
}

// ─── send_input ──────────────────────────────────────────────────────────────

const SendInputParams = Type.Object({
  agent_id: Type.String({ description: "The subagent ID" }),
  message: Type.String({ description: "Message to send to the subagent" }),
});

function createSendInputTool(
  manager: SubAgentManager,
): AgentTool<typeof SendInputParams> {
  return {
    name: "send_input",
    label: "Send Input",
    description: "Send a message to a running subagent.",
    parameters: SendInputParams,

    async execute(
      _toolCallId: string,
      params: Static<typeof SendInputParams>,
    ): Promise<AgentToolResult<unknown>> {
      const handle = manager.agents.get(params.agent_id);
      if (!handle) {
        return errorResult(`No subagent with ID: ${params.agent_id}`);
      }

      if (handle.status !== "running") {
        return errorResult(
          `Subagent ${params.agent_id} is ${handle.status}, cannot send input.`,
        );
      }

      handle.session.steer(params.message);
      return textResult(`Message sent to subagent ${params.agent_id}`);
    },
  };
}

// ─── wait ────────────────────────────────────────────────────────────────────

const WaitParams = Type.Object({
  agent_id: Type.String({ description: "The subagent ID" }),
});

function createWaitTool(
  manager: SubAgentManager,
): AgentTool<typeof WaitParams> {
  return {
    name: "wait",
    label: "Wait for Agent",
    description: "Wait for a subagent to complete and return its result.",
    parameters: WaitParams,

    async execute(
      _toolCallId: string,
      params: Static<typeof WaitParams>,
    ): Promise<AgentToolResult<unknown>> {
      const handle = manager.agents.get(params.agent_id);
      if (!handle) {
        return errorResult(`No subagent with ID: ${params.agent_id}`);
      }

      // Wait for the tracked submit promise (Gap 7: fixes race conditions)
      if (handle.status === "running") {
        try {
          if (handle.submitPromise) {
            await handle.submitPromise;
          } else if (handle.session.agent) {
            await handle.session.agent.waitForIdle();
            handle.status = "completed";
            handle.output = handle.session.getLastAssistantText() ?? "";
          }
        } catch (err) {
          handle.status = "failed";
          handle.output = `Error waiting: ${err}`;
        }
      }

      const output = handle.output ?? "(no output)";
      return textResult(
        `Subagent ${params.agent_id} — Status: ${handle.status}\n\nOutput:\n${output}`,
      );
    },
  };
}

// ─── close_agent ─────────────────────────────────────────────────────────────

const CloseAgentParams = Type.Object({
  agent_id: Type.String({ description: "The subagent ID" }),
});

function createCloseAgentTool(
  manager: SubAgentManager,
): AgentTool<typeof CloseAgentParams> {
  return {
    name: "close_agent",
    label: "Close Agent",
    description: "Terminate a subagent and clean up its resources.",
    parameters: CloseAgentParams,

    async execute(
      _toolCallId: string,
      params: Static<typeof CloseAgentParams>,
    ): Promise<AgentToolResult<unknown>> {
      const handle = manager.agents.get(params.agent_id);
      if (!handle) {
        return errorResult(`No subagent with ID: ${params.agent_id}`);
      }

      try {
        await handle.session.dispose();
      } catch {
        // Best-effort cleanup
      }

      manager.agents.delete(params.agent_id);
      return textResult(`Subagent ${params.agent_id} closed.`);
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function textResult(text: string): AgentToolResult<unknown> {
  return {
    content: [{ type: "text" as const, text }],
    details: undefined,
  };
}

function errorResult(text: string): AgentToolResult<unknown> {
  return {
    content: [{ type: "text" as const, text }],
    details: undefined,
  };
}
