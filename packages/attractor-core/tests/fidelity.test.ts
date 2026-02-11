import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { applyFidelity, resolveEffectiveFidelity, resolveThreadKey } from "../src/state/fidelity.js";
import { preparePipeline } from "../src/engine/pipeline.js";
import { PipelineRunner } from "../src/engine/runner.js";
import { Context } from "../src/state/context.js";
import { Checkpoint } from "../src/state/checkpoint.js";
import { StageStatus } from "../src/state/types.js";
import type { PipelineEvent } from "../src/events/index.js";

describe("applyFidelity", () => {
  const snapshot: Record<string, unknown> = {
    goal: "Build a widget",
    last_response: "A".repeat(1500),
    count: 42,
    "internal.retry_count.plan": 2,
    "internal.session_id": "abc123",
    short: "brief",
    nested: { a: 1, b: 2 },
  };

  describe("full mode", () => {
    it("returns all context as-is", () => {
      const result = applyFidelity(snapshot, "full");
      expect(result).toEqual(snapshot);
    });

    it("returns a shallow copy, not the same reference", () => {
      const result = applyFidelity(snapshot, "full");
      expect(result).not.toBe(snapshot);
    });
  });

  describe("truncate mode", () => {
    it("truncates long string values to 1000 chars", () => {
      const result = applyFidelity(snapshot, "truncate");
      const truncated = result["last_response"] as string;
      expect(truncated.length).toBe(1003); // 1000 + "..."
      expect(truncated.endsWith("...")).toBe(true);
    });

    it("preserves short strings unchanged", () => {
      const result = applyFidelity(snapshot, "truncate");
      expect(result["goal"]).toBe("Build a widget");
      expect(result["short"]).toBe("brief");
    });

    it("preserves non-string values", () => {
      const result = applyFidelity(snapshot, "truncate");
      expect(result["count"]).toBe(42);
      expect(result["nested"]).toEqual({ a: 1, b: 2 });
    });

    it("retains internal.* keys", () => {
      const result = applyFidelity(snapshot, "truncate");
      expect(result["internal.retry_count.plan"]).toBe(2);
      expect(result["internal.session_id"]).toBe("abc123");
    });
  });

  describe("compact mode", () => {
    it("removes internal.* keys", () => {
      const result = applyFidelity(snapshot, "compact");
      expect(result).not.toHaveProperty("internal.retry_count.plan");
      expect(result).not.toHaveProperty("internal.session_id");
    });

    it("truncates long string values to 1000 chars", () => {
      const result = applyFidelity(snapshot, "compact");
      const truncated = result["last_response"] as string;
      expect(truncated.length).toBe(1003);
      expect(truncated.endsWith("...")).toBe(true);
    });

    it("preserves non-internal short values", () => {
      const result = applyFidelity(snapshot, "compact");
      expect(result["goal"]).toBe("Build a widget");
      expect(result["count"]).toBe(42);
    });
  });

  describe("summary:low mode", () => {
    it("includes all keys with empty string values", () => {
      const result = applyFidelity(snapshot, "summary:low");
      for (const key of Object.keys(snapshot)) {
        expect(result).toHaveProperty(key);
        expect(result[key]).toBe("");
      }
    });
  });

  describe("summary:medium mode", () => {
    it("truncates string values to 100 chars", () => {
      const result = applyFidelity(snapshot, "summary:medium");
      const truncated = result["last_response"] as string;
      expect(truncated.length).toBe(103); // 100 + "..."
      expect(truncated.endsWith("...")).toBe(true);
    });

    it("preserves short strings unchanged", () => {
      const result = applyFidelity(snapshot, "summary:medium");
      expect(result["goal"]).toBe("Build a widget");
      expect(result["short"]).toBe("brief");
    });

    it("preserves non-string values", () => {
      const result = applyFidelity(snapshot, "summary:medium");
      expect(result["count"]).toBe(42);
    });
  });

  describe("summary:high mode", () => {
    it("truncates string values to 500 chars", () => {
      const result = applyFidelity(snapshot, "summary:high");
      const truncated = result["last_response"] as string;
      expect(truncated.length).toBe(503); // 500 + "..."
      expect(truncated.endsWith("...")).toBe(true);
    });

    it("preserves strings shorter than 500 chars", () => {
      const result = applyFidelity(snapshot, "summary:high");
      expect(result["goal"]).toBe("Build a widget");
    });
  });

  describe("default/invalid mode", () => {
    it("treats empty string as full mode", () => {
      const result = applyFidelity(snapshot, "");
      expect(result).toEqual(snapshot);
    });

    it("treats unrecognized mode as full mode", () => {
      const result = applyFidelity(snapshot, "nonexistent");
      expect(result).toEqual(snapshot);
    });
  });

  describe("edge cases", () => {
    it("handles empty snapshot", () => {
      const result = applyFidelity({}, "compact");
      expect(result).toEqual({});
    });

    it("handles snapshot where all keys are internal with compact mode", () => {
      const internalOnly = {
        "internal.a": 1,
        "internal.b": "hello",
      };
      const result = applyFidelity(internalOnly, "compact");
      expect(Object.keys(result)).toHaveLength(0);
    });

    it("does not truncate a string of exactly the limit length", () => {
      const exact = { value: "A".repeat(1000) };
      const result = applyFidelity(exact, "truncate");
      expect(result["value"]).toBe("A".repeat(1000));
    });

    it("truncates a string one char over the limit", () => {
      const overBy1 = { value: "A".repeat(1001) };
      const result = applyFidelity(overBy1, "truncate");
      const truncated = result["value"] as string;
      expect(truncated.length).toBe(1003);
      expect(truncated).toBe("A".repeat(1000) + "...");
    });
  });
});

