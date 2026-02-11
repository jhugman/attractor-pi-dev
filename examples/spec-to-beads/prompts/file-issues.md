Create a beads issue for each implementation step. Every issue must include:

1. **What**: one-paragraph summary of the deliverable.
2. **RFC quotes**: the specific RFC sections this issue implements (block-quoted).
3. **Location**: file paths and line numbers of code to create or modify.
4. **Current code state**: what exists today that's relevant (structs, traits, methods, their signatures).
5. **Implementation approach**: enough guidance that an implementer doesn't need to re-derive the design, but not so much that it's writing the code.
6. **Tests**: concrete test cases (not vague "add tests"). Name the scenarios and expected outcomes.

Wire up dependency edges with `br dep add`. Collect all issues under a new epic.

The **final issue** is the definition of done — a comprehensive end-to-end scenario script.

The script must be named `./scenarios/NNN-SHORT_NAME.sh` (where NNN is the next available number) and can use functions and definitions from `scenarios/lib.sh`. It must:
- Tell realistic user stories exercising every feature of the epic.
- Make concrete assertions (exit codes, log patterns, CLI output).
— Document the features: a user should be able to read the scenario and learn how to use every feature in the RFC.
- Document how to control test conditions (e.g. mock files, env vars, short timeouts).

The issue should specify that if the scenario doesn't run cleanly, the production code needs systematic debugging until it does. Once the new scenario passes, `./scenarios/run-all.sh` must also be run. If any existing scenarios have broken, those must be fixed too with systematic debugging.
