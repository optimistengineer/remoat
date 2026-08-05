import { CdpService } from '../../src/services/cdpService';
import * as http from 'http';
import { WebSocketServer } from 'ws';

describe('CdpService - Target Detection & Connection', () => {
    let service: CdpService;
    let mockHttpServer: http.Server;
    let mockWss: WebSocketServer;
    const testPort = 19222; // Use a distinct port to avoid conflicts
    const fakeWsUrl = `ws://127.0.0.1:${testPort}/devtools/page/test-id`;

    // Mock the HTTP target list
    const mockTargets = [
        {
            type: 'page',
            title: 'Launchpad',
            url: 'file:///some/path/launchpad.html',
            webSocketDebuggerUrl: `ws://127.0.0.1:${testPort}/devtools/page/launchpad-id`
        },
        {
            type: 'page',
            title: 'Antigravity Workspace',
            url: 'file:///some/path/workbench.html',
            webSocketDebuggerUrl: fakeWsUrl
        }
    ];

    beforeAll((done) => {
        // Setup mock HTTP server for /json/list
        mockHttpServer = http.createServer((req, res) => {
            if (req.url === '/json/list') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(mockTargets));
            } else {
                res.writeHead(404);
                res.end();
            }
        });

        mockWss = new WebSocketServer({ server: mockHttpServer });

        mockWss.on('connection', (ws) => {
            // CDP Server mock behavior
            ws.on('message', (message) => {
                const req = JSON.parse(message.toString());
                if (req.method === 'Runtime.enable') {
                    // Send mock execution context created.
                    // NOTE: Antigravity v1.21.6+ removed the 'cascade-panel' sandboxed context.
                    // The agent panel now lives directly in the main 'top' workbench context.
                    ws.send(JSON.stringify({
                        method: 'Runtime.executionContextCreated',
                        params: {
                            context: { id: 1, name: 'top', url: 'file:///some/path/workbench.html' }
                        }
                    }));
                    // Reply to the enable request
                    ws.send(JSON.stringify({ id: req.id, result: {} }));
                    return;
                }

                if (req.method === 'Network.enable') {
                    ws.send(JSON.stringify({ id: req.id, result: {} }));
                }
            });
        });

        mockHttpServer.listen(testPort, done);
    });

    afterAll((done) => {
        mockWss.close(() => {
            mockHttpServer.close(done);
        });
    });

    beforeEach(() => {
        // Provide the test port array to restrict search to our test server
        // maxReconnectAttempts: 0 prevents auto-reconnect timer leaks after tests
        service = new CdpService({ portsToScan: [testPort], maxReconnectAttempts: 0 });
    });

    afterEach(async () => {
        await service.disconnect();
    });

    it('scans ports and discovers the correct target (workbench) to obtain the WebSocket URL', async () => {
        const targetUrl = await service.discoverTarget();
        expect(targetUrl).toBe(fakeWsUrl);
    });

    it('establishes a WebSocket connection and uses the top-level workbench context (v1.21.6+)', async () => {
        // Antigravity v1.21.6 removed the cascade-panel sandboxed context.
        // The bot now operates in the main workbench 'top' context (id 1).
        await service.connect();
        expect(service.isConnected()).toBe(true);

        // Wait briefly for context retrieval to complete (to receive mock server responses)
        await new Promise(r => setTimeout(r, 100));

        const contexts = service.getContexts();
        expect(contexts.length).toBeGreaterThanOrEqual(1);

        const targetContextId = service.getPrimaryContextId();
        expect(targetContextId).toBe(1); // top workbench context
    });

    it('triggers the auto-reconnect listener when disconnected', async () => {
        await service.connect();
        expect(service.isConnected()).toBe(true);

        const disconnectPromise = new Promise<void>(resolve => {
            service.on('disconnected', resolve);
        });

        // Force disconnect from the mock server
        for (const client of mockWss.clients) {
            client.terminate();
        }

        await disconnectPromise;
        expect(service.isConnected()).toBe(false);
    });
});

/**
 * Antigravity IDE v2 renamed the Windows executable and install folder, which
 * also changes the window (and therefore CDP target) title to
 * "MyProject — Antigravity IDE".
 *
 * The target filter deliberately uses `title.includes('Antigravity')`, which
 * matches BOTH product names. This suite locks that in: narrowing the matcher
 * to 'Antigravity IDE' would break every v1 user.
 */
describe('CdpService - Antigravity IDE v2 target titles', () => {
    let service: CdpService;
    let mockHttpServer: http.Server;
    let mockWss: WebSocketServer;
    const testPort = 19232;
    const fakeWsUrl = `ws://127.0.0.1:${testPort}/devtools/page/v2-id`;

    beforeAll((done) => {
        mockHttpServer = http.createServer((req, res) => {
            if (req.url === '/json/list') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify([
                    {
                        type: 'page',
                        title: 'Launchpad — Antigravity IDE',
                        url: 'file:///some/path/launchpad.html',
                        webSocketDebuggerUrl: `ws://127.0.0.1:${testPort}/devtools/page/launchpad-id`,
                    },
                    {
                        type: 'page',
                        title: 'MyProject — Antigravity IDE',
                        url: 'file:///some/path/workbench.html',
                        webSocketDebuggerUrl: fakeWsUrl,
                    },
                ]));
            } else {
                res.writeHead(404);
                res.end();
            }
        });

        mockWss = new WebSocketServer({ server: mockHttpServer });
        mockHttpServer.listen(testPort, done);
    });

    afterAll((done) => {
        mockWss.close(() => {
            mockHttpServer.close(done);
        });
    });

    beforeEach(() => {
        service = new CdpService({ portsToScan: [testPort], maxReconnectAttempts: 0 });
    });

    afterEach(async () => {
        await service.disconnect();
    });

    it('still selects the workbench target when the title carries the v2 product name', async () => {
        const targetUrl = await service.discoverTarget();
        expect(targetUrl).toBe(fakeWsUrl);
    });

    it('extracts the workspace name from a v2 title without being confused by the extra word', async () => {
        await service.discoverTarget();
        // The /\s[—–-]\s/ split must yield "MyProject", not "MyProject — Antigravity".
        expect(service.getCurrentWorkspaceName()).toBe('MyProject');
    });
});
