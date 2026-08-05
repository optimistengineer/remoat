# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Auto-scroll the Antigravity conversation feed to its bottom after sending a prompt and before `/screenshot` captures, so the IDE view and screenshots always show the latest agent output ([#4](https://github.com/optimistengineer/remoat/issues/4))

### Fixed
- Support Antigravity IDE v2 — existence-based executable/app-bundle resolution with v1 fallback, ordered chat-input selector ladder covering the new `role="combobox"` composer, and correct handling of install paths containing spaces on Windows ([#15](https://github.com/optimistengineer/remoat/issues/15))

## [0.2.14] - 2026-04-03

### Fixed
- Prevent tool-call output leakage by scoping extraction to first assistant-body segment ([#12](https://github.com/optimistengineer/remoat/pull/12))
- Support walkthrough artifacts that lack Proceed buttons — thanks [@jacob-bd](https://github.com/jacob-bd) ([#7](https://github.com/optimistengineer/remoat/pull/7))
- Wire `fileRefMode` plan actions through bot and supporting services for planning detector
- Correct planning detector chip selector and add upgrade re-notification
- Block DOM queries to latest message only in response monitor to prevent stale artifact detection
- Restrict planning mode detection to latest message only
- Make injection test platform-aware for key modifier (Cmd vs Ctrl)

### Removed
- Dead code cleanup: unused `auth` middleware and `processLogBuffer` utility — thanks [@jacob-bd](https://github.com/jacob-bd) ([#9](https://github.com/optimistengineer/remoat/pull/9))
- Replaced empty `catch {}` blocks with `logger.debug()` calls in CDP bridge and connection pool

### Added
- CI workflow for PRs and pushes to main

## [0.2.13] - 2026-03-28

### Fixed
- Detect Run/Reject terminal command approval buttons and forward to Telegram (fixes [#5](https://github.com/optimistengineer/remoat/issues/5))
  - Added `run`/`execute` to allow patterns and `reject` to deny patterns
  - Fixed container lookup walking up ancestors to find both approve and deny buttons
  - Telegram inline keyboard now shows actual button labels from Antigravity UI
  - "Allow Chat" button only shown when available (not for terminal command approvals)

## [0.2.12] - 2026-03-28

### Fixed
- Fix stale incremental build cache that omitted `antigravityLauncher` from the published package

## [0.2.11] - 2026-03-28

### Fixed
- Restore compatibility with Antigravity v1.21.6 DOM changes — thanks [@jacob-bd](https://github.com/jacob-bd) ([#6](https://github.com/optimistengineer/remoat/pull/6))
  - Model picker selectors updated for `<button>` elements (previously `<div>`)
  - Chat panel readiness detection via `#conversation` element (cascade-panel iframe removed)
  - Bare `<pre>` blocks (pipe tables) no longer produce orphan `</pre>` tags causing Telegram 400 errors
  - `<p>` regex no longer incorrectly matches `<pre>` tags

## [0.2.2] - 2026-03-02

### Changed
- Setup wizard and boot logo replaced with sleeping dog ASCII art
- Workspace directory prompt (step 3) now supports Tab-completion for directory paths
- Step 3 description clarifies that subdirectories become `/project` entries and how to change later

## [0.2.1] - 2026-03-02

### Fixed
- Per-workspace prompt locking — two topics bound to the same workspace no longer dispatch concurrent prompts (prevents garbled DOM polling)
- `/stop` now resolves the workspace from the sender's channel binding instead of using the global last-active workspace
- `splitOutputAndLogs` skipped for structured HTML output — the plain-text splitter was stripping valid HTML content lines
- HTML entity handling in Telegram messages — `&amp;`, `&lt;`, `&gt;` now preserved correctly (fixes broken messages containing `&` or literal HTML)
- Streaming code block freeze — `</code></pre>` now emitted correctly for language-annotated blocks, including emergency close
- `/cleanup` callback data now encodes the days parameter (previously deleted all sessions regardless of age)
- CDP workspace name regex fix (`\\s` → `\s`)
- `remoat open` on Windows no longer hangs (replaced blocking `execFile` with `spawn` + `detach`)
- `remoat doctor` now checks `config.json` in addition to `.env` for required variables
- Session title verification is now case-insensitive (fixes false failures on `/chat`)
- CDP error objects wrapped in `Error` instances so downstream `.message` checks work
- `updateCheckService` now applies its timeout to `https.get` (previously could hang forever)
- Session picker and model UI truncate callback data to fit Telegram's 64-byte limit
- `.jpg` images now report `image/jpeg` MIME type instead of non-standard `image/jpg`
- Cleanup cutoff date formatted to match SQLite's `datetime()` format
- `responseMonitor` passes `meta` to `onComplete` on the quota-exhaustion path
- Progress sender HTML-escapes chunks before wrapping in `<pre>` tags
- `userStopRequestedChannels` cleared on error path to prevent stale state
- CLI default action returns async promises for proper error handling

### Added
- Homebrew tap install (`brew tap optimistengineer/remoat && brew install remoat`)
- MIT LICENSE file
- Published to npm as `remoat@0.2.0`

### Changed
- README: added Homebrew install option, removed failing CI/npm badges, fixed model name examples
- CONTRIBUTING: fixed broken `#setup-guide` anchor, removed dead ROADMAP.md reference
- CODE_OF_CONDUCT and SECURITY: replaced placeholder email with GitHub links

## [0.2.0] - 2026-02-15

### Added
- Structured DOM extraction with HTML-to-Telegram conversion (Phase 1 of DOM overhaul)
- Activity emoji classification (thinking, file ops, active ops, MCP tools)
- Planning mode detection — surface plan/proceed decisions in Telegram
- Error popup detection and reporting
- Quota error detection with improved popup and inline pattern matching
- Project list pagination for workspaces with 25+ projects
- Dialog exclusion from activity scan (`role="dialog"` containers)
- Voice message support via local whisper.cpp transcription
- Image attachment forwarding to Antigravity
- `/autoaccept` command for toggling auto-approval of file edit dialogs
- `/cleanup` command for pruning inactive session topics
- `/status` command with connection state, active project, and mode info
- `remoat doctor` with colored output and expanded environment checks
- Invite link auto-generation during `remoat setup`
- Startup dashboard with system info on bot launch
- i18n support (English and Japanese)

### Changed
- Default extraction mode changed from `innerText` to `structured`
- Response completion detection now uses stop-button absence (3 consecutive checks) instead of timeout
- Approval dialogs now route to the correct Telegram topic

### Fixed
- Sessions drifting when Antigravity UI is used directly
- `/stop` command accidentally triggering voice recording
- Messages in old topics leaking to the latest session
- Process log content bleeding into final response output

## [0.1.0] - 2026-01-20

### Added
- Initial release
- Telegram bot with grammy framework (long-polling, no webhooks)
- CDP integration for controlling Antigravity via WebSocket
- Response monitoring with DOM polling at 2-second intervals
- Project management via Telegram Forum Topics
- Session management with SQLite persistence
- CLI with `setup`, `start`, `open`, and `doctor` subcommands
- Prompt templates (`/template`, `/template_add`, `/template_delete`)
- Model switching (`/model`) and mode switching (`/mode`)
- Screenshot capture (`/screenshot`)
- Whitelist-based authentication middleware
- Input sanitization middleware
- Path traversal prevention
- Auto-reconnect on CDP disconnect (up to 3 retries)
- Message chunking for responses exceeding Telegram's 4096-char limit
- macOS and Windows launcher scripts for Antigravity with CDP

[0.2.1]: https://github.com/optimistengineer/Remoat/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/optimistengineer/Remoat/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/optimistengineer/Remoat/releases/tag/v0.1.0
