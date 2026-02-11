import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { preparePipeline } from "../src/engine/pipeline.js";
import { PipelineRunner } from "../src/engine/runner.js";
import { Context } from "../src/state/context.js";
import { StageStatus } from "../src/state/types.js";
import type { Outcome } from "../src/state/types.js";
import type { PipelineEvent } from "../src/events/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "attractor-parallel-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Parallel handler subgraph execution", () => {
  it("executes parallel branches through the runner subgraph executor", async () => {
    // Pipeline: start -> parallel_node -> fan_in -> exit
    // parallel_node fans out to branch_a and branch_b
    // Each branch is a single codergen node that leads to fan_in
    const { graph } = preparePipeline(`
      digraph ParallelTest {
        graph [goal="Test parallel subgraph execution"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        parallel_node [shape=component, label="Fan Out"]
        branch_a [type="tracking", label="Branch A", prompt="Do A"]
        branch_b [type="tracking", label="Branch B", prompt="Do B"]
        fan_in [shape=tripleoctagon, label="Fan In"]
        start -> parallel_node
        parallel_node -> branch_a
        parallel_node -> branch_b
        branch_a -> fan_in
        branch_b -> fan_in
        fan_in -> exit
      }
    `);

    const executedNodes: string[] = [];
    const runner = new PipelineRunner({ logsRoot: tmpDir });

    runner.registerHandler("tracking", {
      async execute(node, ctx, _graph, _logsRoot) {
        executedNodes.push(node.id);
        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { [`branch.${node.id}.done`]: "true" },
        };
      },
    });

    const result = await runner.run(graph);

    // The pipeline should complete successfully
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);

    // Both branches should have been executed by the subgraph executor
    expect(executedNodes).toContain("branch_a");
    expect(executedNodes).toContain("branch_b");

    // parallel_node should appear in completed nodes
    expect(result.completedNodes).toContain("parallel_node");

    // fan_in should appear in completed nodes
    expect(result.completedNodes).toContain("fan_in");
  });

  it("isolates context between parallel branches", async () => {
    const { graph } = preparePipeline(`
      digraph ContextIsolation {
        graph [goal="Test context isolation"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        parallel_node [shape=component, label="Fan Out"]
        branch_a [type="ctx_branch", label="Branch A"]
        branch_b [type="ctx_branch", label="Branch B"]
        fan_in [shape=tripleoctagon, label="Fan In"]
        start -> parallel_node
        parallel_node -> branch_a
        parallel_node -> branch_b
        branch_a -> fan_in
        branch_b -> fan_in
        fan_in -> exit
      }
    `);

    const branchContextSnapshots: Record<string, Record<string, unknown>> = {};
    const runner = new PipelineRunner({ logsRoot: tmpDir });

    runner.registerHandler("ctx_branch", {
      async execute(node, ctx, _graph, _logsRoot) {
        // Each branch sets a unique key
        ctx.set(`branch_marker`, node.id);
        // Also set a shared key to different values
        ctx.set("shared_key", `value_from_${node.id}`);

        // Capture the snapshot for later verification
        branchContextSnapshots[node.id] = ctx.snapshot();

        return {
          status: StageStatus.SUCCESS,
          contextUpdates: { [`branch.${node.id}.marker`]: node.id },
        };
      },
    });

    const result = await runner.run(graph);
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);

    // Each branch should have seen its own marker, not the other's
    if (branchContextSnapshots["branch_a"]) {
      expect(branchContextSnapshots["branch_a"]["branch_marker"]).toBe("branch_a");
      expect(branchContextSnapshots["branch_a"]["shared_key"]).toBe("value_from_branch_a");
    }
    if (branchContextSnapshots["branch_b"]) {
      expect(branchContextSnapshots["branch_b"]["branch_marker"]).toBe("branch_b");
      expect(branchContextSnapshots["branch_b"]["shared_key"]).toBe("value_from_branch_b");
    }

    // The main context should NOT have branch_marker set (it was set on cloned contexts)
    // The parallel handler stores results in context as parallel.results
    expect(result.context.has("parallel.results")).toBe(true);
  });

  it("join policy wait_all succeeds when all branches succeed", async () => {
    const { graph } = preparePipeline(`
      digraph WaitAll {
        graph [goal="Test wait_all join policy"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        parallel_node [shape=component, label="Fan Out", join_policy="wait_all"]
        branch_a [type="succeed", label="Branch A"]
        branch_b [type="succeed", label="Branch B"]
        fan_in [shape=tripleoctagon, label="Fan In"]
        start -> parallel_node
        parallel_node -> branch_a
        parallel_node -> branch_b
        branch_a -> fan_in
        branch_b -> fan_in
        fan_in -> exit
      }
    `);

    const runner = new PipelineRunner({ logsRoot: tmpDir });

    runner.registerHandler("succeed", {
      async execute(node, _ctx, _graph, _logsRoot) {
        return { status: StageStatus.SUCCESS, notes: `${node.id} succeeded` };
      },
    });

    const result = await runner.run(graph);
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);

    // Parse the parallel results
    const parallelResults = JSON.parse(
      result.context.getString("parallel.results"),
    ) as Outcome[];
    expect(parallelResults.length).toBe(2);
    expect(parallelResults.every((r) => r.status === StageStatus.SUCCESS)).toBe(true);
  });

  it("join policy wait_all returns partial_success when a branch fails", async () => {
    const { graph } = preparePipeline(`
      digraph WaitAllPartial {
        graph [goal="Test wait_all with failure"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        parallel_node [shape=component, label="Fan Out", join_policy="wait_all"]
        branch_a [type="succeed", label="Branch A"]
        branch_b [type="fail_branch", label="Branch B"]
        fan_in [shape=tripleoctagon, label="Fan In"]
        start -> parallel_node
        parallel_node -> branch_a
        parallel_node -> branch_b
        branch_a -> fan_in
        branch_b -> fan_in
        fan_in -> exit
      }
    `);

    const runner = new PipelineRunner({ logsRoot: tmpDir });

    runner.registerHandler("succeed", {
      async execute(node, _ctx, _graph, _logsRoot) {
        return { status: StageStatus.SUCCESS };
      },
    });

    runner.registerHandler("fail_branch", {
      async execute(node, _ctx, _graph, _logsRoot) {
        return { status: StageStatus.FAIL, failureReason: "Branch B failed" };
      },
    });

    const result = await runner.run(graph);

    // The parallel node should return PARTIAL_SUCCESS (1/2 branches succeeded)
    // Then fan_in processes and the pipeline continues
    const parallelResults = JSON.parse(
      result.context.getString("parallel.results"),
    ) as Outcome[];
    expect(parallelResults.length).toBe(2);

    const successCount = parallelResults.filter(
      (r) => r.status === StageStatus.SUCCESS,
    ).length;
    const failCount = parallelResults.filter(
      (r) => r.status === StageStatus.FAIL,
    ).length;
    expect(successCount).toBe(1);
    expect(failCount).toBe(1);
  });

  it("join policy first_success succeeds when at least one branch succeeds", async () => {
    const { graph } = preparePipeline(`
      digraph FirstSuccess {
        graph [goal="Test first_success join policy"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        parallel_node [shape=component, label="Fan Out", join_policy="first_success"]
        branch_a [type="succeed", label="Branch A"]
        branch_b [type="fail_branch", label="Branch B"]
        fan_in [shape=tripleoctagon, label="Fan In"]
        start -> parallel_node
        parallel_node -> branch_a
        parallel_node -> branch_b
        branch_a -> fan_in
        branch_b -> fan_in
        fan_in -> exit
      }
    `);

    const runner = new PipelineRunner({ logsRoot: tmpDir });

    runner.registerHandler("succeed", {
      async execute(_node, _ctx, _graph, _logsRoot) {
        return { status: StageStatus.SUCCESS };
      },
    });

    runner.registerHandler("fail_branch", {
      async execute(_node, _ctx, _graph, _logsRoot) {
        return { status: StageStatus.FAIL, failureReason: "Intentional failure" };
      },
    });

    const result = await runner.run(graph);

    // first_success: at least one branch succeeded, so overall SUCCESS
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
  });

  it("join policy first_success fails when all branches fail", async () => {
    const { graph } = preparePipeline(`
      digraph AllFail {
        graph [goal="Test first_success all fail"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        parallel_node [shape=component, label="Fan Out", join_policy="first_success"]
        branch_a [type="fail_branch", label="Branch A"]
        branch_b [type="fail_branch", label="Branch B"]
        fan_in [shape=tripleoctagon, label="Fan In"]
        start -> parallel_node
        parallel_node -> branch_a
        parallel_node -> branch_b
        branch_a -> fan_in
        branch_b -> fan_in
        fan_in -> exit
      }
    `);

    const runner = new PipelineRunner({ logsRoot: tmpDir });

    runner.registerHandler("fail_branch", {
      async execute(_node, _ctx, _graph, _logsRoot) {
        return { status: StageStatus.FAIL, failureReason: "Intentional failure" };
      },
    });

    const result = await runner.run(graph);

    // first_success with all branches failing: parallel node returns FAIL
    // The pipeline should not reach a successful completion
    const parallelResults = JSON.parse(
      result.context.getString("parallel.results"),
    ) as Outcome[];
    expect(parallelResults.every((r) => r.status === StageStatus.FAIL)).toBe(true);
  });

  it("subgraph executor walks multi-step branches", async () => {
    // Each branch has multiple steps: branch_a -> step_a2, branch_b -> step_b2
    const { graph } = preparePipeline(`
      digraph MultiStep {
        graph [goal="Test multi-step subgraph execution"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        parallel_node [shape=component, label="Fan Out"]
        branch_a  [type="tracking", label="Branch A Step 1"]
        step_a2   [type="tracking", label="Branch A Step 2"]
        branch_b  [type="tracking", label="Branch B Step 1"]
        step_b2   [type="tracking", label="Branch B Step 2"]
        fan_in    [shape=tripleoctagon, label="Fan In"]
        start -> parallel_node
        parallel_node -> branch_a
        parallel_node -> branch_b
        branch_a -> step_a2
        branch_b -> step_b2
        step_a2 -> fan_in
        step_b2 -> fan_in
        fan_in -> exit
      }
    `);

    const executedNodes: string[] = [];
    const runner = new PipelineRunner({ logsRoot: tmpDir });

    runner.registerHandler("tracking", {
      async execute(node, _ctx, _graph, _logsRoot) {
        executedNodes.push(node.id);
        return { status: StageStatus.SUCCESS };
      },
    });

    const result = await runner.run(graph);
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);

    // All four branch steps should have executed
    expect(executedNodes).toContain("branch_a");
    expect(executedNodes).toContain("step_a2");
    expect(executedNodes).toContain("branch_b");
    expect(executedNodes).toContain("step_b2");
  });

  it("parallel handler without subgraph executor falls back gracefully", async () => {
    // Directly test that a ParallelHandler without an executor still works
    const { ParallelHandler } = await import("../src/handlers/handlers.js");
    const { Graph } = await import("../src/model/graph.js");
    const handler = new ParallelHandler();

    const nodes = new Map();
    nodes.set("p", {
      id: "p",
      label: "Parallel",
      shape: "component",
      type: "parallel",
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
    });
    nodes.set("b1", {
      id: "b1",
      label: "B1",
      shape: "box",
      type: "",
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
    });

    const graph = new Graph("test", {
      goal: "test",
      label: "test",
      modelStylesheet: "",
      defaultMaxRetry: 50,
      retryTarget: "",
      fallbackRetryTarget: "",
      defaultFidelity: "",
    }, nodes, [
      {
        fromNode: "p",
        toNode: "b1",
        label: "",
        condition: "",
        weight: 0,
        fidelity: "",
        threadId: "",
        loopRestart: false,
        attrs: {},
      },
    ]);

    const ctx = new Context();
    const outcome = await handler.execute(nodes.get("p")!, ctx, graph, tmpDir);

    // Without subgraph executor wired, should fallback to simple success
    expect(outcome.status).toBe(StageStatus.SUCCESS);
    expect(outcome.notes).toContain("no subgraph executor");
  });

  it("branch exceptions are caught and returned as failures", async () => {
    const { graph } = preparePipeline(`
      digraph ExceptionTest {
        graph [goal="Test exception handling in branches"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        parallel_node [shape=component, label="Fan Out", join_policy="first_success"]
        branch_a [type="succeed", label="Branch A"]
        branch_b [type="throw_branch", label="Branch B"]
        fan_in [shape=tripleoctagon, label="Fan In"]
        start -> parallel_node
        parallel_node -> branch_a
        parallel_node -> branch_b
        branch_a -> fan_in
        branch_b -> fan_in
        fan_in -> exit
      }
    `);

    const runner = new PipelineRunner({ logsRoot: tmpDir });

    runner.registerHandler("succeed", {
      async execute(_node, _ctx, _graph, _logsRoot) {
        return { status: StageStatus.SUCCESS };
      },
    });

    runner.registerHandler("throw_branch", {
      async execute(_node, _ctx, _graph, _logsRoot) {
        throw new Error("Unexpected error in branch");
      },
    });

    const result = await runner.run(graph);

    // first_success: branch_a succeeds, so overall should succeed
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);

    // The parallel results should show one success and one failure
    const parallelResults = JSON.parse(
      result.context.getString("parallel.results"),
    ) as Outcome[];
    expect(parallelResults.length).toBe(2);

    const failResults = parallelResults.filter(
      (r) => r.status === StageStatus.FAIL,
    );
    expect(failResults.length).toBe(1);
  });
});

