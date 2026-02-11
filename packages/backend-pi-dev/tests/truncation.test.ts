import { describe, it, expect } from "vitest";
import { truncateOutput, truncateLines, truncateToolOutput } from "../src/truncation.js";

describe("truncateOutput", () => {
  it("returns short output unchanged", () => {
    const output = "hello world";
    expect(truncateOutput(output, 100)).toBe(output);
  });

  it("truncates with head_tail mode", () => {
    const output = "A".repeat(100);
    const result = truncateOutput(output, 50, "head_tail");
    expect(result).toContain("A".repeat(25));
    expect(result).toContain("[WARNING: Tool output was truncated.");
    expect(result).toContain("50 characters were removed from the middle");
  });

  it("truncates with tail mode", () => {
    const output = "B".repeat(100);
    const result = truncateOutput(output, 50, "tail");
    expect(result).toContain("[WARNING: Tool output was truncated.");
    expect(result).toContain("50 characters were removed");
    expect(result).toContain("B".repeat(50));
  });

  it("returns output exactly at limit unchanged", () => {
    const output = "x".repeat(50);
    expect(truncateOutput(output, 50)).toBe(output);
  });
});

describe("truncateLines", () => {
  it("returns short output unchanged", () => {
    const output = "line1\nline2\nline3";
    expect(truncateLines(output, 10)).toBe(output);
  });

  it("truncates with head/tail split", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    const output = lines.join("\n");
    const result = truncateLines(output, 10);

    // Should have first 5 lines
    expect(result).toContain("line 1");
    expect(result).toContain("line 5");

    // Should have omission marker
    expect(result).toContain("90 lines omitted");

    // Should have last 5 lines
    expect(result).toContain("line 96");
    expect(result).toContain("line 100");
  });
});

describe("truncateToolOutput", () => {
  const charLimits = { read: 50_000, bash: 30_000, grep: 20_000 };
  const lineLimits = { bash: 256, grep: 200 };
  const modes: Record<string, "head_tail" | "tail"> = {
    read: "head_tail",
    bash: "head_tail",
    grep: "tail",
  };

  it("applies character truncation first, then line truncation", () => {
    // Create output that's under char limit but over line limit
    const lines = Array.from({ length: 300 }, (_, i) => `output line ${i}`);
    const output = lines.join("\n");
    const result = truncateToolOutput(output, "bash", charLimits, lineLimits, modes);

    // Should be line-truncated since it's under 30k chars but over 256 lines
    expect(result).toContain("lines omitted");
  });

  it("applies character truncation for large outputs", () => {
    const output = "x".repeat(60_000);
    const result = truncateToolOutput(output, "read", charLimits, lineLimits, modes);
    expect(result).toContain("[WARNING: Tool output was truncated.");
  });

  it("uses default limit for unknown tools", () => {
    const output = "x".repeat(60_000);
    const result = truncateToolOutput(output, "unknown_tool", {}, {}, {});
    expect(result).toContain("[WARNING: Tool output was truncated.");
  });
});
