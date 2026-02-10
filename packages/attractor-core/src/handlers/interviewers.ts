import type { Answer, Interviewer, Question } from "./types.js";
import { AnswerValue, QuestionType } from "./types.js";

/** Always approves - for testing and CI/CD */
export class AutoApproveInterviewer implements Interviewer {
  async ask(question: Question): Promise<Answer> {
    if (
      question.type === QuestionType.YES_NO ||
      question.type === QuestionType.CONFIRMATION
    ) {
      return { value: AnswerValue.YES };
    }
    if (
      question.type === QuestionType.MULTIPLE_CHOICE &&
      question.options.length > 0
    ) {
      const first = question.options[0]!;
      return { value: first.key, selectedOption: first };
    }
    return { value: "auto-approved", text: "auto-approved" };
  }
}

/** Delegates to a callback function */
export class CallbackInterviewer implements Interviewer {
  constructor(private callback: (question: Question) => Promise<Answer>) {}

  async ask(question: Question): Promise<Answer> {
    return this.callback(question);
  }
}

/** Reads answers from a pre-filled queue - for testing */
export class QueueInterviewer implements Interviewer {
  private queue: Answer[];

  constructor(answers: Answer[]) {
    this.queue = [...answers];
  }

  async ask(_question: Question): Promise<Answer> {
    if (this.queue.length > 0) {
      return this.queue.shift()!;
    }
    return { value: AnswerValue.SKIPPED };
  }
}

/** Wraps another interviewer and records all interactions */
export class RecordingInterviewer implements Interviewer {
  recordings: Array<{ question: Question; answer: Answer }> = [];

  constructor(private inner: Interviewer) {}

  async ask(question: Question): Promise<Answer> {
    const answer = await this.inner.ask(question);
    this.recordings.push({ question, answer });
    return answer;
  }
}

/** Console-based interviewer for CLI usage */
export class ConsoleInterviewer implements Interviewer {
  private readline: typeof import("node:readline/promises") | null = null;

  async ask(question: Question): Promise<Answer> {
    // Lazy-load readline
    if (!this.readline) {
      this.readline = await import("node:readline/promises");
    }
    const rl = this.readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      console.log(`\n[?] ${question.text}`);

      if (question.type === QuestionType.MULTIPLE_CHOICE) {
        for (const opt of question.options) {
          console.log(`  [${opt.key}] ${opt.label}`);
        }
        const response = await rl.question("Select: ");
        const matched = question.options.find(
          (o) => o.key.toLowerCase() === response.trim().toLowerCase(),
        );
        if (matched) {
          return { value: matched.key, selectedOption: matched };
        }
        // Fallback to first
        if (question.options.length > 0) {
          return {
            value: question.options[0]!.key,
            selectedOption: question.options[0]!,
          };
        }
        return { value: response.trim() };
      }

      if (question.type === QuestionType.YES_NO || question.type === QuestionType.CONFIRMATION) {
        const response = await rl.question("[Y/N]: ");
        const isYes = response.trim().toLowerCase().startsWith("y");
        return { value: isYes ? AnswerValue.YES : AnswerValue.NO };
      }

      // Freeform
      const response = await rl.question("> ");
      return { value: response.trim(), text: response.trim() };
    } finally {
      rl.close();
    }
  }
}