describe("resolveEffectiveFidelity", () => {
  describe("precedence chain (spec §5.4)", () => {
    it("edge fidelity takes highest precedence", () => {
      expect(resolveEffectiveFidelity("truncate", "compact", "full")).toBe("truncate");
    });

    it("node fidelity takes second precedence when edge is empty", () => {
      expect(resolveEffectiveFidelity("", "compact", "full")).toBe("compact");
    });

    it("graph default takes third precedence when edge and node are empty", () => {
      expect(resolveEffectiveFidelity("", "", "truncate")).toBe("truncate");
    });

    it("defaults to compact when all are empty (spec §5.4)", () => {
      expect(resolveEffectiveFidelity("", "", "")).toBe("compact");
    });

    it("defaults to compact when all are invalid", () => {
      expect(resolveEffectiveFidelity("invalid", "also_invalid", "nope")).toBe("compact");
    });

    it("edge fidelity overrides valid node and graph fidelity", () => {
      expect(resolveEffectiveFidelity("summary:low", "full", "truncate")).toBe("summary:low");
    });

    it("skips invalid edge fidelity and falls to node", () => {
      expect(resolveEffectiveFidelity("bogus", "summary:high", "full")).toBe("summary:high");
    });

    it("skips invalid edge and node fidelity, falls to graph", () => {
      expect(resolveEffectiveFidelity("bogus", "bogus", "summary:medium")).toBe("summary:medium");
    });
  });

  describe("node fidelity resolution (backward compat)", () => {
    it("returns node fidelity when valid and no edge fidelity", () => {
      expect(resolveEffectiveFidelity("", "compact", "full")).toBe("compact");
    });

    it("falls back to graph default when node fidelity is empty", () => {
      expect(resolveEffectiveFidelity("", "", "truncate")).toBe("truncate");
    });

    it("falls back to graph default when node fidelity is invalid", () => {
      expect(resolveEffectiveFidelity("", "bogus", "summary:high")).toBe("summary:high");
    });
  });

  it("resolves all valid fidelity modes from edge level", () => {
    const modes = ["full", "truncate", "compact", "summary:low", "summary:medium", "summary:high"];
    for (const mode of modes) {
      expect(resolveEffectiveFidelity(mode, "", "")).toBe(mode);
    }
  });

  it("resolves all valid fidelity modes from node level", () => {
    const modes = ["full", "truncate", "compact", "summary:low", "summary:medium", "summary:high"];
    for (const mode of modes) {
      expect(resolveEffectiveFidelity("", mode, "")).toBe(mode);
    }
  });
});

