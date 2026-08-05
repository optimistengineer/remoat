/**
 * @jest-environment jsdom
 *
 * Coverage for the Past Conversations search-input resolver
 * (chatSessionService.ts -> buildActivateViaPastConversationsScript -> findSearchInput).
 *
 * Antigravity v2 turned the chat composer into a
 * `div[role="combobox"][contenteditable="true"]`, which for the first time
 * satisfies findSearchInput's
 * `input, textarea, [role="combobox"], [role="searchbox"], [contenteditable="true"]`
 * union. Without guards the resolver could hand back the composer, after which
 * the script writes the conversation TITLE into the chat box and presses Enter,
 * sending it to the agent as a prompt.
 *
 * findSearchInput is not exported, so the browser-side script is captured from
 * the CDP call and executed against a real DOM.
 */
import { ChatSessionService } from '../../src/services/chatSessionService';
import type { CdpService } from '../../src/services/cdpService';

interface ScriptResult {
    ok: boolean;
    error?: string;
}

/**
 * jsdom performs no layout, so offsetParent is always null and the script's
 * `isVisible` helper would reject every element. Treat everything as visible
 * unless it is explicitly marked with data-test-hidden.
 */
beforeAll(() => {
    Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
        configurable: true,
        get(this: HTMLElement) {
            return this.closest('[data-test-hidden]') ? null : document.body;
        },
    });
});

afterEach(() => {
    document.body.innerHTML = '';
});

/**
 * Run the real Past Conversations activation script against the current DOM.
 * The fake CdpService evaluates the captured expression instead of shipping it
 * over a WebSocket.
 */
async function activateViaPastConversations(title: string): Promise<ScriptResult> {
    const service = new ChatSessionService();
    const expressions: string[] = [];

    const fakeCdp = {
        getContexts: () => [{ id: 1, name: 'top', url: '' }],
        call: async (_method: string, params: { expression: string }) => {
            expressions.push(params.expression);
            // Indirect eval runs in the jsdom global scope, where document,
            // HTMLElement, KeyboardEvent and setTimeout are all defined.
            const value = await (0, eval)(params.expression);
            return { result: { value } };
        },
    } as unknown as CdpService;

    const result = await (service as unknown as {
        tryActivateByPastConversations(c: CdpService, t: string): Promise<ScriptResult>;
    }).tryActivateByPastConversations(fakeCdp, title);

    expect(expressions.length).toBeGreaterThan(0);
    expect(expressions[0]).toContain('findSearchInput');
    return result;
}

const TOGGLE = '<button data-past-conversations-toggle>History</button>';
const COMPOSER_TAGGED =
    '<div id="conversation"><div id="composer" role="combobox" contenteditable="true" data-remoat-chat-input="1"></div></div>';
const COMPOSER_UNTAGGED =
    '<div id="conversation"><div id="composer" role="combobox" contenteditable="true"></div></div>';

const byId = (id: string) => document.getElementById(id)!;

