import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { preparePipeline } from "../src/engine/pipeline.js";
import { parseAndBuild } from "../src/engine/pipeline.js";
import { PromptResolutionTransform } from "../src/transforms/index.js";
import { validate, Severity } from "../src/validation/index.js";

let tmpDir: string;

function makeDotSource(promptAttr: string): string {
  return `
    digraph Test {
      graph [goal="Test prompt resolution"]
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      work  [label="Work", prompt="${promptAttr}"]
      start -> work -> exit
    }
  `;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "attractor-prompt-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // Clean up env var if set
  delete process.env["ATTRACTOR_COMMANDS_PATH"];
});

describe("Prompt Resolution: @file includes", () => {
  it("@file resolves correctly (read file contents as prompt)", () => {
    // Create a prompt file
    const promptContent = "You are an expert coder. Write clean TypeScript.";
    fs.writeFileSync(path.join(tmpDir, "my-prompt.md"), promptContent);

    // Create the DOT file
    const dotPath = path.join(tmpDir, "pipeline.dot");
    fs.writeFileSync(dotPath, makeDotSource("@my-prompt.md"));

    const source = fs.readFileSync(dotPath, "utf-8");
    const { graph } = preparePipeline(source, { dotFilePath: dotPath });

    expect(graph.getNode("work").prompt).toBe(promptContent);
  });

  it("@file with relative path works", () => {
    // Create a subdirectory with a prompt file
    const subDir = path.join(tmpDir, "prompts");
    fs.mkdirSync(subDir, { recursive: true });
    const promptContent = "Analyze the codebase and suggest improvements.";
    fs.writeFileSync(path.join(subDir, "analyze.md"), promptContent);

    const dotPath = path.join(tmpDir, "pipeline.dot");
    fs.writeFileSync(dotPath, makeDotSource("@prompts/analyze.md"));

    const source = fs.readFileSync(dotPath, "utf-8");
    const { graph } = preparePipeline(source, { dotFilePath: dotPath });

    expect(graph.getNode("work").prompt).toBe(promptContent);
  });

  it("@file with missing file produces ERROR diagnostic (prompt_file_exists rule)", () => {
    const dotPath = path.join(tmpDir, "pipeline.dot");
    fs.writeFileSync(dotPath, makeDotSource("@nonexistent-file.md"));

    const source = fs.readFileSync(dotPath, "utf-8");

    expect(() => preparePipeline(source, { dotFilePath: dotPath })).toThrow(
      /prompt_file_exists/,
    );
  });

  it("@file with empty file produces empty prompt", () => {
    // Create an empty prompt file
    fs.writeFileSync(path.join(tmpDir, "empty.md"), "");

    const dotPath = path.join(tmpDir, "pipeline.dot");
    fs.writeFileSync(dotPath, makeDotSource("@empty.md"));

    const source = fs.readFileSync(dotPath, "utf-8");
    const { graph } = preparePipeline(source, { dotFilePath: dotPath });

    expect(graph.getNode("work").prompt).toBe("");
  });

  it("inline prompts (no prefix) are unchanged", () => {
    const dotPath = path.join(tmpDir, "pipeline.dot");
    const inlinePrompt = "Just a normal inline prompt";
    fs.writeFileSync(dotPath, makeDotSource(inlinePrompt));

    const source = fs.readFileSync(dotPath, "utf-8");
    const { graph } = preparePipeline(source, { dotFilePath: dotPath });

    expect(graph.getNode("work").prompt).toBe(inlinePrompt);
  });

  it("@file is not resolved when dotFilePath is not provided", () => {
    const source = makeDotSource("@some-file.md");
    // No dotFilePath: prompt stays as-is, no validation error for file
    const { graph } = preparePipeline(source);

    expect(graph.getNode("work").prompt).toBe("@some-file.md");
  });
});

