import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import type { ExecutionEnvironment } from "../execution-env.js";

// ─── v4a Patch Parser ────────────────────────────────────────────────────────

interface AddFileOp {
  type: "add";
  path: string;
  lines: string[];
}

interface DeleteFileOp {
  type: "delete";
  path: string;
}

interface Hunk {
  contextHint: string;
  lines: Array<{
    type: "context" | "delete" | "add";
    content: string;
  }>;
}

interface UpdateFileOp {
  type: "update";
  path: string;
  moveTo?: string;
  hunks: Hunk[];
}

type PatchOp = AddFileOp | DeleteFileOp | UpdateFileOp;

function parsePatch(patch: string): PatchOp[] {
  const lines = patch.split("\n");
  const ops: PatchOp[] = [];
  let i = 0;

  // Skip to "*** Begin Patch"
  while (i < lines.length && lines[i]!.trim() !== "*** Begin Patch") {
    i++;
  }
  if (i >= lines.length) throw new Error("Missing '*** Begin Patch' marker");
  i++; // skip "*** Begin Patch"

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === "*** End Patch") break;

    if (line.startsWith("*** Add File: ")) {
      const path = line.slice("*** Add File: ".length).trim();
      i++;
      const addedLines: string[] = [];
      while (i < lines.length && lines[i]!.startsWith("+")) {
        addedLines.push(lines[i]!.slice(1));
        i++;
      }
      ops.push({ type: "add", path, lines: addedLines });
    } else if (line.startsWith("*** Delete File: ")) {
      const path = line.slice("*** Delete File: ".length).trim();
      ops.push({ type: "delete", path });
      i++;
    } else if (line.startsWith("*** Update File: ")) {
      const path = line.slice("*** Update File: ".length).trim();
      i++;

      let moveTo: string | undefined;
      if (i < lines.length && lines[i]!.startsWith("*** Move to: ")) {
        moveTo = lines[i]!.slice("*** Move to: ".length).trim();
        i++;
      }

      const hunks: Hunk[] = [];
      while (i < lines.length && lines[i]!.startsWith("@@ ")) {
        const contextHint = lines[i]!.slice(3).trim();
        i++;

        const hunkLines: Hunk["lines"] = [];
        while (i < lines.length) {
          const hl = lines[i]!;
          if (hl.startsWith("@@ ") || hl.startsWith("*** ")) break;
          if (hl === "*** End of File") {
            i++;
            break;
          }
          if (hl.startsWith(" ")) {
            hunkLines.push({ type: "context", content: hl.slice(1) });
          } else if (hl.startsWith("-")) {
            hunkLines.push({ type: "delete", content: hl.slice(1) });
          } else if (hl.startsWith("+")) {
            hunkLines.push({ type: "add", content: hl.slice(1) });
          } else {
            // Treat as context if no prefix (lenient parsing)
            hunkLines.push({ type: "context", content: hl });
          }
          i++;
        }
        hunks.push({ contextHint, lines: hunkLines });
      }

      ops.push({ type: "update", path, moveTo, hunks });
    } else {
      i++; // skip unrecognized lines
    }
  }

  return ops;
}

// ─── Hunk Application ────────────────────────────────────────────────────────