describe('ChatSessionService - Past Conversations search input (Antigravity v2 collision)', () => {
    it('returns the past-conversations search box, not the v2 chat composer', async () => {
        document.body.innerHTML =
            TOGGLE +
            COMPOSER_TAGGED +
            '<div class="past-conversations-panel">' +
            '<input id="search" role="combobox" placeholder="Search conversations" />' +
            '<li id="row">My Conversation</li>' +
            '</div>';

        const result = await activateViaPastConversations('My Conversation');

        expect(result.ok).toBe(true);
        expect((byId('search') as HTMLInputElement).value).toBe('My Conversation');
        // The chat composer must never receive the conversation title.
        expect(byId('composer').textContent).toBe('');
    });

    it('returns null rather than the composer when no search box is present', async () => {
        document.body.innerHTML = TOGGLE + COMPOSER_TAGGED;

        const result = await activateViaPastConversations('My Conversation');

        // findSearchInput() returned null, so the caller degraded to clickByPatterns
        // and reported a clean failure instead of typing into the chat box.
        expect(result.ok).toBe(false);
        expect(result.error).toBe('Conversation not found in Past Conversations');
        expect(byId('composer').textContent).toBe('');
    });

    it('still skips the composer when React has dropped the data-remoat-chat-input tag', async () => {
        // Layered guards: the role/contenteditable shape and the #conversation
        // ancestor check both independently disqualify the composer.
        document.body.innerHTML = TOGGLE + COMPOSER_UNTAGGED;

        const result = await activateViaPastConversations('My Conversation');

        expect(result.ok).toBe(false);
        expect(byId('composer').textContent).toBe('');
    });

    it('skips a composer that lives in the agent side panel instead of #conversation', async () => {
        document.body.innerHTML =
            TOGGLE +
            '<div class="antigravity-agent-side-panel">' +
            '<div id="composer" role="combobox" contenteditable="true"></div>' +
            '</div>';

        const result = await activateViaPastConversations('My Conversation');

        expect(result.ok).toBe(false);
        expect(byId('composer').textContent).toBe('');
    });

    it('accepts the real search box even when it lives inside the agent side panel', async () => {
        // The Past Conversations UI is opened from the agent side panel header
        // ([data-past-conversations-toggle]) and its rows are scoped to
        // .antigravity-agent-side-panel, so the panel is the likely host of the
        // search box. The composer guards must not discard it.
        document.body.innerHTML =
            '<div class="antigravity-agent-side-panel">' +
            TOGGLE +
            '<div id="composer" role="combobox" contenteditable="true" data-remoat-chat-input="1"></div>' +
            '<input id="search" placeholder="Search conversations" />' +
            '<li id="row">My Conversation</li>' +
            '</div>';

        const result = await activateViaPastConversations('My Conversation');

        expect(result.ok).toBe(true);
        expect((byId('search') as HTMLInputElement).value).toBe('My Conversation');
        expect(byId('composer').textContent).toBe('');
    });

    it('accepts a panel-hosted contenteditable combobox labelled "Select a conversation"', async () => {
        // Worst case: the search box has the exact same shape as the v2 composer
        // AND lives in the panel. Only its conversation-specific label distinguishes
        // it, so a conversation-specific label must outrank both soft guards.
        document.body.innerHTML =
            '<div class="antigravity-agent-side-panel">' +
            TOGGLE +
            '<div id="composer" role="combobox" contenteditable="true" data-remoat-chat-input="1" aria-label="Ask anything"></div>' +
            '<div id="search" role="combobox" contenteditable="true" aria-label="Select a conversation"></div>' +
            '<li id="row">My Conversation</li>' +
            '</div>';

        const result = await activateViaPastConversations('My Conversation');

        // jsdom does not reflect the contenteditable ATTRIBUTE into
        // HTMLElement.isContentEditable, so setInputValue's contenteditable branch
        // cannot run here. focus() happens before that branch, so activeElement is
        // the faithful signal of which element findSearchInput() handed back.
        expect(result.ok).toBe(true);
        expect(document.activeElement).toBe(byId('search'));
        expect(byId('composer').textContent).toBe('');
    });

    it('prefers a conversation-specific label over a generic "search" label', async () => {
        document.body.innerHTML =
            TOGGLE +
            '<input id="filefind" placeholder="Search files" />' +
            '<input id="search" placeholder="Search conversations" />' +
            '<li id="row">My Conversation</li>';

        const result = await activateViaPastConversations('My Conversation');

        expect(result.ok).toBe(true);
        expect((byId('search') as HTMLInputElement).value).toBe('My Conversation');
        expect((byId('filefind') as HTMLInputElement).value).toBe('');
    });

    it('never lets a generic "search" label claim a composer-shaped element', async () => {
        // 'search' alone is too weak to override the composer shape guard.
        document.body.innerHTML =
            TOGGLE +
            '<div id="conversation">' +
            '<div id="composer" role="combobox" contenteditable="true" aria-label="Search or ask anything"></div>' +
            '</div>';

        const result = await activateViaPastConversations('My Conversation');

        expect(result.ok).toBe(false);
        expect(byId('composer').textContent).toBe('');
    });

    it('never falls back to an unlabelled visible input', async () => {
        document.body.innerHTML = TOGGLE + '<input id="anon" />';

        const result = await activateViaPastConversations('My Conversation');

        expect(result.ok).toBe(false);
        expect((byId('anon') as HTMLInputElement).value).toBe('');
    });

    it('still accepts a labelled search box that carries no strong pattern', async () => {
        // Positive control: the guards must not over-block real search inputs.
        document.body.innerHTML =
            TOGGLE +
            '<input id="filter" aria-label="Filter chats" />' +
            '<li id="row">My Conversation</li>';

        const result = await activateViaPastConversations('My Conversation');

        expect(result.ok).toBe(true);
        expect((byId('filter') as HTMLInputElement).value).toBe('My Conversation');
    });
});