describe("resolveThreadKey", () => {
  describe("precedence chain (spec §5.4)", () => {
    it("node thread_id takes highest precedence", () => {
      expect(resolveThreadKey({
        nodeThreadId: "node-thread",
        edgeThreadId: "edge-thread",
        graphDefaultThread: "graph-thread",
        subgraphClass: "subgraph-class",
        previousNodeId: "prev-node",
      })).toBe("node-thread");
    });

    it("edge thread_id takes second precedence", () => {
      expect(resolveThreadKey({
        nodeThreadId: "",
        edgeThreadId: "edge-thread",
        graphDefaultThread: "graph-thread",
        subgraphClass: "subgraph-class",
        previousNodeId: "prev-node",
      })).toBe("edge-thread");
    });

    it("graph default thread takes third precedence", () => {
      expect(resolveThreadKey({
        nodeThreadId: "",
        edgeThreadId: "",
        graphDefaultThread: "graph-thread",
        subgraphClass: "subgraph-class",
        previousNodeId: "prev-node",
      })).toBe("graph-thread");
    });

    it("subgraph class takes fourth precedence", () => {
      expect(resolveThreadKey({
        nodeThreadId: "",
        edgeThreadId: "",
        graphDefaultThread: "",
        subgraphClass: "subgraph-class",
        previousNodeId: "prev-node",
      })).toBe("subgraph-class");
    });

    it("previous node ID is final fallback", () => {
      expect(resolveThreadKey({
        nodeThreadId: "",
        edgeThreadId: "",
        graphDefaultThread: "",
        subgraphClass: "",
        previousNodeId: "prev-node",
      })).toBe("prev-node");
    });

    it("returns 'default' when all options are empty", () => {
      expect(resolveThreadKey({
        nodeThreadId: "",
        edgeThreadId: "",
        graphDefaultThread: "",
        subgraphClass: "",
        previousNodeId: "",
      })).toBe("default");
    });
  });
});

describe("Integration: edge fidelity resolution in runner", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "attractor-fidelity-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runner passes edge fidelity to context before handler execution", async () => {
    const { graph } = preparePipeline(`
      digraph FidelityEdge {
        graph [goal="Test edge fidelity"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [type="fidelity_check", prompt="A"]
        b [type="fidelity_check", prompt="B", fidelity="full"]
        start -> a
        a -> b [fidelity="truncate"]
        b -> exit
      }
    `);

    const capturedFidelities: Record<string, string> = {};
    const runner = new PipelineRunner({ logsRoot: tmpDir });
    runner.registerHandler("fidelity_check", {
      async execute(node, ctx, _graph, _logsRoot) {
        capturedFidelities[node.id] = ctx.getString("internal.incoming_edge_fidelity");
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { last_stage: node.id },
        };
      },
    });

    const result = await runner.run(graph);
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);

    // Edge from a -> b has fidelity="truncate", so b should see it
    // The edge to a (from start) has no fidelity, so a should see ""
    expect(capturedFidelities["a"]).toBe("");
    expect(capturedFidelities["b"]).toBe("truncate");
  });

  it("effective fidelity uses edge > node > graph > compact precedence", async () => {
    const { graph } = preparePipeline(`
      digraph FidelityPrecedence {
        graph [goal="Test precedence", default_fidelity="summary:low"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [type="fidelity_check", prompt="A"]
        b [type="fidelity_check", prompt="B", fidelity="full"]
        c [type="fidelity_check", prompt="C"]
        start -> a
        a -> b [fidelity="truncate"]
        b -> c -> exit
      }
    `);

    const capturedEffective: Record<string, string> = {};
    const runner = new PipelineRunner({ logsRoot: tmpDir });
    runner.registerHandler("fidelity_check", {
      async execute(node, ctx, _graph, _logsRoot) {
        capturedEffective[node.id] = ctx.getString("internal.effective_fidelity");
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { last_stage: node.id },
        };
      },
    });

    const result = await runner.run(graph);
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);

    // a: no edge fidelity, no node fidelity -> graph default "summary:low"
    expect(capturedEffective["a"]).toBe("summary:low");
    // b: edge fidelity="truncate" overrides node fidelity="full" and graph default
    expect(capturedEffective["b"]).toBe("truncate");
    // c: no edge fidelity, no node fidelity -> graph default "summary:low"
    expect(capturedEffective["c"]).toBe("summary:low");
  });
});