describe("Prompt Resolution: /command lookups", () => {
  it("/command resolves to .md file in dot file directory", () => {
    const commandContent = "# Plan\nCreate a detailed plan for the task.";
    fs.writeFileSync(path.join(tmpDir, "plan.md"), commandContent);

    const dotPath = path.join(tmpDir, "pipeline.dot");
    fs.writeFileSync(dotPath, makeDotSource("/plan"));

    const source = fs.readFileSync(dotPath, "utf-8");
    const { graph } = preparePipeline(source, { dotFilePath: dotPath });

    expect(graph.getNode("work").prompt).toBe(commandContent);
  });

  it("/command with colon separator (my:cmd -> my/cmd.md)", () => {
    // Create nested directory for the command
    const cmdDir = path.join(tmpDir, "my");
    fs.mkdirSync(cmdDir, { recursive: true });
    const commandContent = "Run the nested command.";
    fs.writeFileSync(path.join(cmdDir, "cmd.md"), commandContent);

    const dotPath = path.join(tmpDir, "pipeline.dot");
    fs.writeFileSync(dotPath, makeDotSource("/my:cmd"));

    const source = fs.readFileSync(dotPath, "utf-8");
    const { graph } = preparePipeline(source, { dotFilePath: dotPath });

    expect(graph.getNode("work").prompt).toBe(commandContent);
  });

  it("/command sets $ARGUMENTS for later variable expansion", () => {
    const commandContent = "Execute task with args: $ARGUMENTS";
    fs.writeFileSync(path.join(tmpDir, "run.md"), commandContent);

    const dotPath = path.join(tmpDir, "pipeline.dot");
    fs.writeFileSync(dotPath, makeDotSource("/run fix the login bug"));

    const source = fs.readFileSync(dotPath, "utf-8");
    const { graph } = preparePipeline(source, { dotFilePath: dotPath });

    // After variable expansion, $ARGUMENTS should be replaced
    expect(graph.getNode("work").prompt).toBe(
      "Execute task with args: fix the login bug",
    );
  });

  it("/command with no arguments sets $ARGUMENTS to empty string", () => {
    const commandContent = "Do something. Args: [$ARGUMENTS]";
    fs.writeFileSync(path.join(tmpDir, "noargs.md"), commandContent);

    const dotPath = path.join(tmpDir, "pipeline.dot");
    fs.writeFileSync(dotPath, makeDotSource("/noargs"));

    const source = fs.readFileSync(dotPath, "utf-8");
    const { graph } = preparePipeline(source, { dotFilePath: dotPath });

    expect(graph.getNode("work").prompt).toBe("Do something. Args: []");
  });

  it("/command with missing .md file produces ERROR diagnostic (prompt_command_exists)", () => {
    const dotPath = path.join(tmpDir, "pipeline.dot");
    fs.writeFileSync(dotPath, makeDotSource("/nonexistent-command"));

    const source = fs.readFileSync(dotPath, "utf-8");

    expect(() => preparePipeline(source, { dotFilePath: dotPath })).toThrow(
      /prompt_command_exists/,
    );
  });

  it("/command search path priority (dot_file_dir > project/.attractor/commands > ~/.attractor/commands)", () => {
    // Create .git to establish project root
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });

    // Create the command in all three locations
    const dotDirContent = "FROM DOT DIR";
    const projectContent = "FROM PROJECT";
    const homeContent = "FROM HOME";

    fs.writeFileSync(path.join(tmpDir, "priority.md"), dotDirContent);

    const projectCmdDir = path.join(tmpDir, ".attractor", "commands");
    fs.mkdirSync(projectCmdDir, { recursive: true });
    fs.writeFileSync(path.join(projectCmdDir, "priority.md"), projectContent);

    const homeCmdDir = path.join(os.homedir(), ".attractor", "commands");
    const homeFileCreated = !fs.existsSync(path.join(homeCmdDir, "priority.md"));
    if (homeFileCreated) {
      fs.mkdirSync(homeCmdDir, { recursive: true });
      fs.writeFileSync(path.join(homeCmdDir, "priority.md"), homeContent);
    }

    try {
      const dotPath = path.join(tmpDir, "pipeline.dot");
      fs.writeFileSync(dotPath, makeDotSource("/priority"));

      const source = fs.readFileSync(dotPath, "utf-8");
      const { graph } = preparePipeline(source, { dotFilePath: dotPath });

      // Should find dot dir first
      expect(graph.getNode("work").prompt).toBe(dotDirContent);

      // Now remove from dot dir and check project level
      fs.unlinkSync(path.join(tmpDir, "priority.md"));

      const source2 = fs.readFileSync(dotPath, "utf-8");
      const { graph: graph2 } = preparePipeline(source2, { dotFilePath: dotPath });

      expect(graph2.getNode("work").prompt).toBe(projectContent);
    } finally {
      // Clean up home dir file if we created it
      if (homeFileCreated) {
        try {
          fs.unlinkSync(path.join(homeCmdDir, "priority.md"));
        } catch {
          // ignore
        }
      }
    }
  });

  it("/command finds .md in project/.attractor/commands", () => {
    // Create .git to establish project root
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });

    const projectCmdDir = path.join(tmpDir, ".attractor", "commands");
    fs.mkdirSync(projectCmdDir, { recursive: true });
    const commandContent = "Project-level command.";
    fs.writeFileSync(path.join(projectCmdDir, "deploy.md"), commandContent);

    const dotPath = path.join(tmpDir, "pipeline.dot");
    fs.writeFileSync(dotPath, makeDotSource("/deploy"));

    const source = fs.readFileSync(dotPath, "utf-8");
    const { graph } = preparePipeline(source, { dotFilePath: dotPath });

    expect(graph.getNode("work").prompt).toBe(commandContent);
  });
});

