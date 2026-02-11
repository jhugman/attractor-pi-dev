import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { discoverProjectDocs } from "../src/system-prompt.js";

describe("discoverProjectDocs", () => {
  const tmpDir = join(process.cwd(), ".test-tmp-project-docs");

  beforeEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    // Init a git repo so discoverProjectDocs can find the root
    execSync("git init", { cwd: tmpDir, stdio: "pipe" });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("discovers AGENTS.md at root", async () => {
    writeFileSync(join(tmpDir, "AGENTS.md"), "# Agent Instructions\nDo X.");

    const results = await discoverProjectDocs(tmpDir, ["AGENTS.md"]);
    expect(results).toHaveLength(1);
    expect(results[0]!.path).toBe("AGENTS.md");
    expect(results[0]!.content).toContain("# Agent Instructions");
  });

  it("discovers files at multiple depths", async () => {
    writeFileSync(join(tmpDir, "AGENTS.md"), "Root instructions.");
    const sub = join(tmpDir, "packages", "core");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "AGENTS.md"), "Core instructions.");

    const results = await discoverProjectDocs(sub, ["AGENTS.md"]);
    expect(results).toHaveLength(2);
    // Root first, then subdirectory
    expect(results[0]!.content).toBe("Root instructions.");
    expect(results[1]!.content).toBe("Core instructions.");
  });

  it("respects 32KB budget", async () => {
    // Write a file that exceeds 32KB
    const bigContent = "x".repeat(40_000);
    writeFileSync(join(tmpDir, "AGENTS.md"), bigContent);

    const results = await discoverProjectDocs(tmpDir, ["AGENTS.md"]);
    expect(results).toHaveLength(1);
    expect(results[0]!.content.length).toBeLessThanOrEqual(32 * 1024 + 50); // budget + truncation marker
    expect(results[0]!.content).toContain("[Project instructions truncated at 32KB]");
  });

  it("loads multiple file patterns", async () => {
    writeFileSync(join(tmpDir, "AGENTS.md"), "Agents content.");
    writeFileSync(join(tmpDir, "CLAUDE.md"), "Claude content.");

    const results = await discoverProjectDocs(tmpDir, ["AGENTS.md", "CLAUDE.md"]);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.path)).toContain("AGENTS.md");
    expect(results.map((r) => r.path)).toContain("CLAUDE.md");
  });

  it("skips files that don't match patterns", async () => {
    writeFileSync(join(tmpDir, "AGENTS.md"), "Agents.");
    writeFileSync(join(tmpDir, "GEMINI.md"), "Gemini.");

    // Anthropic profile only looks for AGENTS.md and CLAUDE.md
    const results = await discoverProjectDocs(tmpDir, ["AGENTS.md", "CLAUDE.md"]);
    expect(results).toHaveLength(1);
    expect(results[0]!.path).toBe("AGENTS.md");
  });

  it("returns empty for non-existent patterns", async () => {
    const results = await discoverProjectDocs(tmpDir, ["NONEXISTENT.md"]);
    expect(results).toHaveLength(0);
  });

  it("returns empty for empty patterns list", async () => {
    const results = await discoverProjectDocs(tmpDir, []);
    expect(results).toHaveLength(0);
  });
});
