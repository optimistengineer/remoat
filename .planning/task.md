# Implementation Tasks

- `[/]` Update `src/services/ResponseMonitor.ts`
  - `[ ]` Update `PLANNING_ACTIVE` script with `lastUserMsg` filtering.
  - `[ ]` Update `COMBINED_POLL` script with `lastUserMsg` filtering and reverse iteration.
- `[ ]` Update `src/services/planningDetector.ts`
  - `[ ]` Update `buildDetectPlanningScript` to enforce `lastUserMsg` scoping and reverse iteration.
  - `[ ]` Update `EXTRACT_PLAN_CONTENT_SCRIPT` to enforce `lastUserMsg` scoping and proper `querySelectorAll` behavior.
- `[ ]` Update `docs/ANTIGRAVITY_DOM_SELECTORS.md`
  - `[ ]` Document the deprecation of `[data-message-author-role="assistant"]`.
  - `[ ]` Document the new DOM Pivot logic requirement.
- `[ ]` Verification
  - `[ ]` Run `npm test`.
  - `[ ]` Restart `remoat start` and ask user to test manually.