function applyHunk(fileLines: string[], hunk: Hunk): string[] {
  // Extract the context and delete lines from the hunk to find the match location
  const matchLines: string[] = [];
  for (const hl of hunk.lines) {
    if (hl.type === "context" || hl.type === "delete") {
      matchLines.push(hl.content);
    }
  }

  if (matchLines.length === 0) {
    // Pure insertion hunk - try to find position using context hint
    const hintIdx = fileLines.findIndex((l) => l.includes(hunk.contextHint));
    const insertAt = hintIdx >= 0 ? hintIdx + 1 : fileLines.length;
    const newLines = hunk.lines
      .filter((hl) => hl.type === "add")
      .map((hl) => hl.content);
    return [...fileLines.slice(0, insertAt), ...newLines, ...fileLines.slice(insertAt)];
  }

  // Find the match position
  let matchStart = -1;
  for (let start = 0; start <= fileLines.length - matchLines.length; start++) {
    let matches = true;
    for (let j = 0; j < matchLines.length; j++) {
      if (fileLines[start + j] !== matchLines[j]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      matchStart = start;
      break;
    }
  }

  // Fuzzy matching: try trimming whitespace
  if (matchStart === -1) {
    for (let start = 0; start <= fileLines.length - matchLines.length; start++) {
      let matches = true;
      for (let j = 0; j < matchLines.length; j++) {
        if (fileLines[start + j]!.trim() !== matchLines[j]!.trim()) {
          matches = false;
          break;
        }
      }
      if (matches) {
        matchStart = start;
        break;
      }
    }
  }

  if (matchStart === -1) {
    throw new Error(
      `Could not locate hunk in file. Context hint: "${hunk.contextHint}". ` +
      `Looking for:\n${matchLines.slice(0, 3).join("\n")}`,
    );
  }

  // Apply the hunk: walk through hunk lines, building the result
  const result = [...fileLines.slice(0, matchStart)];
  let fileIdx = matchStart;

  for (const hl of hunk.lines) {
    switch (hl.type) {
      case "context":
        result.push(fileLines[fileIdx]!);
        fileIdx++;
        break;
      case "delete":
        fileIdx++; // skip the deleted line
        break;
      case "add":
        result.push(hl.content);
        break;
    }
  }

  result.push(...fileLines.slice(fileIdx));
  return result;
}

// ─── Apply Patch Tool ────────────────────────────────────────────────────────

const ApplyPatchParams = Type.Object({
  patch: Type.String({ description: "The patch content in v4a format" }),
});

type ApplyPatchInput = Static<typeof ApplyPatchParams>;

interface ApplyPatchDetails {
  operations: Array<{
    type: "add" | "delete" | "update";
    path: string;
    moveTo?: string;
  }>;
}

/**
 * Create the apply_patch tool for OpenAI profile.
 * Applies v4a format patches supporting create, delete, update, and rename operations.
 */
export function createApplyPatchTool(
  env: ExecutionEnvironment,
): AgentTool<typeof ApplyPatchParams, ApplyPatchDetails> {
  return {
    name: "apply_patch",
    label: "Apply Patch",
    description:
      "Apply code changes using the v4a patch format. Supports creating, deleting, " +
      "and modifying files in a single operation.",
    parameters: ApplyPatchParams,

    async execute(
      _toolCallId: string,
      params: ApplyPatchInput,
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<ApplyPatchDetails>> {
      const ops = parsePatch(params.patch);
      const results: string[] = [];
      const details: ApplyPatchDetails = { operations: [] };

      for (const op of ops) {
        try {
          switch (op.type) {
            case "add": {
              await env.writeFile(op.path, op.lines.join("\n"));
              results.push(`Created: ${op.path}`);
              details.operations.push({ type: "add", path: op.path });
              break;
            }
            case "delete": {
              // Delete by writing empty (env doesn't have delete, use exec)
              await env.execCommand(`rm -f '${op.path.replace(/'/g, "'\\''")}'`, 5000);
              results.push(`Deleted: ${op.path}`);
              details.operations.push({ type: "delete", path: op.path });
              break;
            }
            case "update": {
              const content = await env.readFile(op.path);
              // readFile returns line-numbered content, get raw
              // Actually, we need raw content. Let's exec cat instead.
              const rawResult = await env.execCommand(
                `cat '${op.path.replace(/'/g, "'\\''")}'`,
                5000,
              );
              let fileLines = rawResult.stdout.split("\n");

              // Apply each hunk in order
              for (const hunk of op.hunks) {
                fileLines = applyHunk(fileLines, hunk);
              }

              const targetPath = op.moveTo ?? op.path;
              await env.writeFile(targetPath, fileLines.join("\n"));

              if (op.moveTo) {
                await env.execCommand(`rm -f '${op.path.replace(/'/g, "'\\''")}'`, 5000);
                results.push(`Updated and moved: ${op.path} → ${op.moveTo}`);
                details.operations.push({
                  type: "update",
                  path: op.path,
                  moveTo: op.moveTo,
                });
              } else {
                results.push(`Updated: ${op.path}`);
                details.operations.push({ type: "update", path: op.path });
              }
              break;
            }
          }
        } catch (err) {
          results.push(`Error on ${op.path}: ${err}`);
        }
      }

      const text = results.join("\n");
      const content: TextContent[] = [{ type: "text" as const, text }];
      return { content, details };
    },
  };
}