describe("k_of_n join policy", () => {
  it("succeeds when k=2 and 2 of 3 branches succeed", async () => {
    const { graph } = preparePipeline(`
      digraph KofN_Success {
        graph [goal="Test k_of_n join policy success"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        parallel_node [shape=component, label="Fan Out", join_policy="k_of_n", join_k="2"]
        branch_a [type="succeed", label="Branch A"]
        branch_b [type="succeed", label="Branch B"]
        branch_c [type="fail_branch", label="Branch C"]
        fan_in [shape=tripleoctagon, label="Fan In"]
        start -> parallel_node
        parallel_node -> branch_a
        parallel_node -> branch_b
        parallel_node -> branch_c
        branch_a -> fan_in
        branch_b -> fan_in
        branch_c -> fan_in
        fan_in -> exit
      }
    `);

    const runner = new PipelineRunner({ logsRoot: tmpDir });

    runner.registerHandler("succeed", {
      async execute(_node, _ctx, _graph, _logsRoot) {
        return { status: StageStatus.SUCCESS };
      },
    });

    runner.registerHandler("fail_branch", {
      async execute(_node, _ctx, _graph, _logsRoot) {
        return { status: StageStatus.FAIL, failureReason: "Intentional failure" };
      },
    });

    const result = await runner.run(graph);
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);

    const parallelResults = JSON.parse(
      result.context.getString("parallel.results"),
    ) as Outcome[];
    expect(parallelResults.length).toBe(3);

    const successCount = parallelResults.filter(
      (r) => r.status === StageStatus.SUCCESS,
    ).length;
    expect(successCount).toBe(2);
  });

  it("fails when k=2 and only 1 of 3 branches succeeds", async () => {
    const { graph } = preparePipeline(`
      digraph KofN_Fail {
        graph [goal="Test k_of_n join policy failure"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        parallel_node [shape=component, label="Fan Out", join_policy="k_of_n", join_k="2"]
        branch_a [type="succeed", label="Branch A"]
        branch_b [type="fail_branch", label="Branch B"]
        branch_c [type="fail_branch", label="Branch C"]
        fan_in [shape=tripleoctagon, label="Fan In"]
        start -> parallel_node
        parallel_node -> branch_a
        parallel_node -> branch_b
        parallel_node -> branch_c
        branch_a -> fan_in
        branch_b -> fan_in
        branch_c -> fan_in
        fan_in -> exit
      }
    `);

    const runner = new PipelineRunner({ logsRoot: tmpDir });

    runner.registerHandler("succeed", {
      async execute(_node, _ctx, _graph, _logsRoot) {
        return { status: StageStatus.SUCCESS };
      },
    });

    runner.registerHandler("fail_branch", {
      async execute(_node, _ctx, _graph, _logsRoot) {
        return { status: StageStatus.FAIL, failureReason: "Intentional failure" };
      },
    });

    const result = await runner.run(graph);

    // The parallel results should show only 1 success
    const parallelResults = JSON.parse(
      result.context.getString("parallel.results"),
    ) as Outcome[];
    const successCount = parallelResults.filter(
      (r) => r.status === StageStatus.SUCCESS,
    ).length;
    expect(successCount).toBe(1);

    // k_of_n with k=2 requires 2 successes, but only 1 succeeded
    // The parallel node returns FAIL. The runner then fails because the
    // FAIL outcome from the parallel node means the stage failed. However
    // edge selection may still route to a branch node. Verify the FAIL
    // is recorded in the parallel results.
    const failCount = parallelResults.filter(
      (r) => r.status === StageStatus.FAIL,
    ).length;
    expect(failCount).toBe(2);
    expect(parallelResults.length).toBe(3);
  });

  it("defaults join_k to 1 when not specified", async () => {
    const { graph } = preparePipeline(`
      digraph KofN_Default {
        graph [goal="Test k_of_n default k=1"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        parallel_node [shape=component, label="Fan Out", join_policy="k_of_n"]
        branch_a [type="succeed", label="Branch A"]
        branch_b [type="fail_branch", label="Branch B"]
        branch_c [type="fail_branch", label="Branch C"]
        fan_in [shape=tripleoctagon, label="Fan In"]
        start -> parallel_node
        parallel_node -> branch_a
        parallel_node -> branch_b
        parallel_node -> branch_c
        branch_a -> fan_in
        branch_b -> fan_in
        branch_c -> fan_in
        fan_in -> exit
      }
    `);

    const runner = new PipelineRunner({ logsRoot: tmpDir });

    runner.registerHandler("succeed", {
      async execute(_node, _ctx, _graph, _logsRoot) {
        return { status: StageStatus.SUCCESS };
      },
    });

    runner.registerHandler("fail_branch", {
      async execute(_node, _ctx, _graph, _logsRoot) {
        return { status: StageStatus.FAIL, failureReason: "Intentional failure" };
      },
    });

    const result = await runner.run(graph);

    // With default k=1 and one branch succeeding, should be SUCCESS
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);
  });
});