describe("Prompt Resolution: ATTRACTOR_COMMANDS_PATH", () => {
  it("ATTRACTOR_COMMANDS_PATH adds extra search directories", () => {
    // Create .git to establish project root
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });

    // Create a command in a custom directory
    const customDir = path.join(tmpDir, ".claude", "commands");
    fs.mkdirSync(customDir, { recursive: true });
    const commandContent = "Custom command from .claude/commands.";
    fs.writeFileSync(path.join(customDir, "custom-cmd.md"), commandContent);

    process.env["ATTRACTOR_COMMANDS_PATH"] = ".claude/commands";

    const dotPath = path.join(tmpDir, "pipeline.dot");
    fs.writeFileSync(dotPath, makeDotSource("/custom-cmd"));

    const source = fs.readFileSync(dotPath, "utf-8");
    const { graph } = preparePipeline(source, { dotFilePath: dotPath });

    expect(graph.getNode("work").prompt).toBe(commandContent);
  });

  it("ATTRACTOR_COMMANDS_PATH with multiple comma-separated dirs", () => {
    // Create .git to establish project root
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });

    // Create dirs
    const dir1 = path.join(tmpDir, "custom1");
    const dir2 = path.join(tmpDir, "custom2");
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });

    const commandContent = "Found in custom2.";
    fs.writeFileSync(path.join(dir2, "multi.md"), commandContent);

    process.env["ATTRACTOR_COMMANDS_PATH"] = "custom1,custom2";

    const dotPath = path.join(tmpDir, "pipeline.dot");
    fs.writeFileSync(dotPath, makeDotSource("/multi"));

    const source = fs.readFileSync(dotPath, "utf-8");
    const { graph } = preparePipeline(source, { dotFilePath: dotPath });

    expect(graph.getNode("work").prompt).toBe(commandContent);
  });

  it("ATTRACTOR_COMMANDS_PATH empty/unset is no-op", () => {
    // Create .git to establish project root
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });

    // Create a command only in .attractor/commands
    const projectCmdDir = path.join(tmpDir, ".attractor", "commands");
    fs.mkdirSync(projectCmdDir, { recursive: true });
    const commandContent = "Standard attractor command.";
    fs.writeFileSync(path.join(projectCmdDir, "standard.md"), commandContent);

    // Ensure env var is unset
    delete process.env["ATTRACTOR_COMMANDS_PATH"];

    const dotPath = path.join(tmpDir, "pipeline.dot");
    fs.writeFileSync(dotPath, makeDotSource("/standard"));

    const source = fs.readFileSync(dotPath, "utf-8");
    const { graph } = preparePipeline(source, { dotFilePath: dotPath });

    expect(graph.getNode("work").prompt).toBe(commandContent);
  });

  it("ATTRACTOR_COMMANDS_PATH searches after .attractor/commands at project level", () => {
    // Create .git to establish project root
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });

    // Create command in both .attractor/commands and custom dir
    const projectCmdDir = path.join(tmpDir, ".attractor", "commands");
    fs.mkdirSync(projectCmdDir, { recursive: true });
    fs.writeFileSync(path.join(projectCmdDir, "prio.md"), "FROM ATTRACTOR");

    const customDir = path.join(tmpDir, ".custom");
    fs.mkdirSync(customDir, { recursive: true });
    fs.writeFileSync(path.join(customDir, "prio.md"), "FROM CUSTOM");

    process.env["ATTRACTOR_COMMANDS_PATH"] = ".custom";

    const dotPath = path.join(tmpDir, "pipeline.dot");
    fs.writeFileSync(dotPath, makeDotSource("/prio"));

    const source = fs.readFileSync(dotPath, "utf-8");
    const { graph } = preparePipeline(source, { dotFilePath: dotPath });

    // .attractor/commands should be searched before ATTRACTOR_COMMANDS_PATH dirs
    expect(graph.getNode("work").prompt).toBe("FROM ATTRACTOR");
  });
});

