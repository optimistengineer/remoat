/**
 * @jest-environment jsdom
 *
 * Pure-DOM verification of the conversation-feed auto-scroll script (issue #4).
 *
 * Same approach as cdpService.chatInputSelector.test.ts: the browser-side
 * source is executed through vm.runInNewContext against a real jsdom document,
 * because the script leans on real CSS selector semantics and instanceof
 * checks that a hand-rolled mock document cannot reproduce faithfully.
 */
import * as vm from 'vm';
import { buildScrollFeedToBottomScript } from '../../src/services/cdpService';

interface ScrollScriptResult {
    ok: boolean;
    error?: string;
}

/**
 * jsdom performs no layout: scrollHeight/clientHeight are always 0 and
 * scrollTop assignments are not observable. All three are stubbed through
 * data attributes so each test declares its scroll geometry explicitly.
 */
beforeAll(() => {
    Object.defineProperty(window.HTMLElement.prototype, 'scrollHeight', {
        configurable: true,
        get(this: HTMLElement) {
            return Number(this.getAttribute('data-scroll-height') || 0);
        },
    });
    Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', {
        configurable: true,
        get(this: HTMLElement) {
            return Number(this.getAttribute('data-client-height') || 0);
        },
    });
    Object.defineProperty(window.HTMLElement.prototype, 'scrollTop', {
        configurable: true,
        get(this: HTMLElement) {
            return Number(this.getAttribute('data-scroll-top') || 0);
        },
        set(this: HTMLElement, value: number) {
            this.setAttribute('data-scroll-top', String(value));
        },
    });
});

afterEach(() => {
    document.body.innerHTML = '';
});

function run(): ScrollScriptResult {
    return vm.runInNewContext(buildScrollFeedToBottomScript(), {
        document,
        window,
        Array,
        Number,
        HTMLElement: window.HTMLElement,
    }) as ScrollScriptResult;
}

const byId = (id: string) => document.getElementById(id)!;

/** A scrollable div: 1000px of content in a 300px viewport unless overridden. */
const scrollable = (id: string, scrollHeight = 1000, clientHeight = 300) =>
    `<div id="${id}" style="overflow-y: auto" data-scroll-height="${scrollHeight}" data-client-height="${clientHeight}"></div>`;

describe('buildScrollFeedToBottomScript (issue #4)', () => {
    it('produces syntactically valid JavaScript', () => {
        expect(() => new vm.Script(buildScrollFeedToBottomScript())).not.toThrow();
    });

    it('pins the scrollable feed inside #conversation to its bottom', () => {
        document.body.innerHTML = `<div id="conversation">${scrollable('feed')}</div>`;

        const result = run();

        expect(result.ok).toBe(true);
        expect(byId('feed').scrollTop).toBe(1000);
    });

    it('scrolls the #conversation root itself when it is the scrollable element', () => {
        document.body.innerHTML =
            '<div id="conversation" style="overflow-y: auto" data-scroll-height="800" data-client-height="200"></div>';

        const result = run();

        expect(result.ok).toBe(true);
        expect(byId('conversation').scrollTop).toBe(800);
    });

    it('picks the TALLEST scrollable element, not the first one', () => {
        document.body.innerHTML =
            `<div id="conversation">${scrollable('short', 500)}${scrollable('feed', 5000)}</div>`;

        const result = run();

        expect(result.ok).toBe(true);
        expect(byId('feed').scrollTop).toBe(5000);
        expect(byId('short').scrollTop).toBe(0);
    });

    it('ignores elements that overflow without a scrollable overflow-y', () => {
        document.body.innerHTML =
            '<div id="conversation">' +
            '<div id="decoy" style="overflow-y: visible" data-scroll-height="9000" data-client-height="100"></div>' +
            scrollable('feed') +
            '</div>';

        const result = run();

        expect(result.ok).toBe(true);
        expect(byId('feed').scrollTop).toBe(1000);
        expect(byId('decoy').scrollTop).toBe(0);
    });

    it('prefers #conversation over the side panel when both contain a scrollable feed', () => {
        document.body.innerHTML =
            `<div id="conversation">${scrollable('conversation-feed')}</div>` +
            `<div class="antigravity-agent-side-panel">${scrollable('panel-feed', 8000)}</div>`;

        const result = run();

        expect(result.ok).toBe(true);
        expect(byId('conversation-feed').scrollTop).toBe(1000);
        expect(byId('panel-feed').scrollTop).toBe(0);
    });

    it('falls back to the side panel when #conversation is absent', () => {
        document.body.innerHTML =
            `<div class="antigravity-agent-side-panel">${scrollable('panel-feed')}</div>`;

        const result = run();

        expect(result.ok).toBe(true);
        expect(byId('panel-feed').scrollTop).toBe(1000);
    });

    it('returns ok:false when no conversation root exists', () => {
        document.body.innerHTML = `<div id="something-else">${scrollable('feed')}</div>`;

        expect(run()).toEqual({ ok: false, error: 'No conversation root found' });
        expect(byId('feed').scrollTop).toBe(0);
    });

    it('returns ok:false when the feed fits its viewport (nothing to scroll)', () => {
        document.body.innerHTML =
            '<div id="conversation">' +
            '<div id="feed" style="overflow-y: auto" data-scroll-height="200" data-client-height="200"></div>' +
            '</div>';

        expect(run()).toEqual({ ok: false, error: 'No scrollable feed found' });
    });
});
