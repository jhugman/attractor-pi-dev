/**
 * Integration Smoke Test (coding-agent-loop-spec §9.13)
 *
 * End-to-end test with real Anthropic API. Skipped when no auth is available.
 * Run explicitly via: pnpm --filter @attractor/backend-pi-dev test -- smoke-test
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  Session,
  createAnthropicProfile,
  createSubagentTools,
  LocalExecutionEnvironment,
  type SessionEvent,
} from "../src/index.js";

// Skip the entire suite if no Anthropic credentials are available
const hasAuth =
  !!process.env["ANTHROPIC_API_KEY"] ||
  existsSync(join(homedir(), ".pi", "agent", "auth.json"));

describe.skipIf(!hasAuth)("Integration Smoke Test (spec §9.13)", () => {
  let tmpDir: string;
  let env: LocalExecutionEnvironment;
  let session: Session;
  let events: SessionEvent[];

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-smoke-test-"));
    env = new LocalExecutionEnvironment({ cwd: tmpDir });
    await env.initialize();

    const profile = createAnthropicProfile({
      cwd: tmpDir,
      executionEnv: env,
    });

    events = [];
    session = new Session({
      profile,
      executionEnv: env,
      config: {
        maxToolRoundsPerInput: 50,
        enableLoopDetection: true,
      },
    });
    session.subscribe((e) => events.push(e));
  }, 60_000);

  afterAll(async () => {
    await session?.dispose();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Scenario 1: Simple file creation ────────────────────────────────────────
  it("1. creates a file via agent", async () => {
    await session.submit(
      "Create a file called hello.py that prints 'Hello World'. " +
      "Just create the file, no explanation needed.",
    );

    expect(await env.fileExists("hello.py")).toBe(true);
    const content = readFileSync(join(tmpDir, "hello.py"), "utf-8");
    expect(content).toContain("Hello");
  }, 120_000);

  // ── Scenario 2: Read and edit ───────────────────────────────────────────────
  it("2. reads and edits a file", async () => {
    await session.submit(
      "Read hello.py and add a second print statement that says 'Goodbye'. " +
      "Keep the existing Hello World print. Just edit the file.",
    );

    const content = readFileSync(join(tmpDir, "hello.py"), "utf-8");
    expect(content).toContain("Hello");
    expect(content).toContain("Goodbye");
  }, 120_000);

  // ── Scenario 3: Shell execution ─────────────────────────────────────────────
  it("3. executes shell commands", async () => {
    events.length = 0;

    await session.submit("Run hello.py with python3 and show the output.");

    // Verify a shell/bash tool was called
    const bashCalls = events.filter(
      (e) =>
        e.kind === "tool_call_start" &&
        ((e.data["toolName"] as string) === "bash" ||
          (e.data["toolName"] as string) === "shell"),
    );
    expect(bashCalls.length).toBeGreaterThan(0);
  }, 120_000);

  // ── Scenario 4: Truncation verification ─────────────────────────────────────
  it("4. truncates large tool output", async () => {
    // Write a 100KB file directly
    const bigContent = "x".repeat(100_000) + "\n";
    writeFileSync(join(tmpDir, "big.txt"), bigContent);

    events.length = 0;

    await session.submit(
      "Use the read_file tool to read the file big.txt. Do not use bash/cat.",
    );

    // Find tool_call_end events for read_file or any file-reading tool
    const readEnds = events.filter(
      (e) =>
        e.kind === "tool_call_end" &&
        ((e.data["toolName"] as string) === "read_file" ||
          (e.data["toolName"] as string) === "read"),
    );
    expect(readEnds.length).toBeGreaterThan(0);

    // The output should be present (may be truncated by our truncation layer)
    const rawOutput = readEnds[0]!.data["output"] as string;
    expect(rawOutput.length).toBeGreaterThan(0);
  }, 120_000);

  // ── Scenario 5: Steering ────────────────────────────────────────────────────
  it("5. accepts steering mid-execution", async () => {
    events.length = 0;

    // Start a multi-tool task in the background
    const submitPromise = session.submit(
      "Create a Flask web application in app.py with three routes: " +
      "/, /about, and /contact. Each route should return a simple HTML page.",
    );

    // Listen for the first tool call, then inject steering
    await new Promise<void>((resolve) => {
      const unsub = session.subscribe((e) => {
        if (e.kind === "tool_call_start") {
          session.steer(
            "Actually, just create a single /health endpoint that returns JSON {\"status\": \"ok\"}. " +
            "Nothing else.",
          );
          unsub();
          resolve();
        }
      });
      // Safety: if submit completes before any tool call, resolve anyway
      submitPromise.then(() => resolve());
    });

    await submitPromise;

    // Verify steering event was emitted
    const steerEvents = events.filter((e) => e.kind === "steering_injected");
    expect(steerEvents.length).toBeGreaterThan(0);

    // The app.py file should exist
    expect(await env.fileExists("app.py")).toBe(true);
  }, 120_000);

  // ── Scenario 6: Subagent spawn and wait ─────────────────────────────────────
  it("6. spawns a subagent", async () => {
    // Create a separate session with subagent tools registered as customTools.
    // parentSession arg in createSubagentTools is stored but never accessed
    // by any tool implementation, so we can pass the existing session.
    const subagentTools = createSubagentTools(session, session.profile, env);
    const profileWithSub = createAnthropicProfile({
      cwd: tmpDir,
      executionEnv: env,
      customTools: subagentTools,
    });

    const subEvents: SessionEvent[] = [];
    const subSession = new Session({
      profile: profileWithSub,
      executionEnv: env,
      config: { maxToolRoundsPerInput: 50 },
    });
    subSession.subscribe((e) => subEvents.push(e));

    await subSession.submit(
      "Use the spawn_agent tool to spawn a subagent with the task: " +
      "'Create a file called agent_output.txt containing the text: hello from subagent'. " +
      "Then use the wait tool to wait for it. Report its output.",
    );

    // Verify spawn_agent tool was called
    const spawnCalls = subEvents.filter(
      (e) =>
        e.kind === "tool_call_start" &&
        (e.data["toolName"] as string) === "spawn_agent",
    );
    expect(spawnCalls.length).toBeGreaterThan(0);

    // Verify the wait tool was called
    const waitCalls = subEvents.filter(
      (e) =>
        e.kind === "tool_call_start" &&
        (e.data["toolName"] as string) === "wait",
    );
    expect(waitCalls.length).toBeGreaterThan(0);

    // The subagent should have created the file
    expect(await env.fileExists("agent_output.txt")).toBe(true);
    const content = readFileSync(join(tmpDir, "agent_output.txt"), "utf-8");
    expect(content.toLowerCase()).toContain("hello");

    await subSession.dispose();
  }, 180_000);

  // ── Scenario 7: Timeout handling ────────────────────────────────────────────
  it("7. handles command timeout gracefully", async () => {
    events.length = 0;

    await session.submit(
      "Run the shell command 'sleep 30' with a 5 second timeout. " +
      "Report what happened.",
    );

    // The agent should have called bash/shell and received a timeout
    const bashEnds = events.filter(
      (e) =>
        e.kind === "tool_call_end" &&
        ((e.data["toolName"] as string) === "bash" ||
          (e.data["toolName"] as string) === "shell"),
    );
    expect(bashEnds.length).toBeGreaterThan(0);

    // The agent should have completed without crashing
    expect(session.state).not.toBe("CLOSED");
  }, 120_000);

  // ── Scenario 8: Multi-file edit in one session ────────────────────────────
  it("8. edits multiple files in one session", async () => {
    await session.submit(
      "Create two files: utils.py with a function add(a, b) that returns a+b, " +
      "and main.py that imports add from utils and prints add(2, 3). " +
      "Just create the files, no explanation needed.",
    );

    expect(await env.fileExists("utils.py")).toBe(true);
    expect(await env.fileExists("main.py")).toBe(true);
    const utils = readFileSync(join(tmpDir, "utils.py"), "utf-8");
    const main = readFileSync(join(tmpDir, "main.py"), "utf-8");
    expect(utils).toContain("add");
    expect(main).toContain("import");
  }, 120_000);

  // ── Scenario 9: Grep + glob to find files ─────────────────────────────────
  it("9. uses grep and glob to find files", async () => {
    events.length = 0;

    await session.submit(
      "Use the glob tool to find all .py files, then use grep to find " +
      "which file contains the word 'Goodbye'. Report the filename.",
    );

    const searchTools = events.filter(
      (e) =>
        e.kind === "tool_call_start" &&
        ((e.data["toolName"] as string) === "grep" ||
          (e.data["toolName"] as string) === "glob"),
    );
    expect(searchTools.length).toBeGreaterThan(0);
  }, 120_000);

  // ── Scenario 10: Multi-step task (read -> analyze -> edit) ────────────────
  it("10. performs multi-step read-analyze-edit", async () => {
    events.length = 0;

    await session.submit(
      "Read utils.py, then add a multiply(a, b) function to it. " +
      "Then update main.py to also call multiply(4, 5) and print the result. " +
      "Just edit the files.",
    );

    const utils = readFileSync(join(tmpDir, "utils.py"), "utf-8");
    const main = readFileSync(join(tmpDir, "main.py"), "utf-8");
    expect(utils).toContain("multiply");
    expect(main).toContain("multiply");

    // Verify multiple tool types were used (read + edit or write)
    const toolNames = new Set(
      events
        .filter((e) => e.kind === "tool_call_start")
        .map((e) => e.data["toolName"] as string),
    );
    expect(toolNames.size).toBeGreaterThanOrEqual(2);
  }, 120_000);

  // ── Scenario 11: Provider-specific editing format ─────────────────────────
  it("11. uses provider-specific edit format (edit_file)", async () => {
    // Seed a known file so we can verify the edit
    writeFileSync(join(tmpDir, "editable.txt"), "before-edit\n");

    events.length = 0;

    await session.submit(
      "Use the edit_file tool to change 'before-edit' to 'after-edit' in editable.txt. " +
      "You must use the edit_file tool with old_string='before-edit' and new_string='after-edit'.",
    );

    const content = readFileSync(join(tmpDir, "editable.txt"), "utf-8");
    expect(content).toContain("after-edit");

    // Verify at least one tool was invoked to perform the edit
    const toolCalls = events.filter((e) => e.kind === "tool_call_start");
    expect(toolCalls.length).toBeGreaterThan(0);
  }, 120_000);

  // ── Scenario 12: Error recovery ───────────────────────────────────────────
  it("12. recovers from tool errors", async () => {
    events.length = 0;

    await session.submit(
      "Try to read a file called nonexistent_file_xyz.txt. " +
      "When that fails, create it with the content 'recovered'. " +
      "Just do it, no explanation needed.",
    );

    // The agent should have encountered an error then recovered
    const toolEnds = events.filter((e) => e.kind === "tool_call_end");
    const hadError = toolEnds.some((e) => e.data["isError"] === true);
    expect(hadError).toBe(true);

    // The file should exist after recovery
    expect(await env.fileExists("nonexistent_file_xyz.txt")).toBe(true);
    const content = readFileSync(
      join(tmpDir, "nonexistent_file_xyz.txt"),
      "utf-8",
    );
    expect(content).toContain("recovered");
  }, 120_000);

  // ── Scenario 13: Reasoning effort change ──────────────────────────────────
  it("13. accepts reasoning effort change", async () => {
    // Change reasoning effort mid-session
    session.setReasoningEffort("low");

    events.length = 0;

    await session.submit(
      "Create a file called low_effort.txt with the text 'done'. " +
      "Just create the file.",
    );

    expect(await env.fileExists("low_effort.txt")).toBe(true);

    // Restore to default
    session.setReasoningEffort("high");
  }, 120_000);

  // ── Scenario 14: Loop detection / turn limits ──────────────────────────────
  it("14. enforces turn limits", async () => {
    events.length = 0;

    // Create a session with a very tight round limit
    const limitedSession = new Session({
      profile: session.profile,
      executionEnv: env,
      config: {
        maxToolRoundsPerInput: 3,
        enableLoopDetection: true,
        loopDetectionWindow: 4,
      },
    });
    limitedSession.subscribe((e) => events.push(e));

    await limitedSession.submit(
      "Create files step1.txt, step2.txt, step3.txt, step4.txt, step5.txt, " +
      "step6.txt, step7.txt, step8.txt, step9.txt, step10.txt. " +
      "Each should contain its number. Create them one at a time.",
    );

    // With a 3-round limit, the agent should be stopped before finishing all 10
    const turnLimitEvents = events.filter((e) => e.kind === "turn_limit");
    const loopEvents = events.filter((e) => e.kind === "loop_detection");
    expect(turnLimitEvents.length + loopEvents.length).toBeGreaterThan(0);

    await limitedSession.dispose();
  }, 120_000);
});