describe("Integration: thread resolution in runner", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "attractor-thread-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves thread key when fidelity is full", async () => {
    const { graph } = preparePipeline(`
      digraph ThreadTest {
        graph [goal="Test thread", default_fidelity="full"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [type="thread_check", prompt="A", thread_id="my-thread"]
        b [type="thread_check", prompt="B"]
        start -> a -> b -> exit
      }
    `);

    const capturedThreads: Record<string, string> = {};
    const runner = new PipelineRunner({ logsRoot: tmpDir });
    runner.registerHandler("thread_check", {
      async execute(node, ctx, _graph, _logsRoot) {
        capturedThreads[node.id] = ctx.getString("internal.thread_key");
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { last_stage: node.id },
        };
      },
    });

    const result = await runner.run(graph);
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);

    // a has thread_id="my-thread" and fidelity is full -> thread_key = "my-thread"
    expect(capturedThreads["a"]).toBe("my-thread");
    // b has no thread_id, no edge thread_id, no graph default_thread, no subgraph class
    // fallback is previous node ID = "a"
    expect(capturedThreads["b"]).toBe("a");
  });

  it("does not set thread key when fidelity is not full", async () => {
    const { graph } = preparePipeline(`
      digraph NoThread {
        graph [goal="Test no thread", default_fidelity="compact"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [type="thread_check", prompt="A"]
        start -> a -> exit
      }
    `);

    const capturedThreads: Record<string, string> = {};
    const runner = new PipelineRunner({ logsRoot: tmpDir });
    runner.registerHandler("thread_check", {
      async execute(node, ctx, _graph, _logsRoot) {
        capturedThreads[node.id] = ctx.getString("internal.thread_key");
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { last_stage: node.id },
        };
      },
    });

    const result = await runner.run(graph);
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);

    // fidelity is compact, so thread resolution should not have set thread_key
    expect(capturedThreads["a"]).toBe("");
  });

  it("uses edge thread_id when node has none", async () => {
    const { graph } = preparePipeline(`
      digraph EdgeThread {
        graph [goal="Test edge thread", default_fidelity="full"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [type="thread_check", prompt="A"]
        b [type="thread_check", prompt="B"]
        start -> a
        a -> b [thread_id="edge-thread"]
        b -> exit
      }
    `);

    const capturedThreads: Record<string, string> = {};
    const runner = new PipelineRunner({ logsRoot: tmpDir });
    runner.registerHandler("thread_check", {
      async execute(node, ctx, _graph, _logsRoot) {
        capturedThreads[node.id] = ctx.getString("internal.thread_key");
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { last_stage: node.id },
        };
      },
    });

    const result = await runner.run(graph);
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);

    // b: node has no thread_id, edge has thread_id="edge-thread"
    expect(capturedThreads["b"]).toBe("edge-thread");
  });
});

