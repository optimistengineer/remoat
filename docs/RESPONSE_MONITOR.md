# Response Monitor Architecture

> Real-time monitoring of Antigravity's AI responses via CDP (Chrome DevTools Protocol),
> with separate delivery of **output** and **activity logs** to Telegram.

---

## 1. System Overview

```
Telegram User
    |  prompt
    v
bot/index.ts  sendPromptToAntigravity()
    |  cdp.injectMessage(prompt)
    v
Antigravity (browser)  --- AI generates response in DOM ---
    ^
    |  CDP evaluate (4 calls / poll)
    |
ResponseMonitor.poll()
    |
    +---> onProgress(text)      --> Telegram "generating" message (output)
    +---> onProcessLog(text)    --> Telegram "process log" message (activity)
    +---> onPhaseChange(phase)  --> phase tracking
    +---> onComplete(text)      --> Telegram "complete" message (final)
```

### Key Files

| File | Role |
|------|------|
| `src/services/responseMonitor.ts` | CDP polling, DOM selectors, phase state machine |
| `src/bot/index.ts` | Telegram message rendering, callback wiring |
| `src/utils/telegramFormatter.ts` | Text formatting for Telegram (HTML formatting, UI chrome filtering) |
| `src/utils/logger.ts` | ANSI colored logger with level-based methods |

---

## 2. Dual Output Streams

ResponseMonitor produces **two independent streams** from the same DOM:

| Stream | Selector | Content | Telegram Message |
|--------|----------|---------|---------------|
| **Output** | `RESPONSE_TEXT` | Natural language AI response | "generating" / "complete" |
| **Process Log** | `PROCESS_LOGS` | Activity messages + tool output | "process log" |

This separation happens **at the DOM level** via CDP selectors, not via post-processing.
The `splitOutputAndLogs()` function in `telegramFormatter.ts` is a secondary classifier
for edge cases but is not the primary separator.

### Why Two Selectors?

In Antigravity's DOM, a single conversation turn contains:
- The AI's natural language response (the "output")
- MCP tool invocations and results (e.g., search queries, JSON payloads)
- Activity status messages (e.g., "Initiating Task Execution", "Thought for 38 seconds")

These are **interleaved in the same DOM tree** with no parent container distinguishing them.
A single selector cannot extract both; scored filtering classifies each node into one stream.

---

## 3. CDP Selectors (Scored Approach)

### 3.1 RESPONSE_TEXT

Extracts the **newest AI response text**, filtering out non-response content.

**Algorithm:**
1. Scope to `.antigravity-agent-side-panel` (fallback: `document`)
2. Query all nodes matching scored CSS selectors
3. Iterate in **reverse DOM order** (newest first: index N-1 -> 0)
4. For each node, apply content filters to skip non-response text
5. Keep the first (= newest) node with the highest score (`score > bestScore`, strict)

**Scored Selectors (priority descending):**

| Score | Selector | Typical Match |
|-------|----------|---------------|
| 10 | `.rendered-markdown` | Final rendered response |
| 9 | `.leading-relaxed.select-text` | Response text container |
| 8 | `.flex.flex-col.gap-y-3` | Message block |
| 7 | `[data-message-author-role="assistant"]` | Role-tagged message |
| 6 | `[data-message-role="assistant"]` | Alternative role tag |
| 5-2 | Various `[class*=...]` and `.prose` | Fallback selectors |

**Tie-Breaking Rule:**
- DOM order is normal: index 0 = oldest, N-1 = newest
- Reverse iteration visits newest first
- Strict `>` (not `>=`) keeps the first found = newest element
- This ensures previous-turn responses never shadow the current response

### 3.2 PROCESS_LOGS

Extracts text from nodes that **would be filtered out** by RESPONSE_TEXT.

**Algorithm:**
1. Same scope and selectors as RESPONSE_TEXT
2. Forward DOM order (chronological)
3. Collect text from nodes matching `looksLikeActivityLog()` or `looksLikeToolOutput()`
4. Truncate each entry to 300 chars
5. Return as array of strings

### 3.3 Content Filters

These functions run inside CDP (browser context) to classify DOM text:

| Filter | Matches | Examples |
|--------|---------|----------|
| `looksLikeActivityLog` | Short status messages | "Analyzing...", "Thought for 38 seconds", "Initiating Task Execution" |
| `looksLikeToolOutput` | MCP tool names, results, code blocks | "jina-mcp-server / search_web", "title: X url: Y snippet: Z", "json" |
| `looksLikeFeedbackFooter` | UI feedback buttons | "good", "bad", "good bad" |
| `isInsideExcludedContainer` | Hidden/feedback containers | Nodes inside `<details>`, `[class*="feedback"]`, `<footer>` |

### 3.4 STOP_BUTTON

Detects whether AI generation is in progress:
1. Check for `[data-tooltip-id="input-send-button-cancel-tooltip"]` (primary)
2. Fallback: scan all buttons for "stop" / "停止" text

