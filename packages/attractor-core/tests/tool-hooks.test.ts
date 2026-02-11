import { describe, it, expect } from "vitest";
import { ToolHandler } from "../src/handlers/handlers.js";
import { Context } from "../src/state/context.js";
import { StageStatus } from "../src/state/types.js";
import type { GraphNode } from "../src/model/graph.js";
import type { Graph } from "../src/model/graph.js";

/** Helper to create a minimal tool GraphNode */
function makeToolNode(
  overrides: Partial<GraphNode> & { attrs?: Record<string, unknown> } = {},
): GraphNode {
  return {
    id: "tool1",
    label: "Tool",
    shape: "parallelogram",
    type: "tool",
    prompt: "",
    maxRetries: 0,
    goalGate: false,
    retryTarget: "",
    fallbackRetryTarget: "",
    fidelity: "",
    threadId: "",
    classes: [],
    timeout: null,
    llmModel: "",
    llmProvider: "",
    reasoningEffort: "high",
    autoStatus: false,
    allowPartial: false,
    attrs: {},
    ...overrides,
  };
}

/** Minimal Graph stub for handler execute signature */
const stubGraph = {} as Graph;

describe("ToolHandler: pre_hook and post_hook (spec §9.7)", () => {
  it("tool without hooks still works (backward compatibility)", async () => {
    const handler = new ToolHandler();
    const node = makeToolNode({
      attrs: { tool_command: "echo hello" },
    });
    const ctx = new Context();
    const result = await handler.execute(node, ctx, stubGraph, "/tmp");

    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(result.contextUpdates?.["tool.output"]).toContain("hello");
    expect(result.notes).toContain("Tool completed");
  });

  it("pre_hook runs before tool_command", async () => {
    const handler = new ToolHandler();
    // pre_hook writes to a marker; tool_command reads it
    // We use echo to verify ordering via captured notes
    const node = makeToolNode({
      attrs: {
        pre_hook: "echo pre_ran",
        tool_command: "echo main_ran",
      },
    });
    const ctx = new Context();
    const result = await handler.execute(node, ctx, stubGraph, "/tmp");

    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(result.notes).toContain("pre_hook output: pre_ran");
    expect(result.notes).toContain("Tool completed");
    // pre_hook output appears before tool completed in notes
    const preIdx = result.notes!.indexOf("pre_hook output");
    const toolIdx = result.notes!.indexOf("Tool completed");
    expect(preIdx).toBeLessThan(toolIdx);
  });

  it("post_hook runs after tool_command", async () => {
    const handler = new ToolHandler();
    const node = makeToolNode({
      attrs: {
        tool_command: "echo main_ran",
        post_hook: "echo post_ran",
      },
    });
    const ctx = new Context();
    const result = await handler.execute(node, ctx, stubGraph, "/tmp");

    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(result.notes).toContain("post_hook output: post_ran");
    expect(result.notes).toContain("Tool completed");
    // Tool completed appears before post_hook output in notes
    const toolIdx = result.notes!.indexOf("Tool completed");
    const postIdx = result.notes!.indexOf("post_hook output");
    expect(toolIdx).toBeLessThan(postIdx);
  });

  it("pre_hook failure prevents tool_command from running", async () => {
    const handler = new ToolHandler();
    const node = makeToolNode({
      attrs: {
        pre_hook: "exit 1",
        tool_command: "echo should_not_run",
      },
    });
    const ctx = new Context();
    const result = await handler.execute(node, ctx, stubGraph, "/tmp");

    expect(result.status).toBe(StageStatus.FAIL);
    expect(result.failureReason).toContain("pre_hook failed");
    expect(result.notes).toContain("pre_hook command: exit 1");
    // The main command output should NOT appear
    expect(result.contextUpdates?.["tool.output"]).toBeUndefined();
  });

  it("post_hook failure does not fail the tool", async () => {
    const handler = new ToolHandler();
    const node = makeToolNode({
      attrs: {
        tool_command: "echo main_ran",
        post_hook: "exit 1",
      },
    });
    const ctx = new Context();
    const result = await handler.execute(node, ctx, stubGraph, "/tmp");

    // Tool should still succeed even though post_hook failed
    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(result.contextUpdates?.["tool.output"]).toContain("main_ran");
    expect(result.notes).toContain("post_hook failed");
  });

  it("both hooks together run in correct order", async () => {
    const handler = new ToolHandler();
    const node = makeToolNode({
      attrs: {
        pre_hook: "echo pre",
        tool_command: "echo main",
        post_hook: "echo post",
      },
    });
    const ctx = new Context();
    const result = await handler.execute(node, ctx, stubGraph, "/tmp");

    expect(result.status).toBe(StageStatus.SUCCESS);
    expect(result.notes).toContain("pre_hook output: pre");
    expect(result.notes).toContain("Tool completed");
    expect(result.notes).toContain("post_hook output: post");

    // Verify ordering: pre < tool < post
    const preIdx = result.notes!.indexOf("pre_hook output");
    const toolIdx = result.notes!.indexOf("Tool completed");
    const postIdx = result.notes!.indexOf("post_hook output");
    expect(preIdx).toBeLessThan(toolIdx);
    expect(toolIdx).toBeLessThan(postIdx);
  });

  it("hooks respect the same timeout as the tool", async () => {
    const handler = new ToolHandler();
    // Set a very short timeout; pre_hook sleeps longer
    const node = makeToolNode({
      timeout: 100, // 100ms timeout
      attrs: {
        pre_hook: "sleep 10",
        tool_command: "echo main",
      },
    });
    const ctx = new Context();
    const result = await handler.execute(node, ctx, stubGraph, "/tmp");

    expect(result.status).toBe(StageStatus.FAIL);
    expect(result.failureReason).toContain("pre_hook failed");
  });

  it("tool_command failure with post_hook does not run post_hook", async () => {
    const handler = new ToolHandler();
    const node = makeToolNode({
      attrs: {
        tool_command: "exit 1",
        post_hook: "echo post_should_not_run",
      },
    });
    const ctx = new Context();
    const result = await handler.execute(node, ctx, stubGraph, "/tmp");

    // Tool should fail because the main command failed
    expect(result.status).toBe(StageStatus.FAIL);
    // post_hook should NOT appear in notes because tool_command failed first
    expect(result.notes ?? "").not.toContain("post_hook");
  });

  it("no tool_command still fails even with hooks defined", async () => {
    const handler = new ToolHandler();
    const node = makeToolNode({
      attrs: {
        pre_hook: "echo pre",
        post_hook: "echo post",
      },
    });
    const ctx = new Context();
    const result = await handler.execute(node, ctx, stubGraph, "/tmp");

    expect(result.status).toBe(StageStatus.FAIL);
    expect(result.failureReason).toBe("No tool_command specified");
  });
});
