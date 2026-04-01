# Stabilizing Artifact and Plan Detection via DOM Pivot

The recent logs reveal an infinite `[INFO] [ResponseMonitor] Planning dialog active — deferring completion` loop that continues endlessly even after the 119-character generation halts.

## Discoveries & Root Cause

1. **Non-Existent Assistant Selector**: `[data-message-author-role="assistant"]` doesn't exist, which meant queries were effectively falling back to `document` — thereby retrieving old UI elements from previous chat history.
2. **Infinite Deferral Loop**: Because `ResponseMonitor` checks the entire `document` for `button` elements matching "Open" or "Proceed", it trivially found buttons belonging to past implementation plans. It thereby falsely deduced that the *current* generation was awaiting approval, preventing the turn from ever concluding.
3. **Forward Iteration Auto-Click Disaster**: `planningDetector` iterated `cards` starting from index 0 (`for (const card of cards)`). It effectively located the OLDEST artifact card in the chat history, clicked it, and perpetually scraped its content over the current one.

To fix this, we will pivot to finding the **last user message bubble** and filtering any subsequent elements using the native DOM API `Node.compareDocumentPosition()`. By enforcing reverse-iteration (`for (let i = cards.length - 1; i >= 0; i--)`), we guarantee interaction with the true, most recent artifact exclusively.

## User Review Required

> [!IMPORTANT]
> This change radically improves the stability of detecting when the agent is "thinking" vs when it has produced an actionable implementation plan. Stale detections and infinite deferrals will vanish. Are you okay with this DOM pivot approach?

## Proposed Changes

### `src/services/ResponseMonitor.ts`

#### [MODIFY] `src/services/ResponseMonitor.ts`
- **`PLANNING_ACTIVE` Script:** Replace the `latestMsg` logic with `lastUserMsg` filtering. Filter containers and buttons such that `(lastUserMsg.compareDocumentPosition(el) & 4) !== 0`.
- **`COMBINED_POLL` Script:** Apply the identical `lastUserMsg` filtering to the `planningActive` block to ensure `ResponseMonitor` ignores previous artifacts.
- Enforce reverse-iteration over artifact cards when scanning for "Open" or "Proceed" buttons inside collapsed chips.

---

### `src/services/planningDetector.ts`

#### [MODIFY] `src/services/planningDetector.ts`
- **`buildDetectPlanningScript`**: Update logic to select the last user message container via `[class*="bg-gray-500/15"][class*="rounded-lg"][class*="select-text"]` (ignoring parents) and strictly ignore any `.notify-user-container` or `div[class*="border"][class*="rounded-lg"]` that appears BEFORE the user's prompt (using `Node.DOCUMENT_POSITION_FOLLOWING`). Reverse the `<div class="border rounded-lg">` iteration to find the latest valid chip.
- **`EXTRACT_PLAN_CONTENT_SCRIPT`**: Refactor primary and fallback selectors from `querySelector` (which grabs the first global match) to `querySelectorAll`, subsequently retrieving the *last* DOM node that exists *after* the `lastUserMsg`. Reverse loops on alternative MD container checks.

---

### `docs/ANTIGRAVITY_DOM_SELECTORS.md`

#### [MODIFY] `docs/ANTIGRAVITY_DOM_SELECTORS.md`
- **Section 2 (AI Response Content):** Note that `[data-message-author-role="assistant"]` and similar selectors are permanently dead/unreliable.
- **Section 8 (Planning Mode):** Document the new standard: Always scope Artifact and Planning containers by asserting they positionally follow the last User Message using `compareDocumentPosition(& 4)`.

## Verification Plan

### Automated Tests
- Run `npm test` to ensure syntactic and logic safety.

### Manual Verification
- Restart `remoat start`.
- Open a plan on Telegram, confirm Remoat gets past the infinite `Planning dialog active` loop properly.
- Verify `Open` expands the right *new* plan content instead of the old one.