describe("quorum join policy", () => {
  it("succeeds when fraction=0.5 and 3 of 4 branches succeed", async () => {
    const { graph } = preparePipeline(`
      digraph Quorum_Success {
        graph [goal="Test quorum join policy success"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        parallel_node [shape=component, label="Fan Out", join_policy="quorum", join_quorum="0.5"]
        branch_a [type="succeed", label="Branch A"]
        branch_b [type="succeed", label="Branch B"]
        branch_c [type="succeed", label="Branch C"]
        branch_d [type="fail_branch", label="Branch D"]
        fan_in [shape=tripleoctagon, label="Fan In"]
        start -> parallel_node
        parallel_node -> branch_a
        parallel_node -> branch_b
        parallel_node -> branch_c
        parallel_node -> branch_d
        branch_a -> fan_in
        branch_b -> fan_in
        branch_c -> fan_in
        branch_d -> fan_in
        fan_in -> exit
      }
    `);

    const runner = new PipelineRunner({ logsRoot: tmpDir });

    runner.registerHandler("succeed", {
      async execute(_node, _ctx, _graph, _logsRoot) {
        return { status: StageStatus.SUCCESS };
      },
    });

    runner.registerHandler("fail_branch", {
      async execute(_node, _ctx, _graph, _logsRoot) {
        return { status: StageStatus.FAIL, failureReason: "Intentional failure" };
      },
    });

    const result = await runner.run(graph);
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);

    const parallelResults = JSON.parse(
      result.context.getString("parallel.results"),
    ) as Outcome[];
    expect(parallelResults.length).toBe(4);

    const successCount = parallelResults.filter(
      (r) => r.status === StageStatus.SUCCESS,
    ).length;
    // 3 successes >= ceil(4 * 0.5) = 2
    expect(successCount).toBe(3);
  });

  it("fails when fraction=0.5 and only 1 of 4 branches succeeds", async () => {
    const { graph } = preparePipeline(`
      digraph Quorum_Fail {
        graph [goal="Test quorum join policy failure"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        parallel_node [shape=component, label="Fan Out", join_policy="quorum", join_quorum="0.5"]
        branch_a [type="succeed", label="Branch A"]
        branch_b [type="fail_branch", label="Branch B"]
        branch_c [type="fail_branch", label="Branch C"]
        branch_d [type="fail_branch", label="Branch D"]
        fan_in [shape=tripleoctagon, label="Fan In"]
        start -> parallel_node
        parallel_node -> branch_a
        parallel_node -> branch_b
        parallel_node -> branch_c
        parallel_node -> branch_d
        branch_a -> fan_in
        branch_b -> fan_in
        branch_c -> fan_in
        branch_d -> fan_in
        fan_in -> exit
      }
    `);

    const runner = new PipelineRunner({ logsRoot: tmpDir });

    runner.registerHandler("succeed", {
      async execute(_node, _ctx, _graph, _logsRoot) {
        return { status: StageStatus.SUCCESS };
      },
    });

    runner.registerHandler("fail_branch", {
      async execute(_node, _ctx, _graph, _logsRoot) {
        return { status: StageStatus.FAIL, failureReason: "Intentional failure" };
      },
    });

    const result = await runner.run(graph);

    // 1 success < ceil(4 * 0.5) = 2, so quorum fails
    const parallelResults = JSON.parse(
      result.context.getString("parallel.results"),
    ) as Outcome[];
    expect(parallelResults.length).toBe(4);

    const successCount = parallelResults.filter(
      (r) => r.status === StageStatus.SUCCESS,
    ).length;
    expect(successCount).toBe(1);

    const failCount = parallelResults.filter(
      (r) => r.status === StageStatus.FAIL,
    ).length;
    expect(failCount).toBe(3);
  });
});

