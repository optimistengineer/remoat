/**
 * @jest-environment jsdom
 *
 * Pure-DOM verification of the chat-input tier ladder.
 *
 * A real DOM (jsdom) is used rather than the hand-rolled mock document of
 * responseMonitor.stopButtonSelector.test.ts because the ladder leans on real
 * CSS selector semantics (attribute selectors, descendant combinators) and on
 * Element.closest() for its exclusion lists — a mock document cannot reproduce
 * those faithfully, and reproducing them wrongly would test the mock instead of
 * the code. The script itself is still executed through vm.runInNewContext, the
 * same way responseMonitor's selector tests run browser-side sources.
 */
import * as vm from 'vm';
import {
    CHAT_INPUT_BROAD_TIER_START,
    CHAT_INPUT_CANDIDATES,
    CHAT_INPUT_EXCLUDE_ALWAYS,
    CHAT_INPUT_EXCLUDE_BROAD,
    buildFocusChatInputScript,
} from '../../src/services/cdpService';

interface FocusScriptResult {
    ok: boolean;
    tier?: number;
    selector?: string;
    error?: string;
}

/**
 * jsdom performs no layout: offsetParent is always null and
 * getBoundingClientRect() always returns zeros. The focus script's visibility
 * probe therefore falls through to getComputedStyle + getBoundingClientRect, so
 * the rect is stubbed from a `data-rect="width,height"` attribute (default 200x40).
 */
beforeAll(() => {
    Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {
        configurable: true,
        writable: true,
        value(this: HTMLElement) {
            const spec = this.getAttribute('data-rect');
            const [width, height] = spec
                ? spec.split(',').map((n) => Number(n.trim()))
                : [200, 40];
            return { width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0 };
        },
    });
});

function buildDom(bodyHtml: string): void {
    document.body.innerHTML = bodyHtml;
}

/** Run a single tier against the current DOM — one Runtime.evaluate round-trip. */
function runTier(tier: number): FocusScriptResult {
    return vm.runInNewContext(buildFocusChatInputScript(tier), {
        document,
        window,
        Array,
        Math,
    }) as FocusScriptResult;
}

/**
 * Mirror focusChatInput()'s tier loop for a single execution context: stop at
 * the FIRST tier that yields a match, never merging tiers.
 */
function resolveChatInput(bodyHtml: string): FocusScriptResult {
    buildDom(bodyHtml);
    for (let tier = 0; tier < CHAT_INPUT_CANDIDATES.length; tier++) {
        const result = runTier(tier);
        if (result && result.ok) return result;
    }
    return { ok: false, error: 'No editor found' };
}

const tagged = () => document.querySelector('[data-remoat-chat-input="1"]');
const byId = (id: string) => document.getElementById(id)!;

const PANEL_OPEN = '<div class="antigravity-agent-side-panel">';
const PANEL_CLOSE = '</div>';

const MONACO_DECOY =
    '<div class="monaco-editor"><div class="native-edit-context" contenteditable="true" id="monaco-decoy"></div></div>';
const RENAME_DECOY =
    '<div class="monaco-list"><div contenteditable="true" id="rename-decoy" aria-label="rename file"></div></div>';