describe("Integration: resume fidelity degradation (spec §5.3 point 6)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "attractor-degrade-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("degrades first resumed node to summary:high when last node used full fidelity", async () => {
    const DOT = `
      digraph DegradeResume {
        graph [goal="Test degrade", default_fidelity="full"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [type="fidelity_check", prompt="A"]
        b [type="fidelity_check", prompt="B"]
        c [type="fidelity_check", prompt="C"]
        start -> a -> b -> c -> exit
      }
    `;
    const { graph } = preparePipeline(DOT);

    // Create a checkpoint after "a" — "a" had full fidelity (graph default)
    const checkpointDir = fs.mkdtempSync(path.join(os.tmpdir(), "degrade-cp-"));
    const cp = new Checkpoint({
      currentNode: "a",
      completedNodes: ["start", "a"],
      context: { "graph.goal": "Test degrade", outcome: "success", last_stage: "a" },
      nodeRetries: {},
    });
    cp.save(checkpointDir);

    const capturedFidelities: Record<string, string> = {};
    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      resumeFrom: checkpointDir,
    });
    runner.registerHandler("fidelity_check", {
      async execute(node, ctx, _graph, _logsRoot) {
        capturedFidelities[node.id] = ctx.getString("internal.effective_fidelity");
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { last_stage: node.id },
        };
      },
    });

    const result = await runner.run(graph);
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);

    // b is the first node after resume — should be degraded to summary:high
    expect(capturedFidelities["b"]).toBe("summary:high");
    // c is the second node — should NOT be degraded, uses graph default (full)
    expect(capturedFidelities["c"]).toBe("full");

    fs.rmSync(checkpointDir, { recursive: true, force: true });
  });

  it("does not degrade when last completed node did not use full fidelity", async () => {
    const DOT = `
      digraph NoDegradeResume {
        graph [goal="Test no degrade", default_fidelity="compact"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [type="fidelity_check", prompt="A"]
        b [type="fidelity_check", prompt="B"]
        start -> a -> b -> exit
      }
    `;
    const { graph } = preparePipeline(DOT);

    // Checkpoint after "a" — "a" had compact fidelity (graph default)
    const checkpointDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodegrade-cp-"));
    const cp = new Checkpoint({
      currentNode: "a",
      completedNodes: ["start", "a"],
      context: { "graph.goal": "Test no degrade", outcome: "success", last_stage: "a" },
      nodeRetries: {},
    });
    cp.save(checkpointDir);

    const capturedFidelities: Record<string, string> = {};
    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      resumeFrom: checkpointDir,
    });
    runner.registerHandler("fidelity_check", {
      async execute(node, ctx, _graph, _logsRoot) {
        capturedFidelities[node.id] = ctx.getString("internal.effective_fidelity");
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { last_stage: node.id },
        };
      },
    });

    const result = await runner.run(graph);
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);

    // b should NOT be degraded — last node used compact, not full
    expect(capturedFidelities["b"]).toBe("compact");

    fs.rmSync(checkpointDir, { recursive: true, force: true });
  });

  it("degrades only the first node, subsequent nodes resume normal fidelity", async () => {
    const DOT = `
      digraph OnlyFirstDegrade {
        graph [goal="Test one-hop degrade", default_fidelity="full"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        a [type="fidelity_check", prompt="A"]
        b [type="fidelity_check", prompt="B"]
        c [type="fidelity_check", prompt="C"]
        d [type="fidelity_check", prompt="D"]
        start -> a -> b -> c -> d -> exit
      }
    `;
    const { graph } = preparePipeline(DOT);

    const checkpointDir = fs.mkdtempSync(path.join(os.tmpdir(), "onehop-cp-"));
    const cp = new Checkpoint({
      currentNode: "a",
      completedNodes: ["start", "a"],
      context: { "graph.goal": "Test one-hop degrade", outcome: "success", last_stage: "a" },
      nodeRetries: {},
    });
    cp.save(checkpointDir);

    const capturedFidelities: Record<string, string> = {};
    const runner = new PipelineRunner({
      logsRoot: tmpDir,
      resumeFrom: checkpointDir,
    });
    runner.registerHandler("fidelity_check", {
      async execute(node, ctx, _graph, _logsRoot) {
        capturedFidelities[node.id] = ctx.getString("internal.effective_fidelity");
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { last_stage: node.id },
        };
      },
    });

    const result = await runner.run(graph);
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);

    // Only b (first after resume) should be degraded
    expect(capturedFidelities["b"]).toBe("summary:high");
    // c and d should use normal full fidelity
    expect(capturedFidelities["c"]).toBe("full");
    expect(capturedFidelities["d"]).toBe("full");

    fs.rmSync(checkpointDir, { recursive: true, force: true });
  });
});
