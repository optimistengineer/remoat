# Antigravity DOM Selectors Reference

Central reference for all CSS selectors and DOM structures used to interact with the Antigravity (Windsurf/Cascade) UI via CDP.

> Verified against a live Antigravity DOM. Read-path selectors (sections 1–11) were verified against
> **Antigravity v1.21.x** and re-checked on **Antigravity v2.0.x**. The write-path chat-input selector
> (section 12) is documented for both **v1** (`role="textbox"`) and **v2** (`role="combobox"`);
> the v2 tier ordering has not yet been confirmed against a live v2 instance — see the note in that
> section for how to confirm it from a bug report. Selectors may change with any Antigravity update.

> **Most load-bearing selector in the repo**: [§12 Chat Input Field](#12-chat-input-field-message-injection-target).
> It is the only *write* target — every other selector in this document only reads.

---

## Root Scope

All scripts scope queries to the side panel first, falling back to `document`.

```
.antigravity-agent-side-panel
```

**Used by**: All detectors, all scripts

---

## 1. User Message Bubble

The message a user types directly in the Antigravity chat input.

### Verified DOM Structure

```html
<div class="bg-gray-500/15 p-2 rounded-lg w-full text-sm select-text">
  <div class="flex flex-row items-end gap-2">
    <div class="flex-1 flex flex-col gap-2">
      <div>
        <div class="whitespace-pre-wrap text-sm" style="word-break: break-word;">
          {user message text}
        </div>
      </div>
    </div>
    <div> <!-- undo button: div[role="button"][data-tooltip-id^="undo-tooltip-"] --> </div>
  </div>
</div>
```

### Selectors

| Selector | Purpose | Strategy | File |
|----------|---------|----------|------|
| `[class*="bg-gray-500/15"][class*="select-text"] .whitespace-pre-wrap` | Direct text element query (last match = most recent) | A (primary) | `userMessageDetector.ts` |
| `[class*="bg-gray-500/15"][class*="rounded-lg"][class*="select-text"]` | User message bubble container (filtered: excludes parents with nested bubbles) | B (fallback) | `userMessageDetector.ts` |
| `.whitespace-pre-wrap` | User message text element inside bubble | B (fallback) | `userMessageDetector.ts` |
| `[style*="word-break"]` | User message text element (secondary fallback) | B (fallback) | `userMessageDetector.ts` |

> **Note**: Strategy A directly queries innermost text elements to avoid the parent-container problem where a wrapper div matches and returns concatenated text from multiple messages. Strategy B adds a filter to exclude parent containers that contain nested bubble elements.

---

## 2. AI Response Content

The assistant's response body, rendered with markdown formatting.

### Key Selectors (ordered by score/specificity)

| Score | Selector | Status | File |
|-------|----------|--------|------|
| 10 | `.rendered-markdown` | **Verified** | `responseMonitor.ts`, `assistantDomExtractor.ts` |
| 9 | `.leading-relaxed.select-text` | **Verified** | `responseMonitor.ts`, `planningDetector.ts`, `assistantDomExtractor.ts` |
| 8 | `.flex.flex-col.gap-y-3` | Unverified — generic | `responseMonitor.ts`, `assistantDomExtractor.ts` |
| 7 | `[data-message-author-role="assistant"]` | **NOT FOUND** in DOM | `responseMonitor.ts`, `assistantDomExtractor.ts` |
| 6 | `[data-message-role="assistant"]` | **NOT FOUND** in DOM | `responseMonitor.ts`, `assistantDomExtractor.ts` |
| 5 | `[class*="assistant-message"]` | **NOT FOUND** in DOM | `responseMonitor.ts`, `assistantDomExtractor.ts` |
| 4 | `[class*="message-content"]` | **NOT FOUND** in DOM | `responseMonitor.ts`, `assistantDomExtractor.ts` |
| 3 | `[class*="markdown-body"]` | **NOT FOUND** in DOM | `responseMonitor.ts`, `assistantDomExtractor.ts` |
| 2 | `.prose` | Unverified | `responseMonitor.ts`, `assistantDomExtractor.ts` |

> **Note**: Selectors scored 3-7 appear to be inherited from ChatGPT/generic patterns and do **not** exist in Antigravity's DOM. They are harmless (scored lower, never matched) but add noise. The top selectors (`.rendered-markdown`, `.leading-relaxed.select-text`) are the ones that actually match.

### Exclusion Containers

Nodes inside these containers are skipped during response extraction:

| Selector | Purpose |
|----------|---------|
| `details` | Thinking/tool-call collapsible sections |
| `[class*="feedback"], footer` | Good/Bad feedback buttons |
| `.notify-user-container` | Planning mode notification |
| `[role="dialog"]` | Modal dialogs (error popup, etc.) |

---

## 3. Chat Title (Header)

The currently active conversation title shown in the panel header.

### Selectors

| Selector | Purpose | File |
|----------|---------|------|
| `.antigravity-agent-side-panel` | Panel root | `chatSessionService.ts`, `cdpBridgeManager.ts` |
| `div[class*="border-b"]` | Header bar (first match inside panel) | `chatSessionService.ts`, `cdpBridgeManager.ts` |
| `div[class*="text-ellipsis"]` | Title text element (inside header) | `chatSessionService.ts`, `cdpBridgeManager.ts` |

Default/empty chat title: `"Agent"` (treated as no active chat)

---

## 4. New Chat Button

| Selector | Purpose | File |
|----------|---------|------|
| `[data-tooltip-id="new-conversation-tooltip"]` | New conversation button | `chatSessionService.ts` |

State detection: `cursor: pointer` = enabled, `cursor: not-allowed` = already empty chat

---

## 5. Stop / Cancel Button

| Selector | Purpose | File |
|----------|---------|------|
| `[data-tooltip-id="input-send-button-cancel-tooltip"]` | Stop generation button (primary) | `responseMonitor.ts` |
| `button, [role="button"]` with stop text patterns | Stop button (text fallback) | `responseMonitor.ts` |

Text patterns: `stop`, `stop generating`, `stop response`, `停止`, `生成を停止`, `応答を停止`

---

## 6. Past Conversations Panel

Selectors for opening, browsing, and selecting past conversations.

### Opening the Panel

| Priority | Selector | Purpose | File |
|----------|----------|---------|------|
| 1 | `[data-past-conversations-toggle]` | Toggle button (data attribute) | `chatSessionService.ts` |
| 2 | `[data-tooltip-id]` containing `history` or `past-conversations` | Tooltip-based lookup | `chatSessionService.ts` |
| 3 | `svg.lucide-history` | SVG icon class | `chatSessionService.ts` |

### Scraping Sessions

| Selector | Purpose | File |
|----------|---------|------|
| `div[class*="overflow-auto"], div[class*="overflow-y-scroll"]` | Scrollable conversation list container | `chatSessionService.ts` |
| `div[class*="text-xs"][class*="opacity"]` | Section header (e.g. "Other Conversations") — used as boundary to exclude other-project sessions | `chatSessionService.ts` |
| `div[class*="cursor-pointer"]` | Session row items (rows below "Other Conversations" boundary are skipped) | `chatSessionService.ts` |
| `span.text-sm span, span.text-sm` | Session title text | `chatSessionService.ts` |
| `/focusBackground/i` (className regex) | Active/current session indicator | `chatSessionService.ts` |

### Show More

| Selector | Purpose | File |
|----------|---------|------|
| `div, span` with text matching `/^Show\s+\d+\s+more/i` | "Show N more..." link | `chatSessionService.ts` |

---

## 7. Approval Buttons

Tool permission dialog (Allow/Deny).

### Detection

| Selector | Purpose | File |
|----------|---------|------|
| `button` (all visible) | Scan for allow/deny text patterns | `approvalDetector.ts` |
| `[role="dialog"], .modal, .dialog, .approval-container, .permission-dialog` | Dialog container | `approvalDetector.ts` |
| `p, .description, [data-testid="description"]` | Action description text | `approvalDetector.ts` |

### Button Text Patterns

- **Allow Once**: `allow once`, `allow one time`, `今回のみ許可`, `1回のみ許可`, `一度許可`
- **Always Allow**: `allow this conversation`, `allow this chat`, `always allow`, `常に許可`, `この会話を許可`
- **Allow**: `allow`, `permit`, `許可`, `承認`, `確認`
- **Deny**: `deny`, `拒否`, `decline`

---

## 8. Planning Mode / Artifact Cards

Open button (with optional Proceed button) for plan and artifact review.

### Detection

**Crucial Note:** The assistant container `[data-message-author-role="assistant"]` does NOT exist in Antigravity. To prevent erroneously detecting older planning cards or infinite "Planning dialog active" deferral loops, all artifact card searches must be positionally scoped to follow the last user message using `Node.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING` (value 4). Furthermore, you must **reverse-iterate** over found artifact cards to interact with the newest one first.

| Selector | Purpose | File |
|----------|---------|------|
| `.notify-user-container` (last in DOM, or within latest msg) | Planning notification container | `planningDetector.ts` |
| `div[class*="border"][class*="rounded-lg"]` (within latest msg) | Fallback card container for artifact chips | `planningDetector.ts` |
| `span[class*="inline-flex"][class*="cursor-pointer"]` | Clickable artifact chip (for auto-expansion if buttons are hidden) | `planningDetector.ts` |
| `span.inline-flex.break-all` | Plan title (file name) | `planningDetector.ts` |
| `span.text-sm` | Plan summary text | `planningDetector.ts` |
| `.leading-relaxed.select-text` | Plan description body | `planningDetector.ts` |

### Plan Content (after Open)

| Selector | Purpose | File |
|----------|---------|------|
| `div.relative.pl-4.pr-4.py-1, div.relative.pl-4.pr-4` | Plan content container | `planningDetector.ts` |
| `.leading-relaxed.select-text` (inside container) | Rendered plan content | `planningDetector.ts` |

---

## 9. Error Popup

Agent termination / unexpected error dialogs.

### Detection

| Selector | Purpose | File |
|----------|---------|------|
| `[role="dialog"], [role="alertdialog"], .modal, .dialog` | Dialog elements | `errorPopupDetector.ts` |
| `div[class*="fixed"], div[class*="absolute"]` with z-index > 10 | Overlay fallback | `errorPopupDetector.ts` |
| `h1, h2, h3, h4, [class*="title"], [class*="heading"]` | Error title extraction | `errorPopupDetector.ts` |

### Error Text Patterns

`agent terminated`, `terminated due to error`, `unexpected error`, `something went wrong`, `an error occurred`

---

## 10. Quota Error

Model quota reached / rate limit detection.

### Detection

| Selector | Purpose | File |
|----------|---------|------|
| `h3 span, h3` | Quota popup heading text | `responseMonitor.ts` |
| `span` (all) | Inline quota error text | `responseMonitor.ts` |
| `[role="alert"], [class*="error"], [class*="warning"], [class*="toast"], [class*="banner"], [class*="notification"], [class*="alert"], [class*="quota"], [class*="rate-limit"]` | Semantic error containers | `responseMonitor.ts` |

### Quota Keywords

`model quota reached`, `rate limit`, `quota exceeded`, `exhausted your quota`, `exhausted quota`

### isInsideResponse Guard

Quota text is only matched outside response containers to avoid false positives:

```
.rendered-markdown, .prose, pre, code,
[data-message-author-role="assistant"],
[data-message-role="assistant"],
[class*="message-content"]
```

---

## 11. Code Blocks (inside AI response)

Antigravity renders code blocks in a non-standard way.

### Structure

```html
<pre>
  <div class="font-sans text-sm ..."> <!-- language label header --> </div>
  <div class="...rounded-t...border-b..."> <!-- copy button header bar --> </div>
  <style>...</style> <!-- injected CSS -->
  <div class="code-line">line 1</div>
  <div class="code-line">line 2</div>
</pre>
```

### Selectors (used in normalization)

| Selector | Purpose | File |
|----------|---------|------|
| `.font-sans.text-sm` | Language label div | `assistantDomExtractor.ts` |
| `[class*="text-sm"][class*="opacity"]` | Language label fallback | `assistantDomExtractor.ts` |
| `style` | Injected CSS (removed during normalization) | `assistantDomExtractor.ts` |
| `[class*="rounded-t"][class*="border-b"]` | Header bar (removed during normalization) | `assistantDomExtractor.ts` |
| `.code-line, [class*="code-line"]` | Individual code lines | `assistantDomExtractor.ts` |

---

## 12. Chat Input Field (message injection target)

The composer that remoat types into. **This is the only selector in this document that writes to the
DOM**, and a wrong resolution is not a "message fails to send" bug — see [Data-loss hazard](#data-loss-hazard)
below.

**Defined in**: `cdpService.ts` (`CHAT_INPUT_CANDIDATES`, `CHAT_INPUT_EXCLUDE_ALWAYS`,
`CHAT_INPUT_EXCLUDE_BROAD`, `buildFocusChatInputScript`) — **used by**: `focusChatInput()`,
`injectMessage()`, `injectMessageWithImageFiles()`.

### Version differences

| Antigravity version | Composer element |
|---------------------|------------------|
| v1 (`Antigravity`) | `div[role="textbox"][contenteditable="true"]` |
| v2 (`Antigravity IDE`) | `div[role="combobox"][contenteditable="true"]` |

The `contenteditable="true"` attribute is stable across both; only the ARIA role changed. This is what
broke message injection with `Chat input field not found` on v2 (issue #15).

### Ordered candidate ladder

Resolution is an **ordered tier ladder**, not a flat selector union. Tier 0 is tried first; the first
tier that yields a visible, non-excluded match wins and **tiers are never merged**.

| Tier | Selector | Targets |
|------|----------|---------|
| 0 | `.antigravity-agent-side-panel div[role="combobox"][contenteditable="true"]` | v2, panel-scoped |
| 1 | `.antigravity-agent-side-panel div[role="textbox"][contenteditable="true"]` | v1, panel-scoped |
| 2 | `.antigravity-agent-side-panel div[role="textbox"]` | v1 without `contenteditable` |
| 3 | `#conversation div[role="combobox"][contenteditable="true"]` | v2, conversation-scoped |
| 4 | `#conversation div[role="textbox"][contenteditable="true"]` | v1, conversation-scoped |
| 5 | `#conversation div[role="textbox"]` | v1, conversation-scoped |
| 6 | `.antigravity-agent-side-panel div[contenteditable="true"]` | either, role dropped |
| 7 | `#conversation div[contenteditable="true"]` | either, role dropped |
| 8 | `div[role="combobox"][contenteditable="true"]` | v2, **unscoped** |
| 9 | `div[role="textbox"][contenteditable="true"]` | v1, **unscoped** |
| 10 | `div[role="textbox"]:not(.xterm-helper-textarea)` | the legacy pre-v2 selector, kept verbatim |
| 11 | `div[contenteditable="true"]` | last resort, gated by a positive label signal |

`CHAT_INPUT_BROAD_TIER_START = 8` marks where tiers stop being scoped to the Antigravity panel.

Notes:

- **Every tier keeps the `div` tag qualifier.** VS Code's Quick Open, Settings select boxes, find
  inputs, the explorer inline-rename box and the terminal find widget are all
  `<input>`/`<select>`/`<textarea>`, so `div` excludes them for free. Do not drop it.
- **Tier 10's `:not(.xterm-helper-textarea)` is a no-op** (xterm's helper is a `<textarea>`, not a
  `div`). The *selector string* is retained verbatim, but tier 10 does **not** reproduce the exact
  pre-v2 behaviour: like every tier it is additionally subject to `CHAT_INPUT_EXCLUDE_ALWAYS`, the
  40×8 size gate, and (being ≥ `CHAT_INPUT_BROAD_TIER_START`) `CHAT_INPUT_EXCLUDE_BROAD`. When
  triaging a v1-only regression, check those three deltas first.
- **Tier 11 requires a positive signal**: the element's `aria-label` / `data-placeholder` /
  `placeholder` must match `/chat|message|ask|plan|prompt/`. Without that gate, a bare
  `div[contenteditable="true"]` matches far too much.
- **Within a tier, the LAST visible match wins.** The v1 panel contains several textboxes and the
  composer is the last one. This is a deliberately preserved behaviour, not an accident.

### Exclusion lists (and why they are split)

`CHAT_INPUT_EXCLUDE_ALWAYS` — applied to **every** tier via `el.closest(...)`:

| Selector | Why |
|----------|-----|
| `.xterm` | Integrated terminal — typing here would run shell commands |
| `.xterm-helper-textarea` | xterm's hidden a11y input |
| `[aria-hidden="true"]` | Off-screen / unmounted React subtrees |
| `.monaco-editor`, `.native-edit-context`, `.inputarea` | Embedded code editors — the data-loss target. The agent panel renders Monaco inline (code blocks, diff views), so these must be excluded even in panel-scoped tiers: a decoy after the composer would otherwise win via last-visible-match at tier 6/7 |

`CHAT_INPUT_EXCLUDE_BROAD` — applied **only** to unscoped tiers (index >= `CHAT_INPUT_BROAD_TIER_START`):

| Selector | Why |
|----------|-----|
| `.quick-input-widget`, `.monaco-inputbox`, `.monaco-findInput` | Quick Open, find/replace, input boxes |
| `.suggest-widget`, `.monaco-list` | Autocomplete popups and the explorer inline-rename box |
| `.interactive-input-part`, `.repl-input-wrapper` | Notebook / REPL cell inputs |
| `.scm-editor`, `.comment-form` | SCM commit message box, review comment editors |
| `[role="searchbox"]` | Search widgets |

**Why the split**: the broad list contains workbench-level widgets (Quick Open, SCM box, find
inputs) that render at the document root and can never appear inside the Antigravity panel, so the
scoped tiers don't pay for them. The Monaco guards live in the always list because Monaco *can*
appear inside the panel; this is safe because the composer is a Lexical-style contenteditable in
both v1 and v2 (see the version table above), never a Monaco editor — if that ever changes, the
`.monaco-editor` entry must move back to the broad list.

### Resolution loop: tiers OUTER, execution contexts INNER

`focusChatInput()` iterates **tiers on the outside and CDP execution contexts on the inside**:

```
for tier in 0..11:
    for context in contexts:
        Runtime.evaluate(buildFocusChatInputScript(tier), contextId=context)
        if ok: return
```

A tier-0 hit in the third context beats a tier-8 hit in the first context. Inverting the loops "for
efficiency" would let a webview or iframe execution context win with a low-specificity match before
the real workbench context is ever tried at a higher tier. The happy path is 1–2 round-trips (tier 0
hits). The 12 × N-contexts worst case only occurs on total failure and is bounded: each ladder scan
has a 15 s budget (`FOCUS_LADDER_BUDGET_MS`) enforced at **tier boundaries only** — every tier that
starts gets a full pass over the contexts, so a single timed-out evaluate (the per-call CDP timeout
can equal or exceed the budget) cannot abort the ladder before the context holding the composer is
probed. A budget abort fails with the distinct `Chat input resolution timed out`, and a context whose
evaluate times out once is skipped for all remaining tiers.

After a successful focus, a negative guard (`verifyChatInputFocused`) checks that
`document.activeElement` is not a known-wrong widget (Monaco, xterm, quick input). On rejection the
ladder **resumes at the next tier** (`focusChatInputVerified`) instead of failing terminally; only
when the ladder is exhausted does injection fail with `Chat input focus verification failed`.

### `data-remoat-chat-input` — a cross-service contract

The winning element is tagged `data-remoat-chat-input="1"`, and any previous holder has the attribute
removed first.

This attribute is **not** decoration:

- `cdpService.ts` writes it in `buildFocusChatInputScript`.
- `chatSessionService.ts`'s `findSearchInput()` **skips** any element carrying it, because under v2
  the composer newly satisfies that function's
  `input, textarea, [role="combobox"], [role="searchbox"], [contenteditable="true"]` union. Without the
  guard, the Past Conversations flow would type a conversation *title* into the chat box and press
  Enter, sending it to the agent as a prompt.

Changing or removing the attribute silently breaks that collision guard. `findSearchInput()` also
carries two independent fallback guards (element shape, and an `#conversation` /
`.antigravity-agent-side-panel` ancestor check) precisely because React re-renders can drop the
attribute.

### Data-loss hazard

`injectMessage()` runs `clearInputField()` immediately after focusing, which dispatches
**Cmd/Ctrl+A followed by Backspace** to whatever `document.activeElement` currently is, then
`Input.insertText` types the Telegram message into it, then presses Enter. If the wrong element is
focused, that sequence **wipes the user's open source file and types the Telegram message into it**.

Two mitigations exist and must be kept:

1. The ordered ladder above (specific before broad, scoped before unscoped).
2. `verifyChatInputFocused()` — a **negative** guard that runs between focus and `clearInputField()`
   and aborts with `Chat input focus verification failed` if `document.activeElement` is inside
   `.monaco-editor`, `.xterm`, `.native-edit-context`, `.quick-input-widget` or `.monaco-inputbox`.
   It is deliberately negative (reject known-wrong widgets) rather than positive (require the
   `data-remoat-chat-input` tag), because a React re-render that drops the tag would otherwise break
   every send. Evaluate failures are treated as a pass.

### Diagnosing a future break

`focusChatInput()` logs `Chat input matched tier N (<selector>) in context M` at debug level. Ask a
reporter to run with `LOG_LEVEL=debug` and include that line: it tells you immediately whether the
panel scoping still holds (tier 0–7) or whether resolution fell through to the unscoped tiers, which
still work but with weaker guarantees. `Chat input not found after 12 selector tiers across N contexts`
is logged at warn level when everything fails.

Tests: `tests/services/cdpService.chatInputSelector.test.ts` (pure-DOM tier resolution),
`tests/services/cdpService.injection.test.ts` (tier ordering over CDP),
`tests/services/chatSessionService.searchInput.test.ts` (the collision guard).

---

## 13. Conversation Feed Scroll Container (auto-scroll, issue #4)

**Defined in**: `cdpService.ts` (`buildScrollFeedToBottomScript`) — **used by**:
`scrollConversationToBottom()`, called after `injectMessage()` /
`injectMessageWithImageFiles()` send a prompt and by `ScreenshotService.capture()`
before `Page.captureScreenshot`.

There is no stable class or id on the scrollable feed element itself, so it is found
structurally rather than by name:

1. Root: `#conversation`, falling back to `.antigravity-agent-side-panel`.
2. Within the first root that yields a hit: every element (root included) with
   `scrollHeight > clientHeight + 4` **and** a computed `overflow-y` of
   `auto`/`scroll`/`overlay`.
3. The **tallest** such element (largest `scrollHeight`) is taken as the feed and
   pinned via `scrollTop = scrollHeight`.

Best-effort by design: `scrollConversationToBottom()` never throws and a miss is
logged at debug level only — a stale scroll position is cosmetic. It is deliberately
NOT called from `responseMonitor`'s 2-second poll loop: re-pinning on every poll
would fight a user who scrolled up on purpose in the IDE.

Tests: `tests/services/cdpService.scrollFeed.test.ts` (pure-DOM),
`tests/services/cdpService.injection.test.ts` (runs after Enter, composer context),
`tests/services/screenshotService.test.ts` (runs before capture).

---

## Maintenance Notes

### When Antigravity updates its DOM

See [DOM Inspection Guide](dom-inspection-guide.md) for the full verification procedure (DevTools connection, selector testing, stability evaluation).

1. Connect DevTools to Antigravity and inspect the current DOM structure
2. Update this document with new selectors and their verified status
3. Update the affected detector/extractor source files
4. Run `npm test` to verify no regressions

### Known dead selectors (safe to remove)

The following selectors exist in `responseMonitor.ts` and `assistantDomExtractor.ts` but have **never matched** in Antigravity's DOM. They are inherited from ChatGPT/generic patterns and only serve as defensive fallbacks:

- `[data-message-author-role="assistant"]` (score 7)
- `[data-message-role="assistant"]` (score 6)
- `[class*="assistant-message"]` (score 5)
- `[class*="message-content"]` (score 4)
- `[class*="markdown-body"]` (score 3)

These can be safely removed if desired, as they never match and the higher-scored selectors (`.rendered-markdown`, `.leading-relaxed.select-text`) are the ones that actually work.

### Previously broken selectors (fixed)

- `[data-message-author-role="user"]` — Used in `userMessageDetector.ts` before fix. **Does not exist** in Antigravity DOM. Replaced with `[class*="bg-gray-500/15"][class*="rounded-lg"][class*="select-text"]` (commit `8285624`).
- Single bubble query `[class*="bg-gray-500/15"][class*="rounded-lg"][class*="select-text"]` without parent filter — Matched parent wrapper containers containing multiple user messages, causing echo duplication and previous-prompt pickup bugs. Fixed by adding Strategy A (direct text element query) + Strategy B (parent filter).
- `div[role="textbox"]:not(.xterm-helper-textarea)` — the chat input (message injection target) before **Antigravity IDE v2**. v2 changed the composer's ARIA role from `textbox` to `combobox` (it stays `contenteditable="true"`), so every message injection failed with `Chat input field not found`. Replaced by the ordered candidate ladder in [§12](#12-chat-input-field-message-injection-target), which covers both roles, scopes to the agent panel first, and excludes Monaco / terminal / quick-input widgets (issue #15). The old selector is retained verbatim as tier 10. A flat union such as `div[role="textbox"]:not(...), div[contenteditable="true"]:not(...)` was **rejected**: combined with "last visible match wins" it can select the open Monaco editor, and `clearInputField()` would then wipe the user's file.