### 3.5 DUMP_ALL_TEXTS (Diagnostic Only)

Returns **all** candidate text nodes with metadata (selector, score, filter classification).
Not called during normal polling. Available for manual debugging via CDP console.

### 3.6 QUOTA_ERROR

Scans for quota/rate-limit error banners outside of message content.

---

## 4. Polling & Phase State Machine

### 4.1 Poll Cycle (4 CDP Calls)

```
poll()
  |
  +-- 1. STOP_BUTTON      -> isGenerating (bool)
  +-- 2. QUOTA_ERROR       -> quotaDetected (bool)
  +-- 3. RESPONSE_TEXT     -> currentText (string | null)
  +-- 4. PROCESS_LOGS      -> logEntries (string[])
  |
  +-- Handle phase transitions
  +-- Forward callbacks
```

Default interval: **2000ms**. Max duration: **300000ms** (5 min).

### 4.2 Phase Transitions

```
waiting --> thinking --> generating --> complete
   |           |            |             |
   +--timeout--+--timeout---+--timeout----+
   |
   +--quotaReached (immediate, if no text)
```

| Transition | Trigger |
|------------|---------|
| waiting -> thinking | Stop button appears (`isGenerating = true`) |
| thinking -> generating | Text changes (non-null, differs from lastText) |
| generating -> complete | Stop button gone N consecutive times (default: 3) |
| any -> timeout | `maxDurationMs` elapsed |
| waiting -> quotaReached | Quota error detected with no existing text |

### 4.3 Baseline Suppression

At `start()`, the monitor captures the current RESPONSE_TEXT as `baselineText`.
During polling, if `currentText === baselineText` and no new text has been seen yet (`lastText === null`),
the text is suppressed — it belongs to the **previous conversation turn**, not the current one.

### 4.4 Process Log Baseline

At `start()`, all current PROCESS_LOGS entries are captured as `baselineProcessLogs` (Set).
During polling, only entries **not in the baseline** are forwarded to `onProcessLog`.
This prevents activity messages from previous turns leaking into the current turn's log.

### 4.5 Completion Detection (Stop-Gone Confirmation)

The stop button disappearing does not immediately mean completion — it can flicker.

```
Stop button gone -> stopGoneCount++
Stop button back -> stopGoneCount = 0 (reset)
stopGoneCount >= stopGoneConfirmCount (default: 3) -> complete
```

**Important:** Text changes do NOT reset `stopGoneCount`. The AI may stream trailing tokens
after the stop button disappears. Resetting on text change would cause infinite loops.

---

## 5. Callback Flow (bot/index.ts)

```
ResponseMonitor
  |
  |-- onPhaseChange(phase, text)
  |     Logged as: [INFO] phase=thinking textLen=0
  |
  |-- onProcessLog(logText)
  |     Updates lastActivityLogText
  |     Renders "process log" message via upsertLiveActivityMessages()
  |
  |-- onProgress(text)
  |     Calls splitOutputAndLogs(text) for secondary classification
  |     Renders "generating" message via upsertLiveResponseMessages()
  |     Also refreshes activity message with lastActivityLogText fallback
  |
  |-- onComplete(finalText)
  |     isFinalized = true
  |     Renders final "complete" message (output)
  |     Renders final "process log" message (lastActivityLogText)
  |     Handles quota warning, generated images, topic rename
  |
  |-- onTimeout(lastText)
  |     isFinalized = true
  |     Renders timeout message with partial text if available
```

### Message Queue System

Telegram message updates go through **three serial queues** to prevent race conditions:

| Queue | Purpose |
|-------|---------|
| `general` | One-shot messages (errors, status, mode info) |
| `response` | Output message updates (upsert pattern: create-or-edit) |
| `activity` | Process log message updates (upsert pattern: create-or-edit) |

Each queue processes tasks sequentially. Multiple queues run in parallel.
The `liveResponseUpdateVersion` / `liveActivityUpdateVersion` counters prevent
stale renders from overwriting newer content.

---

## 6. Logging Architecture

### 6.1 Log Levels (src/utils/logger.ts)

| Level | ANSI Color | Use Case |
|-------|------------|----------|
| `logger.error` | Red | Failures, exceptions |
| `logger.warn` | Yellow | Quota detection, timeout |
| `logger.info` | Cyan | Monitoring start |
| `logger.phase` | Magenta | Phase transitions (Thinking, Generating) |
| `logger.done` | Green | Completion event |
| `logger.divider` | Green+Dim | Section separators for finalize content blocks |
| `logger.debug` | Dim | Verbose diagnostic (not output in production) |

### 6.2 Log Output During Normal Operation

A typical successful run produces this structured output:

```
[INFO]  ── Monitoring started | poll=2000ms timeout=300s baseline=236ch
[PHASE] Thinking
[PHASE] Generating (186 chars)
[DONE]  Complete (236 chars)
[DONE]  ── Process Log ──────────────────────────────────
jina-mcp-server / search_web
title: 東京都の天気 url: ... snippet: ...
[DONE]  ── Output (236 chars) ──────────────────────────
2026年2月24日の東京の天気は、以下のようになっています...
[DONE]  ──────────────────────────────────────────────────
```

