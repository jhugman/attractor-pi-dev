Break the RFC into implementation steps. Iterate on granularity until each step is:

- **Small enough** to be implemented safely with strong tests and no big complexity jumps.
- **Big enough** to move the project forward — not just boilerplate.
- **Self-contained** — testable in isolation, no orphaned or dead code.
- **Builds on the previous** — each step integrates into what came before.

Identify which steps can run in parallel (no shared dependencies) and which form a critical path.
