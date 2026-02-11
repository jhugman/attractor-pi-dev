import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ToolCall } from "@mariozechner/pi-ai";

/**
 * Extracts a stable signature from a tool call: "toolName:sortedArgsHash".
 * The hash is a simple JSON string of sorted keys to detect identical calls.
 */
function toolCallSignature(tc: ToolCall): string {
  const argsStr = JSON.stringify(
    tc.arguments,
    Object.keys(tc.arguments).sort(),
  );
  return `${tc.name}:${argsStr}`;
}

/**
 * Extract tool call signatures from the most recent assistant messages in history.
 * Each assistant message may contain multiple tool calls; we flatten them all.
 */
function extractRecentSignatures(
  history: AgentMessage[],
  count: number,
): string[] {
  const signatures: string[] = [];

  // Walk history backwards, collecting tool call signatures from assistant messages
  for (let i = history.length - 1; i >= 0 && signatures.length < count; i--) {
    const msg = history[i]!;
    if (msg.role !== "assistant") continue;

    const toolCalls = msg.content.filter(
      (c): c is ToolCall => c.type === "toolCall",
    );
    // Add in reverse order so oldest is first when we reverse later
    for (let j = toolCalls.length - 1; j >= 0 && signatures.length < count; j--) {
      signatures.push(toolCallSignature(toolCalls[j]!));
    }
  }

  // Reverse so signatures are in chronological order
  signatures.reverse();
  return signatures;
}

/**
 * Detect repeating tool call patterns in conversation history.
 *
 * Checks whether the last `windowSize` tool call signatures form a
 * repeating pattern of length 1, 2, or 3. For example:
 * - Pattern length 1: [A, A, A, A] (same call repeated)
 * - Pattern length 2: [A, B, A, B] (alternating pair)
 * - Pattern length 3: [A, B, C, A, B, C] (repeating triple)
 *
 * @param history - The conversation history (AgentMessage[])
 * @param windowSize - How many recent tool calls to examine (default: 10)
 * @returns true if a repeating pattern was detected
 */
export function detectLoop(
  history: AgentMessage[],
  windowSize: number = 10,
): boolean {
  const recent = extractRecentSignatures(history, windowSize);
  if (recent.length < windowSize) return false;

  // Check for repeating patterns of length 1, 2, or 3
  for (const patternLen of [1, 2, 3]) {
    if (windowSize % patternLen !== 0) continue;

    const pattern = recent.slice(0, patternLen);
    let allMatch = true;

    for (let i = patternLen; i < windowSize; i += patternLen) {
      const chunk = recent.slice(i, i + patternLen);
      if (chunk.length !== patternLen) {
        allMatch = false;
        break;
      }
      for (let j = 0; j < patternLen; j++) {
        if (chunk[j] !== pattern[j]) {
          allMatch = false;
          break;
        }
      }
      if (!allMatch) break;
    }

    if (allMatch) return true;
  }

  return false;
}
