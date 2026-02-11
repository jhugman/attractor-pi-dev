import { describe, it, expect } from "vitest";

// Re-implement the heuristic locally for testing since it's a private function.
// The actual implementation is in session.ts as looksLikeQuestion().
function looksLikeQuestion(text: string): boolean {
  const trimmed = text.trimEnd();
  if (trimmed.endsWith("?")) return true;

  const lastParagraph = trimmed.split("\n\n").pop()?.toLowerCase() ?? "";
  const questionStarters = [
    "would you like",
    "do you want",
    "should i",
    "shall i",
    "can you",
    "could you",
    "what would you",
    "how would you",
    "which option",
    "what do you think",
    "what are your thoughts",
    "please let me know",
    "let me know if",
  ];
  return questionStarters.some((q) => lastParagraph.includes(q));
}

describe("looksLikeQuestion", () => {
  it("detects text ending with question mark", () => {
    expect(looksLikeQuestion("What should I do?")).toBe(true);
  });

  it("detects question mark after trailing newlines", () => {
    expect(looksLikeQuestion("What should I do?\n\n")).toBe(true);
  });

  it("does not detect plain statements", () => {
    expect(looksLikeQuestion("I have completed the task.")).toBe(false);
  });

  it("detects 'would you like' patterns", () => {
    expect(
      looksLikeQuestion("I can do A or B.\n\nWould you like me to proceed with A?"),
    ).toBe(true);
  });

  it("detects 'should i' patterns", () => {
    expect(
      looksLikeQuestion("The tests are failing.\n\nShould I fix them now"),
    ).toBe(true);
  });

  it("detects 'let me know if' patterns", () => {
    expect(
      looksLikeQuestion("Here's the plan.\n\nLet me know if you'd like changes."),
    ).toBe(true);
  });

  it("does not trigger on 'should' in the middle of explanation", () => {
    expect(
      looksLikeQuestion("Users should always validate input. Done."),
    ).toBe(false);
  });

  it("detects 'do you want' patterns", () => {
    expect(
      looksLikeQuestion("I found the bug.\n\nDo you want me to fix it"),
    ).toBe(true);
  });
});
