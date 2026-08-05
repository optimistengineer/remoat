import {
    CdpService,
    CHAT_INPUT_CANDIDATES,
    CHAT_INPUT_EXCLUDE_ALWAYS,
} from '../../src/services/cdpService';
import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';

/**
 * Map a focus-script expression back to the ladder tier that produced it.
 * Returns -1 for any other Runtime.evaluate expression (e.g. the focus guard).
 */
const tierOf = (expression: string): number =>
    CHAT_INPUT_CANDIDATES.findIndex((sel) => expression.includes(`const SEL = ${JSON.stringify(sel)};`));

/**
 * Step 5: Message Injection TDD Tests
 *
 * Test strategy:
 *   - Tests the injectMessage() method of CdpService
 *   - Mock WebSocket server receives Runtime.evaluate calls and
 *     returns injection results (success/failure) to verify logic
 *   - Verifies that cascade-panel is prioritized when multiple contexts exist
 */

describe('CdpService - Message Injection (Step 5)', () => {
    let service: CdpService;
    let mockHttpServer: http.Server;
    let mockWss: WebSocketServer;
    let serverSocket: WebSocket | null = null;
    const testPort = 19223;
    const fakeWsUrl = `ws://127.0.0.1:${testPort}/devtools/page/test-id`;

    // Store sent/received messages per test
    let receivedMessages: any[] = [];
    // May return a bare boolean: the focus guard's expression evaluates to
    // true/false rather than an { ok } object.
    let evaluateResponder: ((req: any) => { ok: boolean; method?: string; error?: string } | boolean) | null = null;

    // Mock context configuration
    const mockContexts = [
        { id: 1, name: 'top', url: 'file:///workbench/index.html' },           // Low priority
        { id: 2, name: 'cascade', url: 'file:///workbench/cascade-panel.html' }, // High priority
        { id: 3, name: 'Extension', url: 'file:///workbench/extension.html' },  // Medium priority
    ];

    beforeAll((done) => {
        mockHttpServer = http.createServer((req, res) => {
            if (req.url === '/json/list') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify([
                    {
                        type: 'page',
                        title: 'Antigravity Workspace',
                        url: 'file:///workbench/index.html',
                        webSocketDebuggerUrl: fakeWsUrl
                    }
                ]));
            } else {
                res.writeHead(404);
                res.end();
            }
        });

        mockWss = new WebSocketServer({ server: mockHttpServer });

        mockWss.on('connection', (ws) => {
            serverSocket = ws;
            receivedMessages = [];
            evaluateResponder = null;

            ws.on('message', (message) => {
                const req = JSON.parse(message.toString());
                receivedMessages.push(req);

                if (req.method === 'Runtime.enable') {
                    // Send context information
                    for (const ctx of mockContexts) {
                        ws.send(JSON.stringify({
                            method: 'Runtime.executionContextCreated',
                            params: { context: ctx }
                        }));
                    }
                    ws.send(JSON.stringify({ id: req.id, result: {} }));
                    return;
                }

                if (req.method === 'Network.enable') {
                    ws.send(JSON.stringify({ id: req.id, result: {} }));
                    return;
                }

                if (req.method === 'Runtime.evaluate') {
                    const result = evaluateResponder
                        ? evaluateResponder(req)
                        : { ok: false, error: 'No responder configured' };

                    ws.send(JSON.stringify({
                        id: req.id,
                        result: { result: { value: result } }
                    }));
                    return;
                }

                if (req.method === 'Input.insertText' || req.method === 'Input.dispatchKeyEvent') {
                    ws.send(JSON.stringify({ id: req.id, result: {} }));
                }
            });
        });

        mockHttpServer.listen(testPort, done);
    });

    afterAll((done) => {
        mockWss.close(() => mockHttpServer.close(done));
    });

    beforeEach(() => {
        service = new CdpService({ portsToScan: [testPort] });
    });

    afterEach(async () => {
        await service.disconnect();
    });

    // ---------------------------------------------------------
    // Test 1: Success case (insertion succeeds in cascade-panel context)
    // ---------------------------------------------------------
    it('successfully injects a message in the cascade-panel context', async () => {
        await service.connect();
        await new Promise(r => setTimeout(r, 100)); // Wait for context reception

        evaluateResponder = (req) => {
            const contextId = req.params.contextId;
            if (contextId === 2) return { ok: true, method: 'focus' };
            return { ok: false, error: 'No editor found' };
        };

        const result = await service.injectMessage('テストメッセージ');
        expect(result.ok).toBe(true);
        expect(result.contextId).toBe(2); // cascade-panel should be selected
        expect(result.method).toBe('enter');
    });

    // ---------------------------------------------------------
    // Test 2: Fallback case (cascade-panel fails, succeeds in another context)
    // ---------------------------------------------------------
    it('falls back to another context when cascade-panel fails', async () => {
        await service.connect();
        await new Promise(r => setTimeout(r, 100));

        evaluateResponder = (req) => {
            const contextId = req.params.contextId;
            if (contextId === 3) return { ok: true, method: 'focus' };
            return { ok: false, error: 'No editor found' };
        };

        const result = await service.injectMessage('フォールバックテスト');
        expect(result.ok).toBe(true);
        expect(result.contextId).toBe(3);
    });

    // ---------------------------------------------------------
    // Test 3: All contexts fail case
    // ---------------------------------------------------------
    it('returns ok:false when all contexts fail', async () => {
        await service.connect();
        await new Promise(r => setTimeout(r, 100));

        evaluateResponder = () => ({ ok: false, error: 'No editor found' });

        const result = await service.injectMessage('失敗するメッセージ');
        expect(result.ok).toBe(false);
        // Exact string: injectMessage/injectMessageWithImageFiles surface it to users.
        expect(result.error).toBe('Chat input field not found');
    });

    // ---------------------------------------------------------
    // Test 3b: Tier ladder ordering (tiers OUTER, contexts INNER)
    // ---------------------------------------------------------
    it('walks the selector tiers in order, trying every context per tier', async () => {
        await service.connect();
        await new Promise(r => setTimeout(r, 100));
        receivedMessages = [];

        evaluateResponder = () => ({ ok: false, error: 'No editor found' });

        await service.injectMessage('総当たりテスト');

        const expressions = receivedMessages
            .filter(m => m.method === 'Runtime.evaluate')
            .map(m => m.params.expression as string);

        // Every emitted focus expression carries the always-exclusion list.
        for (const expression of expressions) {
            expect(expression).toContain(JSON.stringify(CHAT_INPUT_EXCLUDE_ALWAYS));
        }

        const tiers = expressions.map(tierOf);
        expect(tiers).not.toContain(-1);

        // Tiers OUTER, contexts INNER: the tier index never decreases, and every
        // tier is attempted in all three contexts before the next tier starts.
        expect(tiers[0]).toBe(0);
        for (let i = 1; i < tiers.length; i++) {
            expect(tiers[i]).toBeGreaterThanOrEqual(tiers[i - 1]);
        }
        expect(tiers).toHaveLength(CHAT_INPUT_CANDIDATES.length * mockContexts.length);
        expect(new Set(tiers).size).toBe(CHAT_INPUT_CANDIDATES.length);

        // The Antigravity v2 combobox tier must be evaluated strictly before the
        // broad `div[contenteditable="true"]` fallback ever gets a chance.
        const firstCombobox = expressions.findIndex(e => e.includes('role=\\"combobox\\"'));
        const firstBareFallback = expressions.findIndex(
            e => e.includes(`const SEL = ${JSON.stringify('div[contenteditable="true"]')};`),
        );
        expect(firstCombobox).toBeGreaterThanOrEqual(0);
        expect(firstBareFallback).toBeGreaterThan(firstCombobox);
    });

    // ---------------------------------------------------------
    // Test 3c-2: Guard rejects once, ladder resumes, send SUCCEEDS at a later tier
    // ---------------------------------------------------------
    it('recovers when the focus guard rejects one tier but a later tier verifies', async () => {
        await service.connect();
        await new Promise(r => setTimeout(r, 100));
        receivedMessages = [];

        let guardProbes = 0;
        evaluateResponder = (req) => {
            const expression = req.params.expression as string;
            if (expression.includes('document.activeElement')) {
                guardProbes++;
                return guardProbes > 1; // reject the first verification only
            }
            if (expression.includes('scrollTop')) return { ok: true };
            return { ok: true, method: 'focus' }; // every focus tier succeeds
        };

        const result = await service.injectMessage('リトライ成功テスト');

        expect(result.ok).toBe(true);
        expect(receivedMessages.map(m => m.method)).toContain('Input.insertText');

        // The winning focus attempt came from a LATER tier than the rejected one.
        const focusTiers = receivedMessages
            .filter(m => m.method === 'Runtime.evaluate')
            .map(m => m.params.expression as string)
            .filter(e => e.includes('data-remoat-chat-input'))
            .map(tierOf);
        expect(focusTiers).toEqual([0, 1]);
    });

    // ---------------------------------------------------------
    // Test 3d: The feed is pinned to the bottom after a successful send (issue #4)
    // ---------------------------------------------------------
    it('pins the conversation feed to the bottom after a successful send', async () => {
        await service.connect();
        await new Promise(r => setTimeout(r, 100));
        receivedMessages = [];

        evaluateResponder = (req) => {
            const contextId = req.params.contextId;
            if (contextId === 2) return { ok: true, method: 'focus' };
            return { ok: false, error: 'No editor found' };
        };

        const result = await service.injectMessage('スクロールテスト');
        expect(result.ok).toBe(true);

        const enterIdx = receivedMessages.findIndex(
            m => m.method === 'Input.dispatchKeyEvent' && m.params.key === 'Enter',
        );
        const scrollIdx = receivedMessages.findIndex(
            m => m.method === 'Runtime.evaluate' && (m.params.expression as string).includes('scrollTop'),
        );
        expect(enterIdx).toBeGreaterThanOrEqual(0);
        // The scroll runs AFTER the Enter keypress, in the composer's context.
        expect(scrollIdx).toBeGreaterThan(enterIdx);
        expect(receivedMessages[scrollIdx].params.contextId).toBe(2);
    });

    // ---------------------------------------------------------
    // Test 3e: Scroll falls back to other contexts when the composer's has no feed
    // ---------------------------------------------------------
    it('falls back to other contexts when the composer context has no conversation root', async () => {
        await service.connect();
        await new Promise(r => setTimeout(r, 100));
        receivedMessages = [];

        evaluateResponder = (req) => {
            const expression = req.params.expression as string;
            if (expression.includes('scrollTop')) {
                // The composer's context (2) hosts no feed; context 3 does.
                return req.params.contextId === 3
                    ? { ok: true }
                    : { ok: false, error: 'No conversation root found' };
            }
            if (req.params.contextId === 2) return { ok: true, method: 'focus' };
            return { ok: false, error: 'No editor found' };
        };

        const result = await service.injectMessage('フォールバックスクロール');
        expect(result.ok).toBe(true);

        const scrollContexts = receivedMessages
            .filter(m => m.method === 'Runtime.evaluate' && (m.params.expression as string).includes('scrollTop'))
            .map(m => m.params.contextId);
        // Preferred (composer) context first, then the fallback that succeeded.
        expect(scrollContexts[0]).toBe(2);
        expect(scrollContexts).toContain(3);
    });

    // ---------------------------------------------------------
    // Test 3c: Focus-guard rejection resumes the ladder, then fails closed
    // ---------------------------------------------------------
    it('resumes the tier ladder when the focus guard rejects, and fails closed once exhausted', async () => {
        await service.connect();
        await new Promise(r => setTimeout(r, 100));
        receivedMessages = [];

        evaluateResponder = (req) => {
            const expression = req.params.expression as string;
            // Every focus tier "succeeds", but the negative guard (which probes
            // document.activeElement) always rejects what got focused.
            if (expression.includes('document.activeElement')) return false;
            return { ok: true, method: 'focus' };
        };

        const result = await service.injectMessage('ガード拒否テスト');

        expect(result.ok).toBe(false);
        // Exact string: surfaced to users by injectMessage/injectMessageWithImageFiles.
        expect(result.error).toBe('Chat input focus verification failed');

        // Destructive input must never have been dispatched.
        const methods = receivedMessages.map(m => m.method);
        expect(methods).not.toContain('Input.insertText');
        expect(methods).not.toContain('Input.dispatchKeyEvent');

        // The ladder resumed past the rejected tier instead of failing terminally:
        // every tier was offered before giving up.
        const focusTiers = receivedMessages
            .filter(m => m.method === 'Runtime.evaluate')
            .map(m => m.params.expression as string)
            .filter(e => e.includes('data-remoat-chat-input'))
            .map(tierOf);
        expect(new Set(focusTiers).size).toBe(CHAT_INPUT_CANDIDATES.length);
    });

    // ---------------------------------------------------------
    // Test 4: Verify the injected script contains correct content
    // ---------------------------------------------------------
    it('calls Runtime.evaluate with the correct parameters during injectMessage', async () => {
        await service.connect();
        await new Promise(r => setTimeout(r, 100));
        receivedMessages = []; // Reset

        const targetText = '注入テキスト<script>alert("xss")</script>';
        evaluateResponder = (req) => {
            const contextId = req.params.contextId;
            if (contextId === 2) return { ok: true, method: 'focus' };
            return { ok: false, error: 'No editor found' };
        };

        await service.injectMessage(targetText);

        // Verify that Runtime.evaluate for focus was called
        const evaluateCalls = receivedMessages.filter(m => m.method === 'Runtime.evaluate');
        expect(evaluateCalls.length).toBeGreaterThan(0);

        // Verify that the focusScript was executed, starting at the most specific tier
        const firstCall = evaluateCalls[0];
        expect(firstCall.params.expression).toContain('.focus()');
        expect(firstCall.params.expression).toContain(JSON.stringify(CHAT_INPUT_EXCLUDE_ALWAYS));
        expect(tierOf(firstCall.params.expression)).toBe(0);
        expect(firstCall.params.returnByValue).toBe(true);

        // The v2 combobox tier is always attempted before the bare contenteditable fallback.
        const focusExpressions = evaluateCalls
            .map((c) => c.params.expression as string)
            .filter((e) => tierOf(e) >= 0);
        const firstCombobox = focusExpressions.findIndex((e) => e.includes('role=\\"combobox\\"'));
        const firstBareFallback = focusExpressions.findIndex(
            (e) => e.includes(`const SEL = ${JSON.stringify('div[contenteditable="true"]')};`),
        );
        expect(firstCombobox).toBe(0);
        expect(firstBareFallback === -1 || firstBareFallback > firstCombobox).toBe(true);

        // Verify that text is sent via Input.insertText
        const insertTextCalls = receivedMessages.filter(m => m.method === 'Input.insertText');
        expect(insertTextCalls).toHaveLength(1);
        expect(insertTextCalls[0].params.text).toBe(targetText);

        // Verify that key events are dispatched:
        //   clearInputField: Meta+A (keyDown/keyUp) + Backspace (keyDown/keyUp) = 4 events
        //   pressEnterToSend: Enter (keyDown/keyUp) = 2 events
        const keyCalls = receivedMessages.filter(m => m.method === 'Input.dispatchKeyEvent');
        expect(keyCalls).toHaveLength(6);
        // clearInputField: Meta+A (macOS) or Ctrl+A (Linux/Windows) select all
        const expectedModifier = process.platform === 'darwin' ? 4 : 2;
        expect(keyCalls[0].params.key).toBe('a');
        expect(keyCalls[0].params.modifiers).toBe(expectedModifier);
        expect(keyCalls[1].params.key).toBe('a');
        // clearInputField: Backspace delete
        expect(keyCalls[2].params.key).toBe('Backspace');
        expect(keyCalls[3].params.key).toBe('Backspace');
        // pressEnterToSend: Enter
        expect(keyCalls[4].params.key).toBe('Enter');
        expect(keyCalls[4].params.type).toBe('keyDown');
        expect(keyCalls[5].params.key).toBe('Enter');
        expect(keyCalls[5].params.type).toBe('keyUp');
    });

    // ---------------------------------------------------------
    // Test 5: Throws exception when called while not connected
    // ---------------------------------------------------------
    it('throws an error when injectMessage is called while not connected', async () => {
        // Call without connecting
        await expect(service.injectMessage('test')).rejects.toThrow();
    });
});
