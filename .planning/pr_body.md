## Summary

Fixes implementation plan detection in the Antigravity planning UI — the chip selector was matching no chips at all, and a 5-second cooldown was preventing upgrade notifications from fileRefMode → button-based detection. After a live DOM inspection, the correct CSS classes were confirmed and the full Proceed+Open flow now surfaces correctly in Telegram.

## Related Issues

Closes # [Insert Issue Number if applicable]

## Type of Change

- [x] Bug fix

## What Changed

### Root Cause — Wrong Chip Selector
`ARTIFACT_CHIP_SELECTOR` required `cursor-pointer` as a class fragment on the chip container. Live DOM inspection showed the actual container classes are `border-gray-500/20 … select-none` — **`cursor-pointer` is only on inner elements, not the container.** This meant every pass 1-3 missed every chip, leaving only the 4th-pass (icon-based, `fileRefMode`) detection path active. `fileRefMode` synthesises an `Open` action but has no `proceedText`, so the Telegram notification never showed a Proceed button.

**Fix:** Updated selector to `div[class*="border-gray-500"][class*="select-none"]` — matches the actual DOM.

### Cooldown Upgrade Bypass
When the 4th pass fires first (Files Modified icon renders before the chip expands), the 5-second cooldown blocked the subsequent proper chip detection (different key, but within the window). Added an `isUpgrade` check: if the new detection has a `proceedText` and the previous one was `fileRefMode` or missing a proceed button, the cooldown is bypassed and a corrected notification is sent.

### Baseline Capture on Start
`start()` now asynchronously captures a DOM baseline **before** scheduling the first poll. This prevents pre-existing plan artifacts from previous sessions triggering false notifications on bot restart.

### fileRefMode Wiring (bot + services)
- `bot/index.ts`: `PLAN_PROCEED_BTN` for `fileRefMode` plans submits a synthetic "Proceed" message to the Antigravity chat input instead of clicking a non-existent button.
- `cdpBridgeManager.ts`: added `submitChatMessage()` helper.
- `responseMonitor.ts`: DOM queries are now scoped to the latest message only to prevent stale artifact detection.

## Checklist

- [x] Code follows the project's style guidelines
- [x] Self-reviewed the diff
- [x] Added/updated tests for the changes
- [x] `npm test` and `npm run build` pass locally (705 tests, 0 failures)
- [x] Tested manually in Telegram with Antigravity UI.
