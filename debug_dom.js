const http = require('http');
const WebSocket = require('ws');

function getPrimaryTarget() {
    return new Promise((resolve, reject) => {
        http.get('http://127.0.0.1:9222/json/list', (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const targets = JSON.parse(data);
                    const page = targets.find(t => t.type === 'page' && !t.url.includes('devtools://'));
                    if (page && page.webSocketDebuggerUrl) resolve(page.webSocketDebuggerUrl);
                    else reject(new Error('No primary target found'));
                } catch (err) { reject(err); }
            });
        }).on('error', reject);
    });
}

function runScript(wsUrl) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        let msgId = 1;
        ws.on('open', () => {
            ws.send(JSON.stringify({
                id: msgId++,
                method: 'Runtime.evaluate',
                params: {
                    expression: `(() => {
                        // Find ALL elements with text "Implementation Plan" and map their ancestry
                        const els = document.querySelectorAll('*');
                        const results = [];
                        for (let i = 0; i < els.length; i++) {
                            const el = els[i];
                            const text = (el.textContent || '').trim();
                            if (text === 'Implementation Plan' && el.children.length <= 2) {
                                // Walk up 5 levels and record each ancestor
                                const ancestry = [];
                                let p = el;
                                for (let j = 0; j < 6 && p; j++) {
                                    ancestry.push({
                                        tag: p.tagName,
                                        className: (p.className || '').toString().substring(0, 120),
                                        childCount: p.children.length,
                                        insideDetails: !!p.closest('details'),
                                        insideNotify: !!p.closest('.notify-user-container'),
                                        hasOpenBtn: !!p.querySelector('button') && Array.from(p.querySelectorAll('button')).some(b => (b.textContent||'').trim().toLowerCase() === 'open'),
                                        hasProceedBtn: !!p.querySelector('button') && Array.from(p.querySelectorAll('button')).some(b => (b.textContent||'').trim().toLowerCase() === 'proceed'),
                                    });
                                    p = p.parentElement;
                                }
                                const rect = el.getBoundingClientRect();
                                results.push({
                                    text: text,
                                    tag: el.tagName,
                                    className: (el.className || '').toString().substring(0, 120),
                                    insideDetails: !!el.closest('details'),
                                    top: Math.round(rect.top),
                                    ancestry
                                });
                            }
                        }
                        return results;
                    })()`,
                    returnByValue: true
                }
            }));
        });
        ws.on('message', (data) => {
            const resp = JSON.parse(data);
            if (resp.result && resp.result.result) {
                console.log(JSON.stringify(resp.result.result.value, null, 2));
                ws.close();
                resolve();
            }
        });
        ws.on('error', reject);
    });
}

getPrimaryTarget().then(runScript).catch(console.error);
