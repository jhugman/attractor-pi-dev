Re-read every issue in dependency order. For each, mentally trace from the previous issue's output to this issue's starting point. Flag:

- **RFC gaps**: any RFC section not covered by an issue.
- **Ambiguity or large jumps**: missing intermediate steps, implicit assumptions, hidden dependencies between issues.
- **Redundancy**: work duplicated across issues or code that will be written then immediately rewritten.

If the human selected "Re-review", pay extra attention to the area they flagged (check `human.gate.label` for context — e.g., "Gaps in RFC coverage" or "Issues too big, split them").

Apply unambiguous fixes directly. Present choices to the user for anything with multiple valid options.
