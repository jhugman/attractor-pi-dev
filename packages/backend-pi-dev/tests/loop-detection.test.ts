import { describe, it, expect } from "vitest";
import { detectLoop } from "../src/loop-detection.js";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@mariozechner/pi-ai";

function makeAssistantMessage(toolCalls: Array<{ name: string; args: Record<string, unknown> }>): AssistantMessage {
  return {
    role: "assistant",
    content: toolCalls.map((tc) => ({
      type: "toolCall" as const,
      id: crypto.randomUUID(),
      name: tc.name,
      arguments: tc.args,
    })),
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

describe("detectLoop", () => {
  it("returns false when history is empty", () => {
    expect(detectLoop([], 10)).toBe(false);
  });

  it("returns false when not enough tool calls", () => {
    const history: AgentMessage[] = [
      makeAssistantMessage([{ name: "read", args: { path: "a.ts" } }]),
      makeAssistantMessage([{ name: "read", args: { path: "b.ts" } }]),
    ];
    expect(detectLoop(history, 10)).toBe(false);
  });

  it("detects pattern of length 1 (same call repeated)", () => {
    const call = { name: "read", args: { path: "a.ts" } };
    const history: AgentMessage[] = [];
    for (let i = 0; i < 10; i++) {
      history.push(makeAssistantMessage([call]));
    }
    expect(detectLoop(history, 10)).toBe(true);
  });

  it("detects pattern of length 2 (alternating pair)", () => {
    const callA = { name: "read", args: { path: "a.ts" } };
    const callB = { name: "write", args: { path: "b.ts", content: "x" } };
    const history: AgentMessage[] = [];
    for (let i = 0; i < 10; i++) {
      history.push(makeAssistantMessage([i % 2 === 0 ? callA : callB]));
    }
    expect(detectLoop(history, 10)).toBe(true);
  });

  it("detects pattern of length 3 (repeating triple)", () => {
    const calls = [
      { name: "read", args: { path: "a.ts" } },
      { name: "edit", args: { path: "a.ts", old: "x", new: "y" } },
      { name: "bash", args: { command: "npm test" } },
    ];
    const history: AgentMessage[] = [];
    // 9 calls = pattern of 3 repeated 3 times
    for (let i = 0; i < 9; i++) {
      history.push(makeAssistantMessage([calls[i % 3]!]));
    }
    expect(detectLoop(history, 9)).toBe(true);
  });

  it("returns false for non-repeating history", () => {
    const history: AgentMessage[] = [];
    for (let i = 0; i < 10; i++) {
      history.push(
        makeAssistantMessage([{ name: "read", args: { path: `file${i}.ts` } }]),
      );
    }
    expect(detectLoop(history, 10)).toBe(false);
  });

  it("handles multiple tool calls per assistant message", () => {
    // Each message has 2 tool calls, but the pattern repeats
    const history: AgentMessage[] = [];
    for (let i = 0; i < 5; i++) {
      history.push(
        makeAssistantMessage([
          { name: "read", args: { path: "a.ts" } },
          { name: "read", args: { path: "b.ts" } },
        ]),
      );
    }
    expect(detectLoop(history, 10)).toBe(true);
  });

  it("ignores non-assistant messages", () => {
    const history: AgentMessage[] = [];
    for (let i = 0; i < 10; i++) {
      history.push({ role: "user", content: "do something", timestamp: Date.now() });
      history.push(
        makeAssistantMessage([{ name: "read", args: { path: `file${i}.ts` } }]),
      );
    }
    // All different files, no loop
    expect(detectLoop(history, 10)).toBe(false);
  });
});