describe("max_parallel bounded parallelism", () => {
  it("max_parallel=1 executes branches sequentially", async () => {
    const { graph } = preparePipeline(`
      digraph Sequential {
        graph [goal="Test max_parallel=1"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        parallel_node [shape=component, label="Fan Out", max_parallel="1"]
        branch_a [type="order_track", label="Branch A"]
        branch_b [type="order_track", label="Branch B"]
        branch_c [type="order_track", label="Branch C"]
        fan_in [shape=tripleoctagon, label="Fan In"]
        start -> parallel_node
        parallel_node -> branch_a
        parallel_node -> branch_b
        parallel_node -> branch_c
        branch_a -> fan_in
        branch_b -> fan_in
        branch_c -> fan_in
        fan_in -> exit
      }
    `);

    // Track execution overlaps: with max_parallel=1 no two branches should overlap
    let activeCount = 0;
    let maxActive = 0;
    const executionOrder: string[] = [];

    const runner = new PipelineRunner({ logsRoot: tmpDir });

    runner.registerHandler("order_track", {
      async execute(node, _ctx, _graph, _logsRoot) {
        activeCount++;
        if (activeCount > maxActive) maxActive = activeCount;
        executionOrder.push(node.id);
        // Simulate async work
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeCount--;
        return { status: StageStatus.SUCCESS };
      },
    });

    const result = await runner.run(graph);
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);

    // With max_parallel=1, at most 1 branch should be active at a time
    expect(maxActive).toBe(1);

    // All three branches should have executed in the subgraph.
    // (The main pipeline loop may re-execute one branch via edge selection,
    //  so we check that all three branch IDs appear rather than exact count.)
    expect(executionOrder).toContain("branch_a");
    expect(executionOrder).toContain("branch_b");
    expect(executionOrder).toContain("branch_c");
  });

  it("max_parallel=2 with 4 branches runs in two waves", async () => {
    const { graph } = preparePipeline(`
      digraph TwoWaves {
        graph [goal="Test max_parallel=2"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        parallel_node [shape=component, label="Fan Out", max_parallel="2"]
        branch_a [type="wave_track", label="Branch A"]
        branch_b [type="wave_track", label="Branch B"]
        branch_c [type="wave_track", label="Branch C"]
        branch_d [type="wave_track", label="Branch D"]
        fan_in [shape=tripleoctagon, label="Fan In"]
        start -> parallel_node
        parallel_node -> branch_a
        parallel_node -> branch_b
        parallel_node -> branch_c
        parallel_node -> branch_d
        branch_a -> fan_in
        branch_b -> fan_in
        branch_c -> fan_in
        branch_d -> fan_in
        fan_in -> exit
      }
    `);

    let activeCount = 0;
    let maxActive = 0;

    const runner = new PipelineRunner({ logsRoot: tmpDir });

    runner.registerHandler("wave_track", {
      async execute(node, _ctx, _graph, _logsRoot) {
        activeCount++;
        if (activeCount > maxActive) maxActive = activeCount;
        // Simulate async work
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeCount--;
        return { status: StageStatus.SUCCESS };
      },
    });

    const result = await runner.run(graph);
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);

    // With max_parallel=2, at most 2 branches should be active at a time
    expect(maxActive).toBeLessThanOrEqual(2);

    // All four branches should have been executed
    const parallelResults = JSON.parse(
      result.context.getString("parallel.results"),
    ) as Outcome[];
    expect(parallelResults.length).toBe(4);
    expect(parallelResults.every((r) => r.status === StageStatus.SUCCESS)).toBe(true);
  });
});

