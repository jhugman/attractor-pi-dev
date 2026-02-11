import { describe, it, expect, vi, beforeEach } from "vitest";
import { createApplyPatchTool } from "../src/tools/apply-patch.js";
import type { ExecutionEnvironment } from "../src/execution-env.js";

function createMockEnv(files: Record<string, string>): ExecutionEnvironment {
  return {
    readFile: vi.fn(async (path: string) => files[path] ?? ""),
    writeFile: vi.fn(async (path: string, content: string) => {
      files[path] = content;
    }),
    fileExists: vi.fn(async (path: string) => path in files),
    listDirectory: vi.fn(async () => []),
    execCommand: vi.fn(async (command: string) => {
      // Handle "cat" for raw file reading
      const catMatch = command.match(/^cat '([^']+)'$/);
      if (catMatch) {
        const path = catMatch[1]!;
        return {
          stdout: files[path] ?? "",
          stderr: "",
          exitCode: 0,
          timedOut: false,
          durationMs: 1,
        };
      }
      // Handle "rm" for delete
      const rmMatch = command.match(/^rm -f '([^']+)'$/);
      if (rmMatch) {
        delete files[rmMatch[1]!];
        return {
          stdout: "",
          stderr: "",
          exitCode: 0,
          timedOut: false,
          durationMs: 1,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 };
    }),
    grep: vi.fn(async () => ""),
    glob: vi.fn(async () => []),
    initialize: vi.fn(async () => {}),
    cleanup: vi.fn(async () => {}),
    workingDirectory: () => "/tmp/test",
    platform: () => "darwin",
    osVersion: () => "24.0.0",
  };
}

describe("apply-patch tool", () => {
  let files: Record<string, string>;
  let env: ExecutionEnvironment;
  let tool: ReturnType<typeof createApplyPatchTool>;

  beforeEach(() => {
    files = {};
    env = createMockEnv(files);
    tool = createApplyPatchTool(env);
  });

  it("creates a new file", async () => {
    const patch = `*** Begin Patch
*** Add File: src/hello.py
+def greet(name):
+    return f"Hello, {name}!"
*** End Patch`;

    const result = await tool.execute("test-id", { patch });
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as any).text).toContain("Created: src/hello.py");
    expect(files["src/hello.py"]).toContain("def greet(name):");
  });

  it("deletes a file", async () => {
    files["old.py"] = "old content";

    const patch = `*** Begin Patch
*** Delete File: old.py
*** End Patch`;

    const result = await tool.execute("test-id", { patch });
    expect((result.content[0] as any).text).toContain("Deleted: old.py");
  });

  it("updates a file with hunks", async () => {
    files["main.py"] = 'def main():\n    print("Hello")\n    return 0\n';

    const patch = `*** Begin Patch
*** Update File: main.py
@@ def main():
     print("Hello")
-    return 0
+    print("World")
+    return 1
*** End Patch`;

    const result = await tool.execute("test-id", { patch });
    expect((result.content[0] as any).text).toContain("Updated: main.py");
    expect(files["main.py"]).toContain('print("World")');
    expect(files["main.py"]).toContain("return 1");
    expect(files["main.py"]).not.toContain("return 0");
  });

  it("handles multiple operations in one patch", async () => {
    files["config.py"] = "DEBUG = False\nVERSION = 1\n";

    const patch = `*** Begin Patch
*** Add File: new.py
+# New file
*** Delete File: old.py
*** Update File: config.py
@@ DEBUG = False
-DEBUG = False
+DEBUG = True
*** End Patch`;

    const result = await tool.execute("test-id", { patch });
    const text = (result.content[0] as any).text;
    expect(text).toContain("Created: new.py");
    expect(text).toContain("Deleted: old.py");
    expect(text).toContain("Updated: config.py");
    expect(files["new.py"]).toContain("# New file");
    expect(files["config.py"]).toContain("DEBUG = True");
  });

  it("reports details for each operation", async () => {
    const patch = `*** Begin Patch
*** Add File: a.txt
+hello
*** Add File: b.txt
+world
*** End Patch`;

    const result = await tool.execute("test-id", { patch });
    expect(result.details.operations).toHaveLength(2);
    expect(result.details.operations[0]).toEqual({ type: "add", path: "a.txt" });
    expect(result.details.operations[1]).toEqual({ type: "add", path: "b.txt" });
  });
});
