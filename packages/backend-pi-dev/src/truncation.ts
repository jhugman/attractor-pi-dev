/**
 * Tool output truncation per spec Section 5.
 *
 * Character-based truncation runs FIRST (handles pathological cases
 * like 10MB single-line CSVs). Line-based truncation runs SECOND
 * for readability.
 */

/**
 * Character-based truncation with head/tail split.
 */
export function truncateOutput(
  output: string,
  maxChars: number,
  mode: "head_tail" | "tail" = "head_tail",
): string {
  if (output.length <= maxChars) return output;

  if (mode === "head_tail") {
    const half = Math.floor(maxChars / 2);
    const removed = output.length - maxChars;
    return (
      output.slice(0, half) +
      `\n\n[WARNING: Tool output was truncated. ${removed} characters were removed from the middle. ` +
      `The full output is available in the event stream. ` +
      `If you need to see specific parts, re-run the tool with more targeted parameters.]\n\n` +
      output.slice(-half)
    );
  }

  // mode === "tail"
  const removed = output.length - maxChars;
  return (
    `[WARNING: Tool output was truncated. First ${removed} characters were removed. ` +
    `The full output is available in the event stream.]\n\n` +
    output.slice(-maxChars)
  );
}

/**
 * Line-based truncation with head/tail split.
 */
export function truncateLines(
  output: string,
  maxLines: number,
): string {
  const lines = output.split("\n");
  if (lines.length <= maxLines) return output;

  const headCount = Math.floor(maxLines / 2);
  const tailCount = maxLines - headCount;
  const omitted = lines.length - headCount - tailCount;

  return (
    lines.slice(0, headCount).join("\n") +
    `\n[... ${omitted} lines omitted ...]\n` +
    lines.slice(-tailCount).join("\n")
  );
}

/**
 * Full truncation pipeline: character-based first, then line-based.
 */
export function truncateToolOutput(
  output: string,
  toolName: string,
  charLimits: Record<string, number>,
  lineLimits: Record<string, number>,
  modes: Record<string, "head_tail" | "tail">,
): string {
  const maxChars = charLimits[toolName] ?? 50_000;
  const mode = modes[toolName] ?? "head_tail";

  // Step 1: Character-based truncation
  let result = truncateOutput(output, maxChars, mode);

  // Step 2: Line-based truncation
  const maxLineCount = lineLimits[toolName];
  if (maxLineCount !== undefined) {
    result = truncateLines(result, maxLineCount);
  }

  return result;
}