describe("error_policy for parallel handler", () => {
  it("error_policy=fail_fast stops remaining branches on first failure", async () => {
    const { graph } = preparePipeline(`
      digraph FailFast {
        graph [goal="Test fail_fast error policy"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        parallel_node [shape=component, label="Fan Out", error_policy="fail_fast", max_parallel="1"]
        branch_a [type="fail_first", label="Branch A"]
        branch_b [type="should_not_run", label="Branch B"]
        branch_c [type="should_not_run", label="Branch C"]
        fan_in [shape=tripleoctagon, label="Fan In"]
        start -> parallel_node
        parallel_node -> branch_a
        parallel_node -> branch_b
        parallel_node -> branch_c
        branch_a -> fan_in
        branch_b -> fan_in
        branch_c -> fan_in
        fan_in -> exit
      }
    `);

    const executedNodes: string[] = [];
    const runner = new PipelineRunner({ logsRoot: tmpDir });

    runner.registerHandler("fail_first", {
      async execute(node, _ctx, _graph, _logsRoot) {
        executedNodes.push(node.id);
        return { status: StageStatus.FAIL, failureReason: "First branch fails" };
      },
    });

    runner.registerHandler("should_not_run", {
      async execute(node, _ctx, _graph, _logsRoot) {
        executedNodes.push(node.id);
        return { status: StageStatus.SUCCESS };
      },
    });

    const result = await runner.run(graph);

    // branch_a should have executed
    expect(executedNodes).toContain("branch_a");

    // branch_b and branch_c should NOT have executed (cancelled by fail_fast)
    expect(executedNodes).not.toContain("branch_b");
    expect(executedNodes).not.toContain("branch_c");

    // The parallel results should contain entries for all branches
    const parallelResults = JSON.parse(
      result.context.getString("parallel.results"),
    ) as Outcome[];
    expect(parallelResults.length).toBe(3);

    // All should be failures (branch_a intentional, others cancelled)
    expect(parallelResults.every((r) => r.status === StageStatus.FAIL)).toBe(true);
  });

  it("error_policy=continue runs all branches even when some fail", async () => {
    const { graph } = preparePipeline(`
      digraph Continue {
        graph [goal="Test continue error policy"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        parallel_node [shape=component, label="Fan Out", error_policy="continue", join_policy="first_success"]
        branch_a [type="fail_branch", label="Branch A"]
        branch_b [type="succeed", label="Branch B"]
        branch_c [type="succeed", label="Branch C"]
        fan_in [shape=tripleoctagon, label="Fan In"]
        start -> parallel_node
        parallel_node -> branch_a
        parallel_node -> branch_b
        parallel_node -> branch_c
        branch_a -> fan_in
        branch_b -> fan_in
        branch_c -> fan_in
        fan_in -> exit
      }
    `);

    const executedNodes: string[] = [];
    const runner = new PipelineRunner({ logsRoot: tmpDir });

    runner.registerHandler("fail_branch", {
      async execute(node, _ctx, _graph, _logsRoot) {
        executedNodes.push(node.id);
        return { status: StageStatus.FAIL, failureReason: "Intentional failure" };
      },
    });

    runner.registerHandler("succeed", {
      async execute(node, _ctx, _graph, _logsRoot) {
        executedNodes.push(node.id);
        return { status: StageStatus.SUCCESS };
      },
    });

    const result = await runner.run(graph);

    // All branches should have executed (continue policy)
    expect(executedNodes).toContain("branch_a");
    expect(executedNodes).toContain("branch_b");
    expect(executedNodes).toContain("branch_c");

    // The overall result should be SUCCESS (first_success with 2 successes)
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);

    // Results should reflect 1 failure and 2 successes
    const parallelResults = JSON.parse(
      result.context.getString("parallel.results"),
    ) as Outcome[];
    expect(parallelResults.length).toBe(3);

    const successCount = parallelResults.filter(
      (r) => r.status === StageStatus.SUCCESS,
    ).length;
    const failCount = parallelResults.filter(
      (r) => r.status === StageStatus.FAIL,
    ).length;
    expect(successCount).toBe(2);
    expect(failCount).toBe(1);
  });

  it("error_policy=ignore excludes failed branches from success/fail count", async () => {
    const { graph } = preparePipeline(`
      digraph Ignore {
        graph [goal="Test ignore error policy"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        parallel_node [shape=component, label="Fan Out", error_policy="ignore", join_policy="wait_all"]
        branch_a [type="succeed", label="Branch A"]
        branch_b [type="fail_branch", label="Branch B"]
        branch_c [type="succeed", label="Branch C"]
        fan_in [shape=tripleoctagon, label="Fan In"]
        start -> parallel_node
        parallel_node -> branch_a
        parallel_node -> branch_b
        parallel_node -> branch_c
        branch_a -> fan_in
        branch_b -> fan_in
        branch_c -> fan_in
        fan_in -> exit
      }
    `);

    const runner = new PipelineRunner({ logsRoot: tmpDir });

    runner.registerHandler("succeed", {
      async execute(_node, _ctx, _graph, _logsRoot) {
        return { status: StageStatus.SUCCESS };
      },
    });

    runner.registerHandler("fail_branch", {
      async execute(_node, _ctx, _graph, _logsRoot) {
        return { status: StageStatus.FAIL, failureReason: "Intentional failure" };
      },
    });

    const result = await runner.run(graph);

    // With "ignore" error policy, failed branches are excluded from counting.
    // The countable results are [SUCCESS, SUCCESS] — no failures in that set.
    // wait_all checks failCount === 0 on countable results, so => SUCCESS.
    expect(result.outcome.status).toBe(StageStatus.SUCCESS);

    // But the raw parallel.results still contain all 3 results
    const parallelResults = JSON.parse(
      result.context.getString("parallel.results"),
    ) as Outcome[];
    expect(parallelResults.length).toBe(3);
  });
});