**Design principles:**
- **3 phases visible**: Monitoring started → Thinking → Generating → Complete
- **Process Log before Output**: Chronological order (tool use happens before response)
- **Full content in divider blocks**: Terminal reviewers see exactly what Telegram displays
- **No intermediate noise**: Text change diffs, partial previews, and stop-gone countdown are silent

### 6.3 Finalize Content Blocks

At completion, `bot/index.ts` outputs structured divider blocks via `logger.divider()`:

1. `── Process Log ──` block — Activity messages and tool output (same as Telegram's process log message)
2. `── Output (N chars) ──` block — Final response text (same as Telegram's complete message)
3. Closing `──────────` divider

### 6.4 What Is NOT Logged (by design)

To keep logs clean, the following are intentionally omitted from production output:

- Per-poll CDP results (stop button, text extraction, process logs)
- Text change diffs and partial text previews
- Stop-gone countdown (1/3, 2/3 — only completion is logged)
- Baseline text content (only length is shown at start)
- Process log intermediate updates (content only shown at finalize)
- Queue version skips and stale render events
- DUMP diagnostic entries (selector retained for manual debug only)

---

## 7. DOM Structure Assumptions

The selectors assume Antigravity's DOM follows this approximate structure:

```
.antigravity-agent-side-panel
  |
  +-- conversation turn 1 (oldest, DOM index 0)
  |     +-- .rendered-markdown  (previous response text)
  |     +-- .leading-relaxed    (activity messages)
  |     +-- .flex.flex-col      (tool output blocks)
  |
  +-- conversation turn 2
  |     +-- ...
  |
  +-- conversation turn N (newest, DOM index N-1)
  |     +-- .rendered-markdown  (current response text)  <-- RESPONSE_TEXT picks this
  |     +-- .leading-relaxed    (current activity)        <-- PROCESS_LOGS picks these
  |     +-- .flex.flex-col      (current tool output)     <-- PROCESS_LOGS picks these
  |
  +-- composer  div[role=combobox|textbox][contenteditable=true]
        +-- [data-tooltip-id="input-send-button-cancel-tooltip"]  <-- STOP_BUTTON picks this
```

> The composer element itself is the **write** target and belongs to `cdpService.ts`, not to
> `responseMonitor.ts` — see
> [Chat Input Field](ANTIGRAVITY_DOM_SELECTORS.md#12-chat-input-field-message-injection-target).
> Its ARIA role changed from `textbox` (v1) to `combobox` (Antigravity IDE v2); the stop button lives
> on the same composer component, so if completion detection ever reports "done" with an empty
> response, re-verify `[data-tooltip-id="input-send-button-cancel-tooltip"]` first.

**Key invariant:** DOM order is chronological (index 0 = oldest).
The reverse iteration in RESPONSE_TEXT ensures the newest turn's response wins.

---

## 8. Testing Strategy

### Test Files

| File | Tests | Coverage |
|------|-------|----------|
| `tests/services/responseMonitor.lean.test.ts` | 16 | Phase state machine, completion, baseline suppression, CDP call structure |
| `tests/services/responseMonitor.selectors.test.ts` | 15 | Content filter string matching (activity, tool output, feedback) |
| `tests/utils/telegramFormatter.test.ts` | 15 | UI chrome detection, splitOutputAndLogs, formatForTelegram |

### Mock Strategy

Tests use a minimal CDP mock (`call` + `getPrimaryContextId`) with no network event subscription.
The default mock returns `{ result: { value: null } }` for unmocked CDP calls,
which gracefully degrades (null is handled as "no data") without breaking tests.

### CDP Call Count Verification

The structural test verifies **1 CDP call per poll** (COMBINED_POLL in legacy mode)
and **2 CDP calls at start** (baseline text, baseline process logs).

---

## 9. Troubleshooting

### "Collecting Process Logs..." stays forever (logLen=0)

**Cause:** Process logs are extracted by `PROCESS_LOGS` selector and forwarded via `onProcessLog`.
If this callback never fires, check:
1. CDP connection is established (`cdp.isConnected()`)
2. Antigravity DOM has elements matching the selectors
3. Content filters are not over-filtering (all entries classified as non-activity/non-tool)

### Wrong text selected (previous turn's response)

**Cause:** Baseline suppression or tie-breaking issue.
1. Check that `baselineText` was captured correctly at `start()`
2. Verify DOM order hasn't changed (column-reverse CSS would break assumptions)
3. Tie-breaking uses strict `>` — if changed to `>=`, oldest text wins instead

### Old conversation entries appear in process logs

**Cause:** `baselineProcessLogs` Set didn't capture them at start.
1. Entries are compared by first 200 chars of text
2. If text content changed between baseline capture and poll, the entry won't match
3. Consider extending the comparison length or using a different identity key