describe("Prompt Resolution: transform ordering", () => {
  it("prompt resolution runs before variable expansion", () => {
    // Create a prompt file that uses a variable
    const promptContent = "Build the $goal feature";
    fs.writeFileSync(path.join(tmpDir, "build.md"), promptContent);

    const dotPath = path.join(tmpDir, "pipeline.dot");
    const dotSource = `
      digraph Test {
        graph [goal="authentication"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        work  [label="Work", prompt="@build.md"]
        start -> work -> exit
      }
    `;
    fs.writeFileSync(dotPath, dotSource);

    const source = fs.readFileSync(dotPath, "utf-8");
    const { graph } = preparePipeline(source, { dotFilePath: dotPath });

    // After prompt resolution: "Build the $goal feature"
    // After variable expansion: "Build the authentication feature"
    expect(graph.getNode("work").prompt).toBe(
      "Build the authentication feature",
    );
  });

  it("/command with $ARGUMENTS expands correctly in pipeline", () => {
    const commandContent = "Process: $ARGUMENTS with goal $goal";
    fs.writeFileSync(path.join(tmpDir, "process.md"), commandContent);

    const dotPath = path.join(tmpDir, "pipeline.dot");
    const dotSource = `
      digraph Test {
        graph [goal="testing"]
        start [shape=Mdiamond]
        exit  [shape=Msquare]
        work  [label="Work", prompt="/process the widgets"]
        start -> work -> exit
      }
    `;
    fs.writeFileSync(dotPath, dotSource);

    const source = fs.readFileSync(dotPath, "utf-8");
    const { graph } = preparePipeline(source, { dotFilePath: dotPath });

    expect(graph.getNode("work").prompt).toBe(
      "Process: the widgets with goal testing",
    );
  });
});

describe("Prompt Resolution: validation diagnostics", () => {
  it("prompt_file_exists diagnostic includes file path", () => {
    const dotPath = path.join(tmpDir, "pipeline.dot");
    fs.writeFileSync(dotPath, makeDotSource("@missing-prompt.md"));

    const source = fs.readFileSync(dotPath, "utf-8");

    try {
      preparePipeline(source, { dotFilePath: dotPath });
      expect.fail("Should have thrown");
    } catch (err: unknown) {
      const error = err as { diagnostics: Array<{ rule: string; message: string; nodeId: string }> };
      expect(error.diagnostics).toBeDefined();
      const fileDiag = error.diagnostics.find(
        (d) => d.rule === "prompt_file_exists",
      );
      expect(fileDiag).toBeDefined();
      expect(fileDiag!.message).toContain("missing-prompt.md");
      expect(fileDiag!.nodeId).toBe("work");
    }
  });

  it("prompt_command_exists diagnostic lists searched paths", () => {
    // Create .git to establish project root
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });

    const dotPath = path.join(tmpDir, "pipeline.dot");
    fs.writeFileSync(dotPath, makeDotSource("/missing-command"));

    const source = fs.readFileSync(dotPath, "utf-8");

    try {
      preparePipeline(source, { dotFilePath: dotPath });
      expect.fail("Should have thrown");
    } catch (err: unknown) {
      const error = err as { diagnostics: Array<{ rule: string; message: string; nodeId: string }> };
      expect(error.diagnostics).toBeDefined();
      const cmdDiag = error.diagnostics.find(
        (d) => d.rule === "prompt_command_exists",
      );
      expect(cmdDiag).toBeDefined();
      expect(cmdDiag!.message).toContain("missing-command");
      expect(cmdDiag!.message).toContain(".attractor/commands");
      expect(cmdDiag!.nodeId).toBe("work");
    }
  });
});
