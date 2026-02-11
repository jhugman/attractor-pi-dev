import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LocalExecutionEnvironment } from "../src/execution-env.js";

describe("LocalExecutionEnvironment", () => {
  const tmpDir = join(process.cwd(), ".test-tmp-exec-env");
  let env: LocalExecutionEnvironment;

  beforeEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    env = new LocalExecutionEnvironment({ cwd: tmpDir });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("execCommand", () => {
    it("runs a simple command", async () => {
      const result = await env.execCommand("echo hello", 5000);
      expect(result.stdout.trim()).toBe("hello");
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
    });

    it("captures exit code", async () => {
      const result = await env.execCommand("exit 42", 5000);
      expect(result.exitCode).toBe(42);
    });

    it("times out long-running commands", async () => {
      const result = await env.execCommand("sleep 30", 500);
      expect(result.timedOut).toBe(true);
      expect(result.stderr).toContain("timed out");
    });

    it("sends SIGTERM to process group on timeout", async () => {
      // Spawn a command that creates a child process
      // The detached process group ensures both parent and child get killed
      const result = await env.execCommand(
        'bash -c "sleep 30 & wait"',
        500,
      );
      expect(result.timedOut).toBe(true);
    });

    it("records wall-clock duration", async () => {
      const result = await env.execCommand("sleep 0.1", 5000);
      expect(result.durationMs).toBeGreaterThanOrEqual(50);
      expect(result.durationMs).toBeLessThan(5000);
    });

    it("uses working directory", async () => {
      const subDir = join(tmpDir, "sub");
      mkdirSync(subDir);
      writeFileSync(join(subDir, "test.txt"), "content");

      const result = await env.execCommand("ls test.txt", 5000, subDir);
      expect(result.stdout.trim()).toBe("test.txt");
    });
  });

  describe("readFile", () => {
    it("returns line-numbered output", async () => {
      writeFileSync(join(tmpDir, "test.txt"), "line1\nline2\nline3");
      const result = await env.readFile("test.txt");
      expect(result).toContain("   1 | line1");
      expect(result).toContain("   2 | line2");
      expect(result).toContain("   3 | line3");
    });

    it("respects offset and limit", async () => {
      writeFileSync(join(tmpDir, "test.txt"), "a\nb\nc\nd\ne");
      const result = await env.readFile("test.txt", 2, 2);
      expect(result).toContain("   2 | b");
      expect(result).toContain("   3 | c");
      expect(result).not.toContain("   1 | a");
      expect(result).not.toContain("   4 | d");
    });
  });

  describe("writeFile", () => {
    it("creates file and parent directories", async () => {
      await env.writeFile("deep/nested/file.txt", "hello");
      const content = readFileSync(join(tmpDir, "deep/nested/file.txt"), "utf-8");
      expect(content).toBe("hello");
    });
  });

  describe("grep", () => {
    it("searches files by pattern", async () => {
      writeFileSync(join(tmpDir, "a.txt"), "hello world\nfoo bar");
      writeFileSync(join(tmpDir, "b.txt"), "hello there");

      const result = await env.grep("hello", tmpDir);
      expect(result).toContain("hello");
    });

    it("supports case-insensitive search", async () => {
      writeFileSync(join(tmpDir, "test.txt"), "Hello World");
      const result = await env.grep("hello", tmpDir, { caseInsensitive: true });
      expect(result).toContain("Hello World");
    });
  });
});
