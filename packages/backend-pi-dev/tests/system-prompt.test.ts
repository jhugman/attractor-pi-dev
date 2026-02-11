import { describe, it, expect } from "vitest";
import {
  gatherEnvironmentContext,
  formatEnvironmentContext,
  buildFullSystemPrompt,
} from "../src/system-prompt.js";

describe("formatEnvironmentContext", () => {
  it("formats basic context with environment tags", () => {
    const ctx = {
      workingDirectory: "/tmp/test",
      platform: "darwin",
      osVersion: "24.0.0",
      date: "2025-01-15",
      modelName: "claude-sonnet-4-5",
      isGitRepo: false,
    };

    const result = formatEnvironmentContext(ctx);
    expect(result).toContain("<environment>");
    expect(result).toContain("</environment>");
    expect(result).toContain("Working directory: /tmp/test");
    expect(result).toContain("Platform: darwin");
    expect(result).toContain("Today's date: 2025-01-15");
    expect(result).toContain("Model: claude-sonnet-4-5");
    expect(result).toContain("Is git repository: false");
  });

  it("includes git info when available", () => {
    const ctx = {
      workingDirectory: "/tmp/test",
      platform: "linux",
      osVersion: "5.15.0",
      date: "2025-01-15",
      modelName: "gpt-4o",
      isGitRepo: true,
      gitBranch: "main",
      gitStatus: "3 modified, 1 untracked",
      recentCommits: "abc123 Initial commit",
    };

    const result = formatEnvironmentContext(ctx);
    expect(result).toContain("Git branch: main");
    expect(result).toContain("Git status: 3 modified, 1 untracked");
    expect(result).toContain("abc123 Initial commit");
  });

  it("includes knowledge cutoff when provided", () => {
    const ctx = {
      workingDirectory: "/tmp/test",
      platform: "darwin",
      osVersion: "24.0.0",
      date: "2025-01-15",
      modelName: "claude-sonnet-4-5",
      knowledgeCutoff: "April 2024",
      isGitRepo: false,
    };

    const result = formatEnvironmentContext(ctx);
    expect(result).toContain("Knowledge cutoff: April 2024");
  });
});

describe("buildFullSystemPrompt", () => {
  it("includes base instructions", () => {
    const result = buildFullSystemPrompt({
      baseInstructions: "You are a helpful assistant.",
      cwd: "/tmp/test",
      modelName: "test-model",
    });
    expect(result).toContain("You are a helpful assistant.");
  });

  it("includes environment context block", () => {
    const result = buildFullSystemPrompt({
      cwd: "/tmp/test",
      modelName: "test-model",
    });
    expect(result).toContain("<environment>");
    expect(result).toContain("Working directory: /tmp/test");
    expect(result).toContain("Model: test-model");
  });

  it("includes project context files", () => {
    const result = buildFullSystemPrompt({
      cwd: "/tmp/test",
      modelName: "test-model",
      contextFiles: [
        { path: "AGENTS.md", content: "# Project\nBuild with care." },
      ],
    });
    expect(result).toContain("# Project Context");
    expect(result).toContain("## AGENTS.md");
    expect(result).toContain("Build with care.");
  });

  it("appends user instructions last", () => {
    const result = buildFullSystemPrompt({
      baseInstructions: "Base instructions.",
      cwd: "/tmp/test",
      modelName: "test-model",
      userInstructions: "Always use TypeScript.",
    });

    const baseIdx = result.indexOf("Base instructions.");
    const userIdx = result.indexOf("Always use TypeScript.");
    expect(userIdx).toBeGreaterThan(baseIdx);
  });
});