describe('CdpService chat input tier ladder', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    describe('candidate ladder shape', () => {
        it('produces syntactically valid JavaScript for every tier', () => {
            for (let tier = 0; tier < CHAT_INPUT_CANDIDATES.length; tier++) {
                const script = buildFocusChatInputScript(tier);
                // Selectors contain double quotes; they must be embedded via JSON.stringify.
                expect(() => new vm.Script(script)).not.toThrow();
                expect(script).toContain(JSON.stringify(CHAT_INPUT_CANDIDATES[tier]));
            }
        });

        it('applies the always-exclusions to every tier', () => {
            for (let tier = 0; tier < CHAT_INPUT_CANDIDATES.length; tier++) {
                expect(buildFocusChatInputScript(tier)).toContain(JSON.stringify(CHAT_INPUT_EXCLUDE_ALWAYS));
            }
        });

        it('applies the broad exclusions only to unscoped tiers', () => {
            for (let tier = 0; tier < CHAT_INPUT_CANDIDATES.length; tier++) {
                const script = buildFocusChatInputScript(tier);
                if (tier >= CHAT_INPUT_BROAD_TIER_START) {
                    expect(script).toContain(JSON.stringify(CHAT_INPUT_EXCLUDE_BROAD));
                } else {
                    expect(script).not.toContain(JSON.stringify(CHAT_INPUT_EXCLUDE_BROAD));
                }
            }
        });

        it('keeps the legacy v1 selector verbatim in the ladder', () => {
            expect(CHAT_INPUT_CANDIDATES).toContain('div[role="textbox"]:not(.xterm-helper-textarea)');
        });

        it('scopes every tier below CHAT_INPUT_BROAD_TIER_START to the Antigravity panel', () => {
            for (let tier = 0; tier < CHAT_INPUT_BROAD_TIER_START; tier++) {
                const selector = CHAT_INPUT_CANDIDATES[tier];
                expect(
                    selector.startsWith('.antigravity-agent-side-panel') || selector.startsWith('#conversation'),
                ).toBe(true);
            }
        });

        it('qualifies every tier with the div tag so <input>/<select>/<textarea> widgets never match', () => {
            for (const selector of CHAT_INPUT_CANDIDATES) {
                expect(selector).toContain('div[');
            }
        });
    });

    describe('resolution', () => {
        it('resolves the Antigravity v1 composer (role="textbox") at tier 1', () => {
            const result = resolveChatInput(
                `${PANEL_OPEN}<div role="textbox" contenteditable="true" id="composer"></div>${PANEL_CLOSE}`,
            );

            expect(result.ok).toBe(true);
            expect(result.tier).toBe(1);
            expect(tagged()!.id).toBe('composer');
        });

        it('resolves the Antigravity v2 composer (role="combobox") at tier 0', () => {
            const result = resolveChatInput(
                `${PANEL_OPEN}<div role="combobox" contenteditable="true" id="composer"></div>${PANEL_CLOSE}`,
            );

            expect(result.ok).toBe(true);
            expect(result.tier).toBe(0);
            expect(result.selector).toBe(CHAT_INPUT_CANDIDATES[0]);
            expect(tagged()!.id).toBe('composer');
        });

        it('prefers the v2 combobox composer over a v1 textbox when both are present', () => {
            // Deterministic single winner: tier 0 (combobox) always beats tier 1
            // (textbox), regardless of DOM order.
            const result = resolveChatInput(
                `${PANEL_OPEN}` +
                '<div role="combobox" contenteditable="true" id="v2-composer"></div>' +
                '<div role="textbox" contenteditable="true" id="v1-composer"></div>' +
                `${PANEL_CLOSE}`,
            );

            expect(result.tier).toBe(0);
            expect(tagged()!.id).toBe('v2-composer');
        });

        it('THE CRITICAL CASE: picks the composer over Monaco and rename decoys rendered after it', () => {
            // A flat selector union combined with "last visible match wins" would
            // pick #rename-decoy here, and clearInputField() would then wipe it.
            const result = resolveChatInput(
                `${PANEL_OPEN}<div role="combobox" contenteditable="true" id="composer"></div>${PANEL_CLOSE}` +
                MONACO_DECOY +
                RENAME_DECOY,
            );

            expect(result.ok).toBe(true);
            expect(result.tier).toBe(0);
            expect(tagged()!.id).toBe('composer');
            expect(byId('monaco-decoy').hasAttribute('data-remoat-chat-input')).toBe(false);
            expect(byId('rename-decoy').hasAttribute('data-remoat-chat-input')).toBe(false);
        });

        it('never selects a Monaco editor rendered INSIDE the agent panel (scoped-tier exclusion)', () => {
            // The agent panel renders Monaco inline (code blocks, diff views). A
            // role-less composer resolves at tier 6, where last-visible-match
            // would otherwise pick the decoy that follows it in DOM order —
            // this is why the Monaco guards live in CHAT_INPUT_EXCLUDE_ALWAYS.
            const result = resolveChatInput(
                `${PANEL_OPEN}` +
                '<div contenteditable="true" id="composer" aria-label="Ask anything"></div>' +
                MONACO_DECOY +
                `${PANEL_CLOSE}`,
            );

            expect(result.ok).toBe(true);
            expect(result.tier).toBe(6);
            expect(tagged()!.id).toBe('composer');
            expect(byId('monaco-decoy').hasAttribute('data-remoat-chat-input')).toBe(false);
        });

        it('resolves a composer scoped by #conversation when the panel class is absent', () => {
            const result = resolveChatInput(
                '<div id="conversation"><div role="combobox" contenteditable="true" id="composer"></div></div>',
            );

            expect(result.ok).toBe(true);
            expect(result.tier).toBe(3);
            expect(tagged()!.id).toBe('composer');
        });

        it('never selects an xterm helper or a contenteditable inside a terminal', () => {
            const result = resolveChatInput(
                '<div class="xterm">' +
                '<div role="combobox" contenteditable="true" id="term-input" aria-label="terminal chat"></div>' +
                '<textarea class="xterm-helper-textarea"></textarea>' +
                '</div>',
            );

            expect(result.ok).toBe(false);
            expect(tagged()).toBeNull();
        });

        it('never selects an aria-hidden element', () => {
            const result = resolveChatInput(
                `${PANEL_OPEN}<div aria-hidden="true"><div role="combobox" contenteditable="true" id="ghost"></div></div>${PANEL_CLOSE}`,
            );

            expect(result.ok).toBe(false);
            expect(tagged()).toBeNull();
        });

        it('returns ok:false when the composer is hidden, and never falls back to an unrelated decoy', () => {
            const result = resolveChatInput(
                `${PANEL_OPEN}<div role="combobox" contenteditable="true" id="composer" style="display:none" data-rect="0,0"></div>${PANEL_CLOSE}` +
                '<div contenteditable="true" id="decoy"></div>',
            );

            expect(result.ok).toBe(false);
            expect(tagged()).toBeNull();
            expect(byId('decoy').hasAttribute('data-remoat-chat-input')).toBe(false);
        });

        it('returns ok:false with "No editor found" for an empty DOM', () => {
            buildDom('');
            expect(runTier(0)).toEqual({ ok: false, error: 'No editor found' });
        });

        it('rejects a zero-height accessibility shim via the size gate', () => {
            const result = resolveChatInput(
                `${PANEL_OPEN}<div role="combobox" contenteditable="true" id="shim" data-rect="20,4"></div>${PANEL_CLOSE}`,
            );

            expect(result.ok).toBe(false);
            expect(tagged()).toBeNull();
        });

        it('tags the winner and clears the attribute from any prior holder', () => {
            buildDom(
                '<div contenteditable="true" id="stale" data-remoat-chat-input="1"></div>' +
                `${PANEL_OPEN}<div role="combobox" contenteditable="true" id="composer"></div>${PANEL_CLOSE}`,
            );

            const result = runTier(0);

            expect(result.ok).toBe(true);
            expect(byId('stale').hasAttribute('data-remoat-chat-input')).toBe(false);
            expect(byId('composer').getAttribute('data-remoat-chat-input')).toBe('1');
        });

        it('takes the LAST visible match within a tier (v1 panel layout contract)', () => {
            const result = resolveChatInput(
                `${PANEL_OPEN}` +
                '<div role="textbox" contenteditable="true" id="first"></div>' +
                '<div role="textbox" contenteditable="true" id="last"></div>' +
                `${PANEL_CLOSE}`,
            );

            expect(result.tier).toBe(1);
            expect(tagged()!.id).toBe('last');
        });
    });

    describe('last-tier positive signal gate', () => {
        it('rejects an unlabelled bare contenteditable div', () => {
            const result = resolveChatInput('<div contenteditable="true" id="anon"></div>');

            expect(result.ok).toBe(false);
            expect(tagged()).toBeNull();
        });

        it('accepts a bare contenteditable div whose aria-label reads like a chat box', () => {
            const result = resolveChatInput(
                '<div contenteditable="true" id="anon" aria-label="Ask anything"></div>',
            );

            expect(result.ok).toBe(true);
            expect(result.tier).toBe(CHAT_INPUT_CANDIDATES.length - 1);
            expect(tagged()!.id).toBe('anon');
        });

        it('accepts a data-placeholder signal as well', () => {
            const result = resolveChatInput(
                '<div contenteditable="true" data-placeholder="Send a message"></div>',
            );

            expect(result.ok).toBe(true);
        });

        it('still rejects a labelled contenteditable that lives inside Monaco', () => {
            const result = resolveChatInput(
                '<div class="monaco-editor"><div contenteditable="true" id="monaco" aria-label="Ask anything"></div></div>',
            );

            expect(result.ok).toBe(false);
            expect(tagged()).toBeNull();
        });

        it('still rejects a labelled contenteditable inside the quick-input widget', () => {
            const result = resolveChatInput(
                '<div class="quick-input-widget"><div contenteditable="true" aria-label="Ask anything"></div></div>',
            );

            expect(result.ok).toBe(false);
        });
    });
});
