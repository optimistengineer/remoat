import { Bot, Context, InlineKeyboard, InputFile } from 'grammy';
import Database from 'better-sqlite3';

import { t } from '../utils/i18n';
import { logger } from '../utils/logger';
import type { LogLevel } from '../utils/logger';
import { loadConfig, resolveResponseDeliveryMode } from '../utils/config';
import { ConfigLoader } from '../utils/configLoader';
import { parseMessageContent } from '../commands/messageParser';
import { SlashCommandHandler } from '../commands/slashCommandHandler';
import { CleanupCommandHandler, CLEANUP_ARCHIVE_BTN, CLEANUP_DELETE_BTN, CLEANUP_CANCEL_BTN } from '../commands/cleanupCommandHandler';

import { ModeService, AVAILABLE_MODES, MODE_DISPLAY_NAMES, MODE_DESCRIPTIONS, MODE_UI_NAMES } from '../services/modeService';
import { ModelService } from '../services/modelService';
import { TemplateRepository } from '../database/templateRepository';
import { WorkspaceBindingRepository } from '../database/workspaceBindingRepository';
import { ChatSessionRepository } from '../database/chatSessionRepository';
import { WorkspaceService } from '../services/workspaceService';
import { TelegramTopicManager } from '../services/telegramTopicManager';
import { TitleGeneratorService } from '../services/titleGeneratorService';

import { CdpService } from '../services/cdpService';
import { ChatSessionService } from '../services/chatSessionService';
import { ResponseMonitor, RESPONSE_SELECTORS } from '../services/responseMonitor';
import { ensureAntigravityRunning } from '../services/antigravityLauncher';
import { getAntigravityCdpHint } from '../utils/pathUtils';
import { AutoAcceptService } from '../services/autoAcceptService';
import { PromptDispatcher } from '../services/promptDispatcher';
import {
    CdpBridge,
    TelegramChannel,
    ensureApprovalDetector,
    ensureErrorPopupDetector,
    ensurePlanningDetector,
    getCurrentCdp,
    initCdpBridge,
    registerApprovalSessionChannel,
    registerApprovalWorkspaceChannel,
    parseApprovalCustomId,
    parseErrorPopupCustomId,
    parsePlanningCustomId,
} from '../services/cdpBridgeManager';
import { classifyAssistantSegments, extractAssistantSegmentsPayloadScript } from '../services/assistantDomExtractor';
import { buildModeModelLines, splitForEmbedDescription } from '../utils/streamMessageFormatter';
import { formatForTelegram, splitOutputAndLogs, escapeHtml, splitTelegramHtml } from '../utils/telegramFormatter';
import {
    buildPromptWithAttachmentUrls,
    cleanupInboundImageAttachments,
    downloadTelegramImages,
    InboundImageAttachment,
    isImageAttachment,
    toTelegramInputFile,
} from '../utils/imageHandler';
import { checkWhisperAvailability, downloadTelegramVoice, transcribeVoice } from '../utils/voiceHandler';
import { buildModeUI, sendModeUI } from '../ui/modeUi';
import { buildModelsUI, sendModelsUI } from '../ui/modelsUi';
import { sendTemplateUI, TEMPLATE_BTN_PREFIX, parseTemplateButtonId } from '../ui/templateUi';
import { sendAutoAcceptUI, AUTOACCEPT_BTN_ON, AUTOACCEPT_BTN_OFF, AUTOACCEPT_BTN_REFRESH } from '../ui/autoAcceptUi';
import { handleScreenshot } from '../ui/screenshotUi';
import { buildProjectListUI, PROJECT_SELECT_ID, PROJECT_PAGE_PREFIX, parseProjectPageId } from '../ui/projectListUi';
import { buildSessionPickerUI, SESSION_SELECT_ID, isSessionSelectId } from '../ui/sessionPickerUi';
import {
    PLAN_VIEW_BTN, PLAN_PROCEED_BTN, PLAN_EDIT_BTN, PLAN_REFRESH_BTN, PLAN_PAGE_PREFIX,
    buildPlanNotificationUI, buildPlanContentUI, paginatePlanContent,
} from '../ui/planUi';
import {
    INTERRUPT_QUEUE_PREFIX, INTERRUPT_NOW_PREFIX, INTERRUPT_DISCARD_PREFIX,
    buildInterruptUI,
} from '../ui/queueUi';
import {
    addPendingInterrupt,
    getFirstPendingInterrupt,
    getAllPendingInterrupts,
    getQueueDepth,
    shiftPendingInterrupt,
    drainPendingInterrupts,
    hasPendingInterrupts,
    clearPendingInterrupts,

    consumeBypass,
    MAX_QUEUE_DEPTH,
} from '../services/interruptState';

const PHASE_ICONS = {
    sending: '📡',
    thinking: '🧠',
    generating: '✍️',
    complete: '✅',
    timeout: '⏰',
    error: '❌',
} as const;

const MAX_OUTBOUND_GENERATED_IMAGES = 4;
const TELEGRAM_MSG_LIMIT = 4096;
const MAX_INLINE_CHUNKS = 5;

/** Convert Telegram HTML back to readable Markdown for .md file attachment */
function stripHtmlForFile(html: string): string {
    let text = html;
    // Code blocks: <pre><code class="language-X">...</code></pre> → ```X\n...\n```
    text = text.replace(
        /<pre>\s*<code\s+class="language-([^"]*)">([\s\S]*?)<\/code>\s*<\/pre>/gi,
        (_m, lang, content) => `\n\`\`\`${lang}\n${content}\n\`\`\`\n`,
    );
    // Code blocks: <pre>...</pre> → ```\n...\n```
    text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, content) => `\n\`\`\`\n${content}\n\`\`\`\n`);
    // Inline code
    text = text.replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`');
    // Bold
    text = text.replace(/<b>([\s\S]*?)<\/b>/gi, '**$1**');
    // Italic
    text = text.replace(/<i>([\s\S]*?)<\/i>/gi, '*$1*');
    // Strikethrough
    text = text.replace(/<s>([\s\S]*?)<\/s>/gi, '~~$1~~');
    // Links
    text = text.replace(/<a\s+href="([^"]*)">([\s\S]*?)<\/a>/gi, '[$2]($1)');
    // Blockquotes
    text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, content) =>
        content.split('\n').map((l: string) => `> ${l}`).join('\n'),
    );
    // Strip remaining tags
    text = text.replace(/<[^>]+>/g, '');
    // Decode entities
    text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
    // Collapse excessive newlines
    text = text.replace(/\n{3,}/g, '\n\n').trim();
    return text;
}

const userStopRequestedChannels = new Set<string>();

// Interrupt state is managed by ../services/interruptState.ts
// (addPendingInterrupt, drainPendingInterrupts, etc.)

/** Channels where the user is expected to type plan edit instructions */
const planEditPendingChannels = new Map<string, { projectName: string }>();
/** Cached plan content pages per channel */
const planContentCache = new Map<string, string[]>();

function channelKey(ch: TelegramChannel): string {
    return ch.threadId ? `${ch.chatId}:${ch.threadId}` : String(ch.chatId);
}

function createSerialTaskQueue(queueName: string, traceId: string): (task: () => Promise<void>, label?: string) => Promise<void> {
    let queue: Promise<void> = Promise.resolve();
    let taskSeq = 0;

    return (task: () => Promise<void>, label: string = 'queue-task'): Promise<void> => {
        taskSeq += 1;
        const seq = taskSeq;

        queue = queue.then(async () => {
            try { await task(); }
            catch (err: any) { logger.error(`[sendQueue:${traceId}:${queueName}] error #${seq} label=${label}:`, err?.message || err); }
        });

        return queue;
    };
}

async function sendPromptToAntigravity(
    bridge: CdpBridge,
    channel: TelegramChannel,
    prompt: string,
    cdp: CdpService,
    modeService: ModeService,
    modelService: ModelService,
    inboundImages: InboundImageAttachment[] = [],
    options?: {
        chatSessionService: ChatSessionService;
        chatSessionRepo: ChatSessionRepository;
        topicManager: TelegramTopicManager;
        titleGenerator: TitleGeneratorService;
    }
): Promise<void> {
    const api = bridge.botApi!;
    const monitorTraceId = channelKey(channel);
    const enqueueGeneral = createSerialTaskQueue('general', monitorTraceId);
    const enqueueResponse = createSerialTaskQueue('response', monitorTraceId);
    const enqueueActivity = createSerialTaskQueue('activity', monitorTraceId);

    const sendMsg = async (text: string): Promise<number | null> => {
        try {
            const truncated = text.length > TELEGRAM_MSG_LIMIT ? text.slice(0, TELEGRAM_MSG_LIMIT - 20) + '\n...(truncated)' : text;
            const msg = await api.sendMessage(channel.chatId, truncated, {
                parse_mode: 'HTML',
                message_thread_id: channel.threadId,
            });
            return msg.message_id;
        } catch (e) {
            logger.error('[sendMsg] Failed:', e);
            return null;
        }
    };

    const editMsg = async (msgId: number, text: string, maxRetries = 3): Promise<void> => {
        const truncated = text.length > TELEGRAM_MSG_LIMIT ? text.slice(0, TELEGRAM_MSG_LIMIT - 20) + '\n...(truncated)' : text;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await api.editMessageText(channel.chatId, msgId, truncated, { parse_mode: 'HTML' });
                break;
            } catch (e: any) {
                const desc = e?.description || e?.message || '';
                if (desc.includes('message is not modified')) {
                    break;
                }
                const retryAfter = e?.parameters?.retry_after;
                if (retryAfter) {
                    logger.error(`[editMsg] Too Many Requests: retry after ${retryAfter}s (attempt ${attempt}/${maxRetries})`);
                    if (attempt < maxRetries) {
                        await new Promise(r => setTimeout(r, retryAfter * 1000));
                        continue;
                    }
                }
                logger.error('[editMsg] Failed:', desc);
                break;
            }
        }
    };

    const sendEmbed = (title: string, description: string): Promise<void> => enqueueGeneral(async () => {
        const text = `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(description)}`;
        await sendMsg(text);
    }, 'send-embed');

    /** Send a potentially long response, splitting into chunks and attaching a .md file if needed. */
    const sendChunkedResponse = async (title: string, footer: string, rawBody: string, isAlreadyHtml: boolean): Promise<void> => {
        const formattedBody = isAlreadyHtml ? rawBody : formatForTelegram(rawBody);
        const titleLine = title ? `<b>${escapeHtml(title)}</b>\n\n` : '';
        const footerLine = footer ? `\n\n<i>${escapeHtml(footer)}</i>` : '';
        const fullMsg = `${titleLine}${formattedBody}${footerLine}`;

        if (fullMsg.length <= TELEGRAM_MSG_LIMIT) {
            await upsertLiveResponse(title, rawBody, footer, { expectedVersion: liveResponseUpdateVersion, isAlreadyHtml, skipTruncation: true });
            return;
        }

        const bodyChunks = splitTelegramHtml(formattedBody, TELEGRAM_MSG_LIMIT - 200);
        const inlineCount = Math.min(bodyChunks.length, MAX_INLINE_CHUNKS);
        const hasFile = bodyChunks.length > MAX_INLINE_CHUNKS;
        const total = hasFile ? inlineCount : bodyChunks.length;

        for (let pi = 0; pi < inlineCount; pi++) {
            const partLabel = hasFile ? `(${pi + 1}/${inlineCount}+file)` : `(${pi + 1}/${total})`;
            if (pi === 0) {
                const firstTitle = title ? `${title} ${partLabel}` : partLabel;
                await upsertLiveResponse(firstTitle, bodyChunks[pi], footer, { expectedVersion: liveResponseUpdateVersion, isAlreadyHtml: true, skipTruncation: true });
            } else {
                const partFooter = footer ? `${escapeHtml(footer)} ${partLabel}` : partLabel;
                await sendMsg(`${bodyChunks[pi]}\n\n<i>${partFooter}</i>`);
            }
        }

        if (hasFile) {
            try {
                const fileContent = stripHtmlForFile(formattedBody);
                const buf = Buffer.from(fileContent, 'utf-8');
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                await api.sendDocument(channel.chatId, new InputFile(buf, `response-${timestamp}.md`), {
                    caption: `📄 Full response (${rawBody.length} chars)`,
                    message_thread_id: channel.threadId,
                });
            } catch (e) { logger.error('[sendPrompt] Failed to send response file:', e); }
        }
    };

    if (!cdp.isConnected()) {
        await sendEmbed(
            `${PHASE_ICONS.error} Connection Error`,
            `Not connected to Antigravity.\nStart with \`${getAntigravityCdpHint(9223)}\`, then send a message to auto-connect.`,
        );
        return;
    }

    const localMode = modeService.getCurrentMode();
    const modeName = MODE_UI_NAMES[localMode] || localMode;
    const currentModel = (await cdp.getCurrentModel()) || modelService.getCurrentModel();
    const modelLabel = `${currentModel}`;

    // Initialize live progress message (replaces separate "Sending" embed)
    let liveActivityMsgId: number | null = null;
    try {
        const sendingText = `<b>${PHASE_ICONS.sending} ${escapeHtml(modeName)} · ${escapeHtml(modelLabel)}</b>\n\n<i>Sending...</i>`;
        const sendingMsg = await api.sendMessage(channel.chatId, sendingText, { parse_mode: 'HTML', message_thread_id: channel.threadId });
        liveActivityMsgId = sendingMsg.message_id;
    } catch (e) { logger.error('[sendPrompt] Failed to send initial status:', e); }

    let isFinalized = false;
    let elapsedTimer: ReturnType<typeof setInterval> | null = null;
    let lastProgressText = '';
    const LIVE_RESPONSE_MAX_LEN = 3800;
    const MAX_PROGRESS_BODY = 3500;
    const MAX_PROGRESS_ENTRIES = 60;
    let liveResponseMsgId: number | null = null;
    let lastLiveResponseKey = '';
    let lastLiveActivityKey = '';
    let liveResponseUpdateVersion = 0;
    let liveActivityUpdateVersion = 0;

    // --- Ordered progress event stream ---
    interface ProgressEntry { kind: 'thought' | 'thought-content' | 'activity'; text: string; }
    const progressLog: ProgressEntry[] = [];
    let thinkingActive = false;
    const thinkingContentParts: string[] = [];
    let lastThoughtLabel = '';

    /** Check if text is junk (numbers, very short, not meaningful) */
    const isJunkEntry = (text: string): boolean => {
        const t = text.trim();
        if (t.length < 5) return true;
        if (/^\d+$/.test(t)) return true;
        // Single word under 8 chars without context (e.g. "Analyzed" alone)
        if (!/\s/.test(t) && t.length < 8) return true;
        return false;
    };

    /** Format a single activity line — collapse multi-line text into one line */
    const formatActivityLine = (raw: string): string => {
        // Collapse newlines into spaces so file references after verbs aren't lost
        // e.g. "Analyzed\npackage.json#L1-75" → "Analyzed package.json#L1-75"
        const collapsed = (raw || '').replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();
        if (!collapsed || isJunkEntry(collapsed)) return '';
        return escapeHtml(collapsed.slice(0, 120));
    };

    /** Trim progress log to stay within size limits */
    const trimProgressLog = (): void => {
        while (progressLog.length > MAX_PROGRESS_ENTRIES) progressLog.shift();
    };

    /** Build the progress message body from the ordered event stream */
    const buildProgressBody = (): string => {
        const lines: string[] = [];
        for (const e of progressLog) {
            switch (e.kind) {
                case 'thought':
                    lines.push(`💭 <i>${escapeHtml(e.text)}</i>`);
                    break;
                case 'thought-content':
                    lines.push(`<i>${escapeHtml(e.text)}</i>`);
                    break;
                case 'activity':
                    lines.push(e.text); // already HTML-escaped
                    break;
            }
        }
        if (thinkingActive) {
            lines.push('💭 <i>Thinking...</i>');
        }
        // Use \n\n for spacing between entries (like Antigravity's line gap)
        let body = lines.join('\n\n');
        // Trim from beginning if too long, keeping most recent events
        if (body.length > MAX_PROGRESS_BODY) {
            body = '...\n\n' + body.slice(-MAX_PROGRESS_BODY + 5);
        }
        return body || '<i>Generating...</i>';
    };

    /** Build full progress message with title + body + footer */
    const buildProgressMessage = (title: string, footer: string): string => {
        const body = buildProgressBody();
        const footerLine = footer ? `\n\n<i>${escapeHtml(footer)}</i>` : '';
        return `<b>${escapeHtml(title)}</b>\n\n${body}${footerLine}`;
    };

    const buildLiveResponseText = (title: string, rawText: string, footer: string, isAlreadyHtml = false, skipTruncation = false): string => {
        const normalized = (rawText || '').trim();
        const body = normalized
            ? (isAlreadyHtml ? normalized : formatForTelegram(normalized))
            : t('Generating...');
        const truncated = (!skipTruncation && body.length > LIVE_RESPONSE_MAX_LEN)
            ? '...(beginning truncated)\n' + body.slice(-LIVE_RESPONSE_MAX_LEN + 30)
            : body;
        const titleLine = title ? `<b>${escapeHtml(title)}</b>\n\n` : '';
        const footerLine = footer ? `\n\n<i>${escapeHtml(footer)}</i>` : '';
        return `${titleLine}${truncated}${footerLine}`;
    };

    const upsertLiveResponse = (title: string, rawText: string, footer: string, opts?: { expectedVersion?: number; skipWhenFinalized?: boolean; isAlreadyHtml?: boolean; skipTruncation?: boolean }): Promise<void> =>
        enqueueResponse(async () => {
            if (opts?.skipWhenFinalized && isFinalized) return;
            if (opts?.expectedVersion !== undefined && opts.expectedVersion !== liveResponseUpdateVersion) return;
            const text = buildLiveResponseText(title, rawText, footer, opts?.isAlreadyHtml, opts?.skipTruncation);
            const renderKey = `${title}|${rawText.slice(0, 200)}|${footer}`;
            if (renderKey === lastLiveResponseKey && liveResponseMsgId) return;
            lastLiveResponseKey = renderKey;

            if (liveResponseMsgId) {
                await editMsg(liveResponseMsgId, text);
            } else {
                liveResponseMsgId = await sendMsg(text);
            }
        }, 'upsert-response');

    /** Refresh progress message using the ordered event stream */
    const refreshProgress = (title: string, footer: string, opts?: { expectedVersion?: number; skipWhenFinalized?: boolean }): Promise<void> =>
        enqueueActivity(async () => {
            if (opts?.skipWhenFinalized && isFinalized) return;
            if (opts?.expectedVersion !== undefined && opts.expectedVersion !== liveActivityUpdateVersion) return;
            const text = buildProgressMessage(title, footer);
            // Use progress body hash for dedup
            const bodySnap = progressLog.length + '|' + thinkingActive + '|' + title + '|' + footer;
            if (bodySnap === lastLiveActivityKey && liveActivityMsgId) return;
            lastLiveActivityKey = bodySnap;

            if (liveActivityMsgId) {
                await editMsg(liveActivityMsgId, text);
            } else {
                liveActivityMsgId = await sendMsg(text);
            }
        }, 'upsert-activity');

    /** Direct message update for special cases (completion, quota, timeout) */
    const setProgressMessage = (htmlContent: string, opts?: { expectedVersion?: number }): Promise<void> =>
        enqueueActivity(async () => {
            if (opts?.expectedVersion !== undefined && opts.expectedVersion !== liveActivityUpdateVersion) return;
            lastLiveActivityKey = htmlContent.slice(0, 200);
            if (liveActivityMsgId) {
                await editMsg(liveActivityMsgId, htmlContent);
            } else {
                liveActivityMsgId = await sendMsg(htmlContent);
            }
        }, 'upsert-activity');

    const sendGeneratedImages = async (responseText: string): Promise<void> => {
        const imageIntentPattern = /(image|images|png|jpg|jpeg|gif|webp|illustration|diagram|render)/i;
        const imageUrlPattern = /https?:\/\/\S+\.(png|jpg|jpeg|gif|webp)/i;
        if (!imageIntentPattern.test(prompt) && !responseText.includes('![') && !imageUrlPattern.test(responseText)) return;

        const extracted = await cdp.extractLatestResponseImages(MAX_OUTBOUND_GENERATED_IMAGES);
        if (extracted.length === 0) return;

        for (let i = 0; i < extracted.length; i++) {
            const file = await toTelegramInputFile(extracted[i], i);
            if (file) {
                try {
                    await api.sendPhoto(channel.chatId, new InputFile(file.buffer, file.name), {
                        caption: `🖼️ Generated image (${i + 1}/${extracted.length})`,
                        message_thread_id: channel.threadId,
                    });
                } catch (e) { logger.error('[sendGeneratedImages] Failed:', e); }
            }
        }
    };

    const tryEmergencyExtractText = async (): Promise<string> => {
        try {
            const contextId = cdp.getPrimaryContextId();
            const expression = `(() => {
                const panel = document.querySelector('.antigravity-agent-side-panel');
                const scope = panel || document;
                const candidateSelectors = ['.rendered-markdown', '.leading-relaxed.select-text', '.flex.flex-col.gap-y-3', '[data-message-author-role="assistant"]', '[data-message-role="assistant"]', '[class*="assistant-message"]', '[class*="message-content"]', '[class*="markdown-body"]', '.prose'];
                const looksLikeActivity = (text) => { const n = (text || '').trim().toLowerCase(); if (!n) return true; return /^(?:analy[sz]ing|reading|writing|running|searching|planning|thinking|processing|loading|executing|testing|debugging|analyzed|read|wrote|ran)/i.test(n) && n.length <= 220; };
                const clean = (text) => (text || '').replace(/\\r/g, '').replace(/\\n{3,}/g, '\\n\\n').trim();
                const candidates = []; const seen = new Set();
                for (const selector of candidateSelectors) { const nodes = scope.querySelectorAll(selector); for (const node of nodes) { if (!node || seen.has(node)) continue; seen.add(node); candidates.push(node); } }
                for (let i = candidates.length - 1; i >= 0; i--) { const node = candidates[i]; const text = clean(node.innerText || node.textContent || ''); if (!text || text.length < 20) continue; if (looksLikeActivity(text)) continue; if (/^(good|bad)$/i.test(text)) continue; return text; }
                return '';
            })()`;
            const callParams: Record<string, unknown> = { expression, returnByValue: true, awaitPromise: true };
            if (contextId !== null) callParams.contextId = contextId;
            const res = await cdp.call('Runtime.evaluate', callParams);
            const value = res?.result?.value;
            return typeof value === 'string' ? value.trim() : '';
        } catch (e) { logger.debug('[tryEmergencyExtractText] Failed:', e); return ''; }
    };

    let monitor: ResponseMonitor | null = null;

    // Completion gate: holds the PromptDispatcher lock until onComplete/onTimeout fires.
    // Without this, monitor.start() resolves immediately (it schedules polling via setTimeout),
    // causing the dispatcher to release the lock while Antigravity is still generating —
    // allowing a second prompt to inject concurrently and produce duplicate responses.
    let resolveMonitorDone!: () => void;
    const monitorDone = new Promise<void>(resolve => { resolveMonitorDone = resolve; });

    try {
        // Reset PlanningDetector baseline BEFORE injecting the message.
        // This snapshots the current artifact count so the detector only
        // fires on NEW artifacts from the upcoming response (not old session artifacts).
        const projectName = cdp.getCurrentWorkspaceName() || bridge.lastActiveWorkspace;
        if (projectName) {
            const detector = bridge.pool.getPlanningDetector(projectName);
            if (detector) {
                await detector.resetBaseline().catch((err: Error) =>
                    logger.error('[sendPrompt] PlanningDetector baseline reset failed:', err),
                );
            }
        }

        let injectResult;
        if (inboundImages.length > 0) {
            injectResult = await cdp.injectMessageWithImageFiles(prompt, inboundImages.map(i => i.localPath));
            if (!injectResult.ok) {
                await sendEmbed(t('🖼️ Attached image fallback'), t('Failed to attach image directly, resending via URL reference.'));
                injectResult = await cdp.injectMessage(buildPromptWithAttachmentUrls(prompt, inboundImages));
            }
        } else {
            injectResult = await cdp.injectMessage(prompt);
        }

        if (!injectResult.ok) {
            isFinalized = true;
            await sendEmbed(`${PHASE_ICONS.error} Message Injection Failed`, `Failed to send message: ${injectResult.error}`);
            return;
        }

        const startTime = Date.now();
        const progressTitle = () => `${PHASE_ICONS.thinking} ${modelLabel}`;
        const progressFooter = () => `⏱️ ${Math.round((Date.now() - startTime) / 1000)}s`;

        let lastProgressTrigger = 0;
        let progressTriggerTimeout: NodeJS.Timeout | null = null;

        /** Trigger a progress message refresh */
        const triggerProgressRefresh = (): void => {
            const now = Date.now();
            if (now - lastProgressTrigger >= 3000) {
                if (progressTriggerTimeout) { clearTimeout(progressTriggerTimeout); progressTriggerTimeout = null; }
                lastProgressTrigger = now;
                liveActivityUpdateVersion += 1;
                const v = liveActivityUpdateVersion;
                refreshProgress(progressTitle(), progressFooter(), { expectedVersion: v, skipWhenFinalized: true }).catch(() => { });
            } else if (!progressTriggerTimeout) {
                progressTriggerTimeout = setTimeout(() => {
                    progressTriggerTimeout = null;
                    if (isFinalized) return;
                    lastProgressTrigger = Date.now();
                    liveActivityUpdateVersion += 1;
                    const v = liveActivityUpdateVersion;
                    refreshProgress(progressTitle(), progressFooter(), { expectedVersion: v, skipWhenFinalized: true }).catch(() => { });
                }, 3000 - (now - lastProgressTrigger));
            }
        };

        await refreshProgress(progressTitle(), progressFooter());

        monitor = new ResponseMonitor({
            cdpService: cdp,
            pollIntervalMs: 2000,
            maxDurationMs: 1800000,
            stopGoneConfirmCount: 3,
            onPhaseChange: () => { },
            onProcessLog: (logText) => {
                if (isFinalized) return;
                const trimmed = (logText || '').trim();
                if (!trimmed || isJunkEntry(trimmed)) return;
                const formatted = formatActivityLine(trimmed);
                if (formatted) {
                    progressLog.push({ kind: 'activity', text: formatted });
                    trimProgressLog();
                    triggerProgressRefresh();
                }
            },
            onThinkingLog: (thinkingText) => {
                if (isFinalized) return;
                const trimmed = (thinkingText || '').trim();
                if (!trimmed) return;
                logger.debug('[Bot] onThinkingLog received:', trimmed.slice(0, 100));

                const stripped = trimmed.replace(/^[^a-zA-Z]+/, '');

                if (/^thinking\.{0,3}$/i.test(stripped)) {
                    // Transient "Thinking..." — just set flag, don't add entry
                    thinkingActive = true;
                } else if (/^thought for\s/i.test(stripped)) {
                    // Completed thinking cycle: "Thought for 1s"
                    thinkingActive = false;
                    lastThoughtLabel = trimmed;
                    progressLog.push({ kind: 'thought', text: trimmed });
                    trimProgressLog();
                } else {
                    // Thinking content — merge as summary with most recent 'thought' entry
                    thinkingContentParts.push(trimmed);
                    const firstLine = trimmed.split('\n')[0].trim();
                    const heading = firstLine.length > 60 ? firstLine.slice(0, 57) + '...' : firstLine;
                    // Find most recent thought entry that doesn't yet have content attached
                    let merged = false;
                    for (let i = progressLog.length - 1; i >= 0; i--) {
                        if (progressLog[i].kind === 'thought') {
                            // Only merge if no content heading attached yet (no " — ")
                            if (!progressLog[i].text.includes(' — ')) {
                                progressLog[i].text += ` — ${heading}`;
                                merged = true;
                            }
                            break;
                        }
                    }
                    if (!merged && heading.length > 10) {
                        // No thought label to merge into — show as standalone content
                        progressLog.push({ kind: 'thought-content', text: heading });
                        trimProgressLog();
                    }
                }
                triggerProgressRefresh();
            },
            onProgress: (text) => {
                if (isFinalized) return;
                const isStructured = monitor?.getLastExtractionSource() === 'structured';
                const separated = isStructured ? { output: text, logs: '' } : splitOutputAndLogs(text);
                if (separated.output && separated.output.trim().length > 0) lastProgressText = separated.output;
            },
            onComplete: async (finalText, meta) => {
                if (isFinalized) return; // Guard: prevent duplicate completion
                isFinalized = true;
                if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
                const wasStoppedByUser = userStopRequestedChannels.delete(channelKey(channel));
                if (wasStoppedByUser) {
                    logger.info(`[sendPrompt:${monitorTraceId}] Stopped by user`);
                    await sendMsg('⏹️ Generation stopped.');
                    resolveMonitorDone?.();
                    return;
                }

                try {
                    const elapsed = Math.round((Date.now() - startTime) / 1000);
                    const isQuotaError = monitor!.getPhase() === 'quotaReached' || monitor!.getQuotaDetected();

                    if (isQuotaError) {
                        liveActivityUpdateVersion += 1;
                        thinkingActive = false;
                        await setProgressMessage(`<b>⚠️ ${escapeHtml(modelLabel)} · Quota Reached</b>\n\n${buildProgressBody()}\n\n<i>⏱️ ${elapsed}s</i>`, { expectedVersion: liveActivityUpdateVersion });
                        liveResponseUpdateVersion += 1;
                        await upsertLiveResponse('⚠️ Quota Reached', 'Model quota limit reached. Please wait or switch to a different model.', `⏱️ ${elapsed}s`, { expectedVersion: liveResponseUpdateVersion });

                        try {
                            const payload = await buildModelsUI(cdp, () => bridge.quota.fetchQuota());
                            if (payload) {
                                await api.sendMessage(channel.chatId, payload.text, { parse_mode: 'HTML', message_thread_id: channel.threadId, reply_markup: payload.keyboard });
                            }
                        } catch (e) { logger.error('[Quota] Failed to send model selection UI:', e); }
                        resolveMonitorDone();
                        return;
                    }

                    // Fresh DOM re-extraction at completion time to ensure we get the
                    // complete response — polling may have captured partial/stale text.
                    let freshText = '';
                    let freshIsHtml = false;
                    try {
                        const contextId = cdp.getPrimaryContextId();
                        const evalParams: Record<string, unknown> = {
                            expression: extractAssistantSegmentsPayloadScript(),
                            returnByValue: true,
                            awaitPromise: true,
                        };
                        if (contextId !== null && contextId !== undefined) evalParams.contextId = contextId;
                        const freshResult = await cdp.call('Runtime.evaluate', evalParams);
                        const freshClassified = classifyAssistantSegments(freshResult?.result?.value);
                        if (freshClassified.diagnostics.source === 'dom-structured' && freshClassified.finalOutputText.trim()) {
                            freshText = freshClassified.finalOutputText.trim();
                            freshIsHtml = true;
                        }
                    } catch (e) { logger.debug('[onComplete] Fresh structured extraction failed:', e); }

                    // Pick the best text: fresh extraction > polled finalText > lastProgressText > emergency
                    const polledText = (finalText && finalText.trim().length > 0) ? finalText : lastProgressText;
                    const bestPolled = polledText && polledText.trim().length > 0 ? polledText : '';
                    // Prefer the fresh extraction if it's at least as long (more complete)
                    let finalResponseText: string;
                    let isAlreadyHtml: boolean;
                    if (freshText && freshText.length >= bestPolled.length) {
                        finalResponseText = freshText;
                        isAlreadyHtml = freshIsHtml;
                    } else if (bestPolled) {
                        finalResponseText = bestPolled;
                        isAlreadyHtml = meta?.source === 'structured';
                    } else {
                        const emergencyText = await tryEmergencyExtractText();
                        finalResponseText = emergencyText;
                        isAlreadyHtml = false;
                    }
                    const separated = isAlreadyHtml ? { output: finalResponseText, logs: '' } : splitOutputAndLogs(finalResponseText);
                    const finalOutputText = separated.output || finalResponseText;

                    // Send collapsible thinking block as a separate message before the response.
                    // Extract both label and content directly from DOM at completion time,
                    // so we don't depend on polling (2s interval) having captured thinking events.
                    try {
                        const thinkExtract = await cdp.call('Runtime.evaluate', {
                            expression: `(function() {
                                var panel = document.querySelector('.antigravity-agent-side-panel');
                                var scope = panel || document;
                                var details = scope.querySelectorAll('details');
                                var blocks = [];
                                for (var i = 0; i < details.length; i++) {
                                    var d = details[i];
                                    var summary = d.querySelector('summary');
                                    if (!summary) continue;
                                    var rawLabel = (summary.textContent || '').trim();
                                    var stripped = rawLabel.replace(/^[^a-zA-Z]+/, '');
                                    if (!/^(?:thought for|thinking)\\b/i.test(stripped)) continue;
                                    var wasOpen = d.open;
                                    if (!wasOpen) d.open = true;
                                    // Try children first, then fall back to full textContent minus summary
                                    var children = d.children;
                                    var parts = [];
                                    for (var c = 0; c < children.length; c++) {
                                        if (children[c].tagName === 'SUMMARY' || children[c].tagName === 'STYLE') continue;
                                        var t = (children[c].innerText || children[c].textContent || '').trim();
                                        if (t && t.length >= 5) parts.push(t);
                                    }
                                    // Fallback: use detail's full text minus the summary text
                                    if (parts.length === 0) {
                                        var fullText = (d.innerText || d.textContent || '').trim();
                                        var bodyText = fullText.replace(rawLabel, '').trim();
                                        if (bodyText && bodyText.length >= 5) parts.push(bodyText);
                                    }
                                    if (!wasOpen) d.open = false;
                                    blocks.push({ label: rawLabel, body: parts.join('\\n\\n') });
                                }
                                return blocks;
                            })()`,
                            returnByValue: true,
                        });
                        const thinkBlocks: Array<{ label: string; body: string }> = Array.isArray(thinkExtract?.result?.value) ? thinkExtract.result.value : [];
                        if (thinkBlocks.length > 0) {
                            // Also incorporate poll-accumulated content if available
                            const accumulatedBody = thinkingContentParts.join('\n\n');
                            // Build combined thinking message — merge all blocks
                            const sections: string[] = [];
                            for (const block of thinkBlocks) {
                                const label = block.label || lastThoughtLabel || 'Thinking';
                                const body = block.body || accumulatedBody || '';
                                if (body) {
                                    sections.push(`  💭 <b>${escapeHtml(label)}</b>\n\n<i>${escapeHtml(body)}</i>`);
                                } else {
                                    sections.push(`  💭 <b>${escapeHtml(label)}</b>`);
                                }
                            }
                            const combined = sections.join('\n\n');
                            const maxThinkLen = TELEGRAM_MSG_LIMIT - 100;
                            const trimmed = combined.length > maxThinkLen ? combined.slice(0, maxThinkLen) + '...' : combined;
                            const thinkMsg = `<blockquote expandable>${trimmed}</blockquote>`;
                            logger.info(`[Bot] Sending thinking block: ${thinkBlocks.length} block(s), ${combined.length} chars`);
                            await sendMsg(thinkMsg);
                        } else {
                            logger.info('[Bot] No thinking blocks found in DOM at completion time');
                        }
                    } catch (e) { logger.error('[Bot] Failed to send thinking block:', e); }

                    if (finalOutputText && finalOutputText.trim().length > 0) {
                        logger.divider(`Output (${finalOutputText.length} chars)`);
                        console.info(finalOutputText);
                    }
                    logger.divider();

                    // Compact progress message: show completed title + event log
                    liveActivityUpdateVersion += 1;
                    thinkingActive = false;
                    const completedBody = buildProgressBody();
                    await setProgressMessage(`<b>${PHASE_ICONS.complete} ${escapeHtml(modelLabel)} · ${elapsed}s</b>\n\n${completedBody}`, { expectedVersion: liveActivityUpdateVersion });

                    liveResponseUpdateVersion += 1;
                    if (finalOutputText && finalOutputText.trim().length > 0) {
                        const footer = `⏱️ ${elapsed}s`;
                        await sendChunkedResponse('', footer, finalOutputText, isAlreadyHtml);
                    } else {
                        await upsertLiveResponse(`${PHASE_ICONS.complete} Complete`, t('Failed to extract response. Use /screenshot to verify.'), `⏱️ ${elapsed}s`, { expectedVersion: liveResponseUpdateVersion });
                    }

                    if (options) {
                        try {
                            const sessionInfo = await options.chatSessionService.getCurrentSessionInfo(cdp);
                            if (sessionInfo && sessionInfo.hasActiveChat && sessionInfo.title && sessionInfo.title !== t('(Untitled)')) {
                                const session = options.chatSessionRepo.findByChannelId(channelKey(channel));
                                const projectName = session
                                    ? bridge.pool.extractProjectName(session.workspacePath)
                                    : cdp.getCurrentWorkspaceName();
                                if (projectName) {
                                    registerApprovalSessionChannel(bridge, projectName, sessionInfo.title, channel);
                                }

                                if (session && session.displayName !== sessionInfo.title) {
                                    const newName = options.titleGenerator.sanitizeForChannelName(sessionInfo.title);
                                    const formattedName = `${session.sessionNumber}-${newName}`;
                                    const threadId = session.channelId.includes(':')
                                        ? Number(session.channelId.split(':')[1])
                                        : undefined;
                                    if (threadId) {
                                        try {
                                            options.topicManager.setChatId(Number(session.channelId.split(':')[0]));
                                            await options.topicManager.renameTopic(threadId, formattedName);
                                        } catch (e) { logger.debug('[Rename] Topic rename optional, failed:', e); }
                                    }
                                    options.chatSessionRepo.updateDisplayName(channelKey(channel), sessionInfo.title);
                                }
                            }
                        } catch (e) { logger.error('[Rename] Failed:', e); }
                    }

                    await sendGeneratedImages(finalOutputText || '');
                } catch (error) { logger.error(`[sendPrompt:${monitorTraceId}] onComplete failed:`, error); } finally { resolveMonitorDone?.(); }
            },
            onTimeout: async (lastText: string) => {
                try {
                    isFinalized = true;
                    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
                    userStopRequestedChannels.delete(channelKey(channel));
                    const elapsed = Math.round((Date.now() - startTime) / 1000);
                    const timeoutText = (lastText && lastText.trim().length > 0) ? lastText : lastProgressText;
                    const timeoutIsHtml = monitor!.getLastExtractionSource() === 'structured';
                    const separated = timeoutIsHtml ? { output: timeoutText || '', logs: '' } : splitOutputAndLogs(timeoutText || '');
                    const payload = separated.output && separated.output.trim().length > 0
                        ? `${separated.output}\n\n[Monitor Ended] Timeout after 30 minutes.`
                        : 'Monitor ended after 30 minutes. No text was retrieved.';

                    liveResponseUpdateVersion += 1;
                    await sendChunkedResponse(`${PHASE_ICONS.timeout} Timeout`, `⏱️ ${elapsed}s`, payload, timeoutIsHtml);
                    liveActivityUpdateVersion += 1;
                    thinkingActive = false;
                    await setProgressMessage(`<b>${PHASE_ICONS.timeout} ${escapeHtml(modelLabel)} · ${elapsed}s</b>\n\n${buildProgressBody()}`, { expectedVersion: liveActivityUpdateVersion });
                } catch (error) { logger.error(`[sendPrompt:${monitorTraceId}] onTimeout failed:`, error); } finally { resolveMonitorDone?.(); }
            },
        });

        await monitor.start();

        elapsedTimer = setInterval(() => {
            if (isFinalized) { clearInterval(elapsedTimer!); return; }
            triggerProgressRefresh();
        }, 5000);

        // Hold the PromptDispatcher lock until the monitor fires onComplete or onTimeout.
        // This prevents a second incoming prompt from injecting while Antigravity is still generating.
        await monitorDone;

    } catch (e: any) {
        isFinalized = true;
        userStopRequestedChannels.delete(channelKey(channel));
        if (elapsedTimer) { clearInterval(elapsedTimer); }
        if (monitor) { await monitor.stop().catch(() => {}); }
        const resolve = resolveMonitorDone as (() => void) | null;
        if (resolve) resolve();
        await sendEmbed(`${PHASE_ICONS.error} Error`, t(`Error occurred during processing: ${e.message}`));
        // Safety: resolve the gate so the dispatcher lock is released on early errors
        // (e.g., if monitor.start() throws before onComplete/onTimeout ever fires).
        resolveMonitorDone();
    }

    // Hold the dispatcher's workspace lock until the monitor finishes.
    // Without this, sendPromptToAntigravity resolves immediately after
    // monitor.start() (which only captures baselines and schedules polling),
    // releasing the lock and allowing concurrent prompts on the same workspace.
    if (monitorDone) {
        await monitorDone;
    }

    // Auto-dispatch any pending interrupt queue items now that the lock is released.
    // If the user never pressed Queue/Send/Discard, their messages auto-queue here.
    const wsKey = cdp.getCurrentWorkspaceName() ? `ws:${cdp.getCurrentWorkspaceName()}` : channelKey(channel);
    if (hasPendingInterrupts(wsKey)) {
        const pending = drainPendingInterrupts(wsKey);
        logger.info(`[AutoQueue] Dispatching ${pending.length} pending message(s) for ${wsKey}`);
        for (const item of pending) {
            // No bypass needed — lock is already released
            // We use dynamic import to avoid circular dependency with promptDispatcher
            // Instead, we re-call sendPromptToAntigravity directly (same call chain as promptDispatcher)
            sendPromptToAntigravity(
                bridge, item.channel, item.prompt, item.cdp,
                modeService, modelService, item.inboundImages,
                item.options,
            ).catch((err) => logger.error('[AutoQueue] Dispatch error:', err));
        }
    }
}

// =============================================================================
// Bot main entry point
// =============================================================================

export const startBot = async (cliLogLevel?: LogLevel) => {
    const config = loadConfig();
    logger.setLogLevel(cliLogLevel ?? config.logLevel);

    const dbPath = process.env.NODE_ENV === 'test' ? ':memory:' : ConfigLoader.getDefaultDbPath();
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    const modeService = new ModeService();
    const modelService = new ModelService();
    const templateRepo = new TemplateRepository(db);
    const workspaceBindingRepo = new WorkspaceBindingRepository(db);
    const chatSessionRepo = new ChatSessionRepository(db);
    const workspaceService = new WorkspaceService(config.workspaceBaseDir);

    await ensureAntigravityRunning();

    const bridge = initCdpBridge(config.autoApproveFileEdits);
    bridge.botToken = config.telegramBotToken;

    const chatSessionService = new ChatSessionService();
    const titleGenerator = new TitleGeneratorService();
    const promptDispatcher = new PromptDispatcher({
        bridge,
        modeService,
        modelService,
        sendPromptImpl: sendPromptToAntigravity,
        onTaskComplete: (channel, wsKey) => {
            // Auto-queue fallback: when a task finishes, auto-dispatch any
            // pending interrupts the user hasn't acted on yet.
            if (!hasPendingInterrupts(wsKey)) return;

            const queued = drainPendingInterrupts(wsKey);
            logger.info(`[autoQueue] Task done for ${wsKey} — auto-dispatching ${queued.length} queued message(s)`);

            for (const pending of queued) {
                // Edit the interrupt keyboard message to show it was auto-queued
                if (pending.interruptMsgId && bridge.botApi) {
                    bridge.botApi.editMessageText(
                        pending.channel.chatId,
                        pending.interruptMsgId,
                        '📥 Task finished — sending your queued message…',
                        { parse_mode: 'HTML' },
                    ).catch((e: any) => { logger.debug('[autoQueue] editMessage failed:', e); });
                }
                promptDispatcher.send({
                    channel: pending.channel,
                    prompt: pending.prompt,
                    cdp: pending.cdp,
                    inboundImages: pending.inboundImages,
                    options: pending.options,
                }).catch((e: any) => { logger.error('[autoQueue] dispatch failed:', e); });
            }
        },
    });

    const slashCommandHandler = new SlashCommandHandler(templateRepo);
    const cleanupHandler = new CleanupCommandHandler(chatSessionRepo, workspaceBindingRepo);

    const bot = new Bot(config.telegramBotToken);
    bridge.botApi = bot.api;

    // Notify user on WebSocket connection lifecycle events
    bridge.pool.on('workspace:disconnected', (projectName: string) => {
        const channel = bridge.lastActiveChannel;
        if (!channel || !bridge.botApi) return;
        bridge.botApi.sendMessage(channel.chatId, `⚠️ <b>${escapeHtml(projectName)}</b>: Connection lost. Reconnecting…`, {
            parse_mode: 'HTML',
            message_thread_id: channel.threadId,
        }).catch((err) => logger.error('[Bot] Failed to send disconnect notification:', err));
    });

    bridge.pool.on('workspace:reconnected', (projectName: string) => {
        const channel = bridge.lastActiveChannel;
        if (!channel || !bridge.botApi) return;
        bridge.botApi.sendMessage(channel.chatId, `✅ <b>${escapeHtml(projectName)}</b>: Reconnected.`, {
            parse_mode: 'HTML',
            message_thread_id: channel.threadId,
        }).catch((err) => logger.error('[Bot] Failed to send reconnect notification:', err));
    });

    bridge.pool.on('workspace:reconnectFailed', (projectName: string) => {
        const channel = bridge.lastActiveChannel;
        if (!channel || !bridge.botApi) return;
        bridge.botApi.sendMessage(channel.chatId, `❌ <b>${escapeHtml(projectName)}</b>: Reconnection failed. Send a message to retry.`, {
            parse_mode: 'HTML',
            message_thread_id: channel.threadId,
        }).catch((err) => logger.error('[Bot] Failed to send reconnect-failed notification:', err));
    });

    const topicManager = new TelegramTopicManager(bot.api, 0);

    // Auth middleware
    bot.use(async (ctx, next) => {
        const userId = String(ctx.from?.id ?? '');
        if (!config.allowedUserIds.includes(userId)) {
            if (ctx.callbackQuery) {
                await ctx.answerCallbackQuery({ text: 'You do not have permission.' });
            }
            return;
        }
        await next();
    });

    // Helper to build TelegramChannel from context
    const getChannel = (ctx: Context): TelegramChannel => ({
        chatId: ctx.chat!.id,
        threadId: ctx.message?.message_thread_id ?? undefined,
    });

    const getChannelFromCb = (ctx: Context): TelegramChannel => ({
        chatId: ctx.chat!.id,
        threadId: ctx.callbackQuery?.message?.message_thread_id ?? undefined,
    });

    const resolveWorkspaceAndCdp = async (ch: TelegramChannel): Promise<{ cdp: CdpService; projectName: string; workspacePath: string } | null> => {
        const key = channelKey(ch);
        const binding = workspaceBindingRepo.findByChannelId(key);
        if (!binding) return null;
        const workspacePath = workspaceService.getWorkspacePath(binding.workspacePath);
        try {
            const cdp = await bridge.pool.getOrConnect(workspacePath);
            const projectName = bridge.pool.extractProjectName(workspacePath);
            bridge.lastActiveWorkspace = projectName;
            bridge.lastActiveChannel = ch;
            registerApprovalWorkspaceChannel(bridge, projectName, ch);
            ensureApprovalDetector(bridge, cdp, projectName);
            ensureErrorPopupDetector(bridge, cdp, projectName);
            ensurePlanningDetector(bridge, cdp, projectName);
            return { cdp, projectName, workspacePath };
        } catch (e) {
            logger.error(`[resolveWorkspaceAndCdp] Connection failed:`, e);
            return null;
        }
    };

    const replyHtml = async (ctx: Context, text: string, keyboard?: InlineKeyboard) => {
        await ctx.reply(text, {
            parse_mode: 'HTML',
            reply_markup: keyboard,
        });
    };

    // /start command
    bot.command('start', async (ctx) => {
        await replyHtml(ctx,
            `<b>Remoat Online</b>\n\n` +
            `Use /help for available commands.\n` +
            `Send any text message to forward it to Antigravity.`
        );
    });

    // /help command
    bot.command('help', async (ctx) => {
        await replyHtml(ctx,
            `<b>📖 Remoat Commands</b>\n\n` +
            `<b>💬 Chat</b>\n` +
            `/new — Start a new chat session\n` +
            `/chat — Show current session info\n\n` +
            `<b>⏹️ Control</b>\n` +
            `/stop — Interrupt active LLM generation\n` +
            `/close — Terminate active Antigravity session\n` +
            `/screenshot — Capture Antigravity screen\n\n` +
            `<b>⚙️ Settings</b>\n` +
            `/mode — Display and change execution mode\n` +
            `/model — Display and change LLM model\n\n` +
            `<b>📁 Projects</b>\n` +
            `/project — Display project list\n\n` +
            `<b>📝 Templates</b>\n` +
            `/template — Show templates\n` +
            `/template_add — Register a template\n` +
            `/template_delete — Delete a template\n\n` +
            `<b>🔧 System</b>\n` +
            `/status — Display overall bot status\n` +
            `/autoaccept — Toggle auto-approve mode\n` +
            `/cleanup [days] — Clean up inactive sessions\n` +
            `/ping — Check latency\n\n` +
            `<i>Text messages are sent directly to Antigravity</i>`
        );
    });

    // /mode command
    bot.command('mode', async (ctx) => {
        await sendModeUI(
            async (text, keyboard) => { await replyHtml(ctx, text, keyboard); },
            modeService,
            { getCurrentCdp: () => getCurrentCdp(bridge) },
        );
    });

    // /model command
    bot.command('model', async (ctx) => {
        const ch = getChannel(ctx);
        const resolved = await resolveWorkspaceAndCdp(ch);
        const getCdp = (): CdpService | null => resolved?.cdp ?? getCurrentCdp(bridge);
        const modelName = ctx.match?.trim();
        if (modelName) {
            const cdp = getCdp();
            if (!cdp) { await ctx.reply('Not connected to CDP. Send a message first to connect.'); return; }
            const res = await cdp.setUiModel(modelName);
            if (res.ok) { await ctx.reply(`Model changed to <b>${escapeHtml(res.model || modelName)}</b>.`, { parse_mode: 'HTML' }); }
            else { await ctx.reply(res.error || 'Failed to change model.'); }
        } else {
            await sendModelsUI(
                async (text, keyboard) => { await replyHtml(ctx, text, keyboard); },
                { getCurrentCdp: getCdp, fetchQuota: async () => bridge.quota.fetchQuota() },
            );
        }
    });

    // /template command
    bot.command('template', async (ctx) => {
        const templates = templateRepo.findAll();
        await sendTemplateUI(
            async (text, keyboard) => { await replyHtml(ctx, text, keyboard); },
            templates,
        );
    });

    // /template_add command
    bot.command('template_add', async (ctx) => {
        const args = (ctx.match || '').trim();
        const parts = args.split(/\s+/);
        if (parts.length < 2) {
            await ctx.reply('Usage: /template_add <name> <prompt>');
            return;
        }
        const name = parts[0];
        const prompt = parts.slice(1).join(' ');
        const result = await slashCommandHandler.handleCommand('template', ['add', name, prompt]);
        await ctx.reply(result.message);
    });

    // /template_delete command
    bot.command('template_delete', async (ctx) => {
        const name = (ctx.match || '').trim();
        if (!name) { await ctx.reply('Usage: /template_delete <name>'); return; }
        const result = await slashCommandHandler.handleCommand('template', ['delete', name]);
        await ctx.reply(result.message);
    });

    // /status command
    bot.command('status', async (ctx) => {
        const activeNames = bridge.pool.getActiveWorkspaceNames();
        const currentMode = modeService.getCurrentMode();
        const autoAcceptStatus = bridge.autoAccept.isEnabled() ? '🟢 ON' : '⚪ OFF';

        let text = `<b>🔧 Bot Status</b>\n\n`;
        text += `<b>CDP:</b> ${activeNames.length > 0 ? `🟢 ${activeNames.length} project(s) connected` : '⚪ Disconnected'}\n`;
        text += `<b>Mode:</b> ${escapeHtml(MODE_DISPLAY_NAMES[currentMode] || currentMode)}\n`;
        text += `<b>Auto Approve:</b> ${autoAcceptStatus}\n`;

        if (activeNames.length > 0) {
            text += `\n<b>Connected Projects:</b>\n`;
            for (const name of activeNames) {
                const cdp = bridge.pool.getConnected(name);
                const contexts = cdp ? cdp.getContexts().length : 0;
                text += `• <b>${escapeHtml(name)}</b> — Contexts: ${contexts}\n`;
            }
        } else {
            text += `\nSend a message to auto-connect to a project.`;
        }

        await replyHtml(ctx, text);
    });

    // /autoaccept command
    bot.command('autoaccept', async (ctx) => {
        const requestedMode = (ctx.match || '').trim();
        if (requestedMode === 'on' || requestedMode === 'off') {
            const result = bridge.autoAccept.handle(requestedMode);
            await ctx.reply(result.message);
        } else {
            await sendAutoAcceptUI(
                async (text, keyboard) => { await replyHtml(ctx, text, keyboard); },
                bridge.autoAccept,
            );
        }
    });

    // /cleanup command
    bot.command('cleanup', async (ctx) => {
        const days = Math.max(1, parseInt((ctx.match || '').trim(), 10) || 7);
        const guildId = String(ctx.chat!.id);
        const inactive = cleanupHandler.findInactiveSessions(guildId, days);

        if (inactive.length === 0) {
            await replyHtml(ctx, `No inactive sessions older than <b>${days}</b> day(s).`);
            return;
        }

        const list = inactive.slice(0, 20).map(({ binding, session }) => {
            const label = session?.displayName ?? binding.workspacePath;
            return `• ${escapeHtml(label)}`;
        }).join('\n');
        const extra = inactive.length > 20 ? `\n…and ${inactive.length - 20} more` : '';

        const keyboard = new InlineKeyboard()
            .text('📦 Archive', `${CLEANUP_ARCHIVE_BTN}:${days}`)
            .text('🗑 Delete', `${CLEANUP_DELETE_BTN}:${days}`)
            .text('❌ Cancel', CLEANUP_CANCEL_BTN);

        await replyHtml(ctx,
            `<b>🧹 Cleanup</b>\n\n` +
            `Found <b>${inactive.length}</b> session(s) older than <b>${days}</b> day(s):\n\n` +
            `${list}${extra}\n\n` +
            `Choose an action:`,
            keyboard,
        );
    });

    // /screenshot command
    bot.command('screenshot', async (ctx) => {
        await handleScreenshot(
            async (input, caption) => { await ctx.replyWithPhoto(input, { caption }); },
            async (text) => { await ctx.reply(text); },
            getCurrentCdp(bridge),
        );
    });

    // /stop command
    bot.command('stop', async (ctx) => {
        const ch = getChannel(ctx);
        const resolved = await resolveWorkspaceAndCdp(ch);
        const cdp = resolved?.cdp ?? getCurrentCdp(bridge);
        if (!cdp) { await ctx.reply('⚠️ Not connected to CDP.'); return; }

        try {
            const contextId = cdp.getPrimaryContextId();
            const callParams: Record<string, unknown> = { expression: RESPONSE_SELECTORS.CLICK_STOP_BUTTON, returnByValue: true, awaitPromise: false };
            if (contextId !== null) callParams.contextId = contextId;
            const result = await cdp.call('Runtime.evaluate', callParams);
            const value = result?.result?.value;

            if (value?.ok) {
                const ch = getChannel(ctx);
                userStopRequestedChannels.add(channelKey(ch));
                await replyHtml(ctx, `<b>⏹️ Generation Interrupted</b>\nAI response generation was safely stopped.`);
            } else {
                await replyHtml(ctx, `<b>⚠️ Could Not Stop</b>\n${escapeHtml(value?.error || 'Stop button not found.')}`);
            }
        } catch (e: any) {
            await ctx.reply(`❌ Error during stop: ${e.message}`);
        }
    });

    // /close command
    bot.command('close', async (ctx) => {
        const ch = getChannel(ctx);
        const resolved = await resolveWorkspaceAndCdp(ch);
        const workspacePath = resolved?.workspacePath;

        if (!workspacePath) {
            await ctx.reply('⚠️ No active project bound to this chat. Cannot close.');
            return;
        }

        const projectName = bridge.pool.extractProjectName(workspacePath);
        
        try {
            await bridge.pool.closeBrowserWorkspace(projectName);
            await replyHtml(ctx, `<b>🛑 Workspace Closed</b>\nThe browser instance for <code>${escapeHtml(projectName)}</code> has been terminated.`);
        } catch (e: any) {
            await ctx.reply(`❌ Error closing workspace: ${e.message}`);
        }
    });
    // /project command
    bot.command('project', async (ctx) => {
        const workspaces = workspaceService.scanWorkspaces();
        const { text, keyboard } = buildProjectListUI(workspaces, 0);
        await replyHtml(ctx, text, keyboard);
    });

    // /new command
    bot.command('new', async (ctx) => {
        const ch = getChannel(ctx);
        const key = channelKey(ch);
        const session = chatSessionRepo.findByChannelId(key);
        const binding = workspaceBindingRepo.findByChannelId(key);
        const workspaceName = session?.workspacePath ?? binding?.workspacePath;

        if (!workspaceName) {
            await ctx.reply('⚠️ No project is bound to this chat. Use /project to select one.');
            return;
        }

        const workspacePath = workspaceService.getWorkspacePath(workspaceName);
        let cdp;
        try { cdp = await bridge.pool.getOrConnect(workspacePath); }
        catch (e: any) { await ctx.reply(`⚠️ Failed to connect: ${e.message}`); return; }

        try {
            const chatResult = await chatSessionService.startNewChat(cdp);
            if (chatResult.ok) {
                await replyHtml(ctx, `<b>💬 New Chat Started</b>\nSend your message now.`);
            } else {
                await ctx.reply(`⚠️ Could not start new chat: ${chatResult.error}`);
            }
        } catch (e: any) {
            await ctx.reply(`⚠️ Error: ${e.message}`);
        }
    });

    // /chat command
    bot.command('chat', async (ctx) => {
        const ch = getChannel(ctx);
        const key = channelKey(ch);
        const session = chatSessionRepo.findByChannelId(key);

        if (!session) {
            const activeNames = bridge.pool.getActiveWorkspaceNames();
            const anyCdp = activeNames.length > 0 ? bridge.pool.getConnected(activeNames[0]) : null;
            const info = anyCdp
                ? await chatSessionService.getCurrentSessionInfo(anyCdp)
                : { title: '(CDP Disconnected)', hasActiveChat: false };

            await replyHtml(ctx,
                `<b>💬 Chat Session Info</b>\n\n` +
                `<b>Title:</b> ${escapeHtml(info.title)}\n` +
                `<b>Status:</b> ${info.hasActiveChat ? '🟢 Active' : '⚪ Inactive'}\n\n` +
                `<i>Use /project to bind a project first.</i>`
            );
            return;
        }

        const allSessions = chatSessionRepo.findByCategoryId(session.categoryId);
        const sessionList = allSessions.map(s => {
            const name = s.displayName || `session-${s.sessionNumber}`;
            const current = s.channelId === key ? ' ← Current' : '';
            return `• ${name}${current}`;
        }).join('\n');

        await replyHtml(ctx,
            `<b>💬 Chat Session Info</b>\n\n` +
            `<b>Current:</b> #${session.sessionNumber} — ${escapeHtml(session.displayName || '(Unset)')}\n` +
            `<b>Project:</b> ${escapeHtml(session.workspacePath)}\n` +
            `<b>Total sessions:</b> ${allSessions.length}\n\n` +
            `<b>Sessions:</b>\n${escapeHtml(sessionList)}`
        );
    });

    // /ping command
    bot.command('ping', async (ctx) => {
        const start = Date.now();
        const msg = await ctx.reply('🏓 Pong!');
        const latency = Date.now() - start;
        await bot.api.editMessageText(ctx.chat!.id, msg.message_id, `🏓 Pong! Latency: <b>${latency}ms</b>`, { parse_mode: 'HTML' });
    });

    // =============================================================================
    // Callback query handler (inline keyboard buttons)
    // =============================================================================

    bot.on('callback_query:data', async (ctx) => {
        const data = ctx.callbackQuery.data;
        const ch = getChannelFromCb(ctx);

        // Mode selection
        if (data.startsWith('mode_select:')) {
            const selectedMode = data.replace('mode_select:', '');
            modeService.setMode(selectedMode);
            const cdp = getCurrentCdp(bridge);
            if (cdp) { const res = await cdp.setUiMode(selectedMode); if (!res.ok) logger.warn(`[Mode] UI switch failed: ${res.error}`); }
            const { text, keyboard } = await buildModeUI(modeService, { getCurrentCdp: () => getCurrentCdp(bridge) });
            try {
                await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
            } catch (e) { logger.debug('[modeSelect] editMessageText failed (expected if unchanged):', e); }
            await ctx.answerCallbackQuery({ text: `Mode: ${MODE_DISPLAY_NAMES[selectedMode] || selectedMode}` });
            return;
        }

        // Exhausted model button — show alert toast
        if (data.startsWith('model_exhausted_')) {
            const modelName = data.replace('model_exhausted_', '');
            await ctx.answerCallbackQuery({ text: `⛔ ${modelName} is exhausted. Wait for quota reset or pick another model.`, show_alert: true });
            return;
        }

        // Model selection
        if (data.startsWith('model_btn_')) {
            const modelName = data.replace('model_btn_', '');
            const cdp = getCurrentCdp(bridge);
            if (!cdp) { await ctx.answerCallbackQuery({ text: 'Not connected to CDP.' }); return; }
            const res = await cdp.setUiModel(modelName);
            if (res.ok) {
                const payload = await buildModelsUI(cdp, () => bridge.quota.fetchQuota());
                if (payload) try { await ctx.editMessageText(payload.text, { parse_mode: 'HTML', reply_markup: payload.keyboard }); } catch (e) { logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e); }
                await ctx.answerCallbackQuery({ text: `Model: ${res.model}` });
            } else {
                await ctx.answerCallbackQuery({ text: res.error || 'Failed to change model.' });
            }
            return;
        }

        // Model refresh
        if (data === 'model_refresh_btn') {
            const cdp = getCurrentCdp(bridge);
            if (!cdp) { await ctx.answerCallbackQuery({ text: 'Not connected.' }); return; }
            const payload = await buildModelsUI(cdp, () => bridge.quota.fetchQuota());
            if (payload) try { await ctx.editMessageText(payload.text, { parse_mode: 'HTML', reply_markup: payload.keyboard }); } catch (e) { logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e); }
            await ctx.answerCallbackQuery({ text: 'Refreshed' });
            return;
        }

        // Auto-accept buttons
        if (data === AUTOACCEPT_BTN_ON || data === AUTOACCEPT_BTN_OFF) {
            const action = data === AUTOACCEPT_BTN_ON ? 'on' : 'off';
            bridge.autoAccept.handle(action);
            await sendAutoAcceptUI(
                async (text, keyboard) => { try { await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }); } catch (e) { logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e); } },
                bridge.autoAccept,
            );
            await ctx.answerCallbackQuery({ text: `Auto-accept: ${action.toUpperCase()}` });
            return;
        }

        if (data === AUTOACCEPT_BTN_REFRESH) {
            await sendAutoAcceptUI(
                async (text, keyboard) => { try { await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }); } catch (e) { logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e); } },
                bridge.autoAccept,
            );
            await ctx.answerCallbackQuery({ text: 'Refreshed' });
            return;
        }

        // Project selection
        if (data.startsWith(`${PROJECT_SELECT_ID}:`)) {
            const workspacePath = data.replace(`${PROJECT_SELECT_ID}:`, '');
            if (!workspaceService.exists(workspacePath)) {
                await ctx.answerCallbackQuery({ text: `Project "${workspacePath}" not found.` });
                return;
            }

            let key = channelKey(ch);
            const guildId = String(ch.chatId);
            const isForum = ctx.chat?.type === 'supergroup' && (ctx.chat as any).is_forum === true;

            // Auto-create topic if conditions are met
            if (config.useTopics && isForum && !ch.threadId) {
                try {
                    const existing = workspaceBindingRepo.findByWorkspacePathAndGuildId(workspacePath, guildId);
                    const existingTopic = existing.find(b => b.channelId.includes(':'));

                    let topicId: number;
                    if (existingTopic) {
                        topicId = Number(existingTopic.channelId.split(':')[1]);
                        topicManager.registerTopic(workspacePath, topicId);
                    } else {
                        topicManager.setChatId(ch.chatId);
                        const sanitized = topicManager.sanitizeName(workspacePath);
                        const result = await topicManager.ensureTopic(sanitized);
                        topicId = result.topicId;
                    }

                    key = `${ch.chatId}:${topicId}`;

                    // Send welcome message in the new topic
                    const fullPath = workspaceService.getWorkspacePath(workspacePath);
                    await bot.api.sendMessage(
                        ch.chatId,
                        `<b>📁 Project Selected</b>\n\n✅ <b>${escapeHtml(workspacePath)}</b>\n<code>${escapeHtml(fullPath)}</code>\n\nSend messages here to interact with this project.`,
                        { parse_mode: 'HTML', message_thread_id: topicId },
                    );
                    workspaceBindingRepo.upsert({ channelId: key, workspacePath, guildId });
                    await ctx.answerCallbackQuery({ text: `Topic created for: ${workspacePath}` });
                    return;
                } catch (e: any) {
                    logger.warn(`[ProjectSelect] Topic creation failed, falling back: ${e.message}`);
                    // Fall through to default behavior
                }
            }

            workspaceBindingRepo.upsert({ channelId: key, workspacePath, guildId });

            const fullPath = workspaceService.getWorkspacePath(workspacePath);
            await ctx.editMessageText(
                `<b>📁 Project Selected</b>\n\n✅ <b>${escapeHtml(workspacePath)}</b>\n<code>${escapeHtml(fullPath)}</code>\n\nSend messages here to interact with this project.`,
                { parse_mode: 'HTML' },
            );
            await ctx.answerCallbackQuery({ text: `Selected: ${workspacePath}` });
            return;
        }

        // Project page navigation
        if (data.startsWith(`${PROJECT_PAGE_PREFIX}:`)) {
            const page = parseProjectPageId(data);
            if (!isNaN(page)) {
                const workspaces = workspaceService.scanWorkspaces();
                const { text, keyboard } = buildProjectListUI(workspaces, page);
                try { await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }); } catch (e) { logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e); }
            }
            await ctx.answerCallbackQuery();
            return;
        }

        // Template button
        if (data.startsWith(TEMPLATE_BTN_PREFIX)) {
            const templateId = parseTemplateButtonId(data);
            if (isNaN(templateId)) { await ctx.answerCallbackQuery({ text: 'Invalid template.' }); return; }
            const template = templateRepo.findById(templateId);
            if (!template) { await ctx.answerCallbackQuery({ text: 'Template not found.' }); return; }

            const resolved = await resolveWorkspaceAndCdp(ch);
            if (!resolved) {
                const cdp = getCurrentCdp(bridge);
                if (!cdp) { await ctx.answerCallbackQuery({ text: 'Not connected.' }); return; }
                promptDispatcher.send({ channel: ch, prompt: template.prompt, cdp, inboundImages: [], options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator } }).catch((e) => logger.error('[template] dispatch failed:', e));
            } else {
                promptDispatcher.send({ channel: ch, prompt: template.prompt, cdp: resolved.cdp, inboundImages: [], options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator } }).catch((e) => logger.error('[template] dispatch failed:', e));
            }
            await ctx.answerCallbackQuery({ text: `Running: ${template.name}` });
            return;
        }

        // Session selection
        if (isSessionSelectId(data)) {
            const selectedTitle = data.replace(`${SESSION_SELECT_ID}:`, '');
            const key = channelKey(ch);
            const binding = workspaceBindingRepo.findByChannelId(key);
            if (!binding) { await ctx.answerCallbackQuery({ text: 'No project bound.' }); return; }
            const workspacePath = workspaceService.getWorkspacePath(binding.workspacePath);
            try {
                const cdp = await bridge.pool.getOrConnect(workspacePath);
                const activateResult = await chatSessionService.activateSessionByTitle(cdp, selectedTitle);
                if (activateResult.ok) {
                    await ctx.editMessageText(`<b>🔗 Joined Session</b>\n\n<b>${escapeHtml(selectedTitle)}</b>`, { parse_mode: 'HTML' });
                } else {
                    await ctx.answerCallbackQuery({ text: `Failed: ${activateResult.error}` });
                }
            } catch (e: any) {
                await ctx.answerCallbackQuery({ text: `Error: ${e.message}` });
            }
            return;
        }

        // Approval buttons
        const approvalAction = parseApprovalCustomId(data);
        if (approvalAction) {
            const projectName = approvalAction.projectName ?? bridge.lastActiveWorkspace;
            const detector = projectName ? bridge.pool.getApprovalDetector(projectName) : undefined;
            if (!detector) { await ctx.answerCallbackQuery({ text: 'Approval detector not found.' }); return; }

            let success = false;
            let actionLabel = '';
            if (approvalAction.action === 'approve') { success = await detector.approveButton(); actionLabel = 'Allow'; }
            else if (approvalAction.action === 'always_allow') { success = await detector.alwaysAllowButton(); actionLabel = 'Allow Chat'; }
            else { success = await detector.denyButton(); actionLabel = 'Deny'; }

            if (success) {
                try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch (e) { logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e); }
                await ctx.answerCallbackQuery({ text: `${actionLabel} executed.` });
            } else {
                await ctx.answerCallbackQuery({ text: 'Button not found.' });
            }
            return;
        }

        // Planning buttons (legacy parsing for backward compat)
        const planningAction = parsePlanningCustomId(data);
        if (planningAction) {
            const projectName = planningAction.projectName ?? bridge.lastActiveWorkspace;
            const detector = projectName ? bridge.pool.getPlanningDetector(projectName) : undefined;
            if (!detector) { await ctx.answerCallbackQuery({ text: 'Planning detector not found.' }); return; }

            if (planningAction.action === 'open') {
                const clicked = await detector.clickOpenButton();
                if (clicked) {
                    await new Promise(r => setTimeout(r, 500));
                    let planContent: string | null = null;
                    for (let attempt = 0; attempt < 3; attempt++) {
                        planContent = await detector.extractPlanContent();
                        if (planContent) break;
                        await new Promise(r => setTimeout(r, 500));
                    }
                    if (planContent) {
                        const chKey = channelKey(ch);
                        const pages = paginatePlanContent(planContent);
                        planContentCache.set(chKey, pages);
                        const targetChannelStr = ch.threadId ? String(ch.threadId) : String(ch.chatId);
                        const lastInfo = detector.getLastDetectedInfo();
                        const { text: pageText, keyboard: pageKeyboard } = buildPlanContentUI(pages, 0, projectName || '', targetChannelStr, lastInfo?.planTitle ?? undefined, lastInfo?.proceedText ?? undefined);
                        await bot.api.sendMessage(ch.chatId, pageText, { parse_mode: 'HTML', message_thread_id: ch.threadId, reply_markup: pageKeyboard });
                    }
                }
                await ctx.answerCallbackQuery({ text: clicked ? 'Opened' : 'Open button not found.' });
            } else {
                const clicked = await detector.clickProceedButton();
                if (clicked) try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch (e) { logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e); }
                await ctx.answerCallbackQuery({ text: clicked ? 'Proceeding...' : 'Proceed button not found.' });
            }
            return;
        }

        // New plan UI buttons (View/Proceed/Edit/Refresh)
        if (data.startsWith(PLAN_VIEW_BTN + ':')) {
            const suffix = data.substring(PLAN_VIEW_BTN.length + 1);
            const [projectName] = suffix.split(':');
            const detector = projectName ? bridge.pool.getPlanningDetector(projectName) : undefined;
            if (!detector) { await ctx.answerCallbackQuery({ text: 'Planning detector not found.' }); return; }

            const clicked = await detector.clickOpenButton();
            if (clicked) {
                await new Promise(r => setTimeout(r, 500));
                let planContent: string | null = null;
                for (let attempt = 0; attempt < 3; attempt++) {
                    planContent = await detector.extractPlanContent();
                    if (planContent) break;
                    await new Promise(r => setTimeout(r, 500));
                }
                if (planContent) {
                    const chKey = channelKey(ch);
                    const pages = paginatePlanContent(planContent);
                    planContentCache.set(chKey, pages);
                    const targetChannelStr = ch.threadId ? String(ch.threadId) : String(ch.chatId);
                    const lastInfo = detector.getLastDetectedInfo();
                    const { text: pageText, keyboard: pageKeyboard } = buildPlanContentUI(pages, 0, projectName, targetChannelStr, lastInfo?.planTitle ?? undefined, lastInfo?.proceedText ?? undefined);
                    await bot.api.sendMessage(ch.chatId, pageText, { parse_mode: 'HTML', message_thread_id: ch.threadId, reply_markup: pageKeyboard });
                } else {
                    await bot.api.sendMessage(ch.chatId, `\u26A0\uFE0F <b>Extraction Failed</b>\n\nThe ${projectName ? escapeHtml(projectName) : 'workspace'} UI was instructed to open the file, but we couldn't extract the text content to show inside Telegram. Please check your IDE.`, { parse_mode: 'HTML', message_thread_id: ch.threadId });
                }
            }
            await ctx.answerCallbackQuery({ text: clicked ? 'Opened' : 'Open button not found.' });
            return;
        }

        if (data.startsWith(PLAN_PROCEED_BTN + ':')) {
            const suffix = data.substring(PLAN_PROCEED_BTN.length + 1);
            const [projectName] = suffix.split(':');
            const detector = projectName ? bridge.pool.getPlanningDetector(projectName) : undefined;
            if (!detector) { await ctx.answerCallbackQuery({ text: 'Planning detector not found.' }); return; }

            const clicked = await detector.clickProceedButton();
            if (clicked) {
                planEditPendingChannels.delete(channelKey(ch));
                try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch (e) { logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e); }
            }
            await ctx.answerCallbackQuery({ text: clicked ? 'Proceeding...' : 'Proceed button not found.' });
            return;
        }

        if (data.startsWith(PLAN_EDIT_BTN + ':')) {
            const suffix = data.substring(PLAN_EDIT_BTN.length + 1);
            const [projectName] = suffix.split(':');
            planEditPendingChannels.set(channelKey(ch), { projectName });
            await ctx.answerCallbackQuery({ text: 'Type your edit instructions (or /cancel).' });
            await bot.api.sendMessage(ch.chatId, '<b>Edit Plan</b>\n\nType your plan edit instructions below.\nSend <code>/cancel</code> to cancel.', { parse_mode: 'HTML', message_thread_id: ch.threadId });
            return;
        }

        if (data.startsWith(PLAN_REFRESH_BTN + ':')) {
            const suffix = data.substring(PLAN_REFRESH_BTN.length + 1);
            const [projectName, targetChannelStr] = suffix.split(':');
            const detector = projectName ? bridge.pool.getPlanningDetector(projectName) : undefined;
            if (!detector) { await ctx.answerCallbackQuery({ text: 'Planning detector not found.' }); return; }

            const info = detector.getLastDetectedInfo();
            if (info) {
                const { text: uiText, keyboard: uiKeyboard } = buildPlanNotificationUI(info, projectName, targetChannelStr || String(ch.chatId));
                try { await ctx.editMessageText(uiText, { parse_mode: 'HTML', reply_markup: uiKeyboard }); } catch (e) { logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e); }
            }
            await ctx.answerCallbackQuery({ text: 'Refreshed' });
            return;
        }

        // Plan pagination
        if (data.startsWith(PLAN_PAGE_PREFIX + ':')) {
            const rest = data.substring(PLAN_PAGE_PREFIX.length + 1);
            const colonIdx = rest.indexOf(':');
            const page = parseInt(rest.substring(0, colonIdx), 10);
            const suffix = rest.substring(colonIdx + 1);
            const [projectName, targetChannelStr] = suffix.split(':');
            const chKey = channelKey(ch);
            const pages = planContentCache.get(chKey);
            if (!pages || isNaN(page)) { await ctx.answerCallbackQuery({ text: 'Page not found.' }); return; }

            const detector = projectName ? bridge.pool.getPlanningDetector(projectName) : undefined;
            const lastInfo = detector?.getLastDetectedInfo();

            const { text: pageText, keyboard: pageKeyboard } = buildPlanContentUI(pages, page, projectName, targetChannelStr || String(ch.chatId), lastInfo?.planTitle ?? undefined, lastInfo?.proceedText ?? undefined);
            try { await ctx.editMessageText(pageText, { parse_mode: 'HTML', reply_markup: pageKeyboard }); } catch (e) { logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e); }
            await ctx.answerCallbackQuery({ text: `Page ${page + 1}/${pages.length}` });
            return;
        }

        // Error popup buttons
        const errorAction = parseErrorPopupCustomId(data);
        if (errorAction) {
            const projectName = errorAction.projectName ?? bridge.lastActiveWorkspace;
            const detector = projectName ? bridge.pool.getErrorPopupDetector(projectName) : undefined;
            if (!detector) { await ctx.answerCallbackQuery({ text: 'Error popup detector not found.' }); return; }

            if (errorAction.action === 'dismiss') {
                const clicked = await detector.clickDismissButton();
                if (clicked) try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch (e) { logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e); }
                await ctx.answerCallbackQuery({ text: clicked ? 'Dismissed' : 'Button not found.' });
            } else if (errorAction.action === 'copy_debug') {
                const clicked = await detector.clickCopyDebugInfoButton();
                let clipboardOk = false;
                if (clicked) {
                    await new Promise(r => setTimeout(r, 300));
                    const clipboardContent = await detector.readClipboard();
                    if (clipboardContent) {
                        clipboardOk = true;
                        const truncated = clipboardContent.length > 3800 ? clipboardContent.substring(0, 3800) + '\n(truncated)' : clipboardContent;
                        await bot.api.sendMessage(ch.chatId, `<b>Debug Info</b>\n\n<pre>${escapeHtml(truncated)}</pre>`, { parse_mode: 'HTML', message_thread_id: ch.threadId });
                    }
                }
                const feedbackText = !clicked ? 'Button not found.' : clipboardOk ? 'Copied' : 'Could not read clipboard.';
                await ctx.answerCallbackQuery({ text: feedbackText });
            } else {
                const clicked = await detector.clickRetryButton();
                if (clicked) try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch (e) { logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e); }
                await ctx.answerCallbackQuery({ text: clicked ? 'Retrying...' : 'Button not found.' });
            }
            return;
        }

        // Interrupt buttons (Queue / Send Now / Discard)
        if (data.startsWith(INTERRUPT_QUEUE_PREFIX) || data.startsWith(INTERRUPT_NOW_PREFIX) || data.startsWith(INTERRUPT_DISCARD_PREFIX)) {
            const targetKey = data.startsWith(INTERRUPT_QUEUE_PREFIX)
                ? data.slice(INTERRUPT_QUEUE_PREFIX.length)
                : data.startsWith(INTERRUPT_NOW_PREFIX)
                    ? data.slice(INTERRUPT_NOW_PREFIX.length)
                    : data.slice(INTERRUPT_DISCARD_PREFIX.length);

            if (data.startsWith(INTERRUPT_DISCARD_PREFIX)) {
                // Discard the first pending interrupt
                shiftPendingInterrupt(targetKey);
                try { await ctx.editMessageText('🗑 Message discarded.'); } catch (e) { logger.debug('[editMsg] Telegram edit failed:', e); }
                await ctx.answerCallbackQuery({ text: 'Discarded' });
                return;
            }

            const pending = shiftPendingInterrupt(targetKey);
            if (!pending) {
                try { await ctx.editMessageText('✅ Task finished — your message was already processed.'); } catch (e) { logger.debug('[editMsg] Telegram edit failed:', e); }
                await ctx.answerCallbackQuery({ text: 'Already processed' });
                return;
            }

            if (data.startsWith(INTERRUPT_NOW_PREFIX)) {
                // Stop current generation, then send the new prompt
                try { await ctx.editMessageText('⚡ Stopping current task and sending your message…'); } catch (e) { logger.debug('[editMsg] Telegram edit failed:', e); }
                await ctx.answerCallbackQuery({ text: 'Stopping & sending...' });

                // Click the stop button in Antigravity
                try {
                    const contextId = pending.cdp.getPrimaryContextId();
                    const callParams: Record<string, unknown> = { expression: RESPONSE_SELECTORS.CLICK_STOP_BUTTON, returnByValue: true, awaitPromise: false };
                    if (contextId !== null) callParams.contextId = contextId;
                    await pending.cdp.call('Runtime.evaluate', callParams);
                    userStopRequestedChannels.add(channelKey(pending.channel));
                } catch (e) { logger.debug('[interrupt:now] Stop button click failed:', e); }

                // Dispatch — send() chains on the workspace lock automatically;
                // no bypass needed (bypass is only checked in the text message handler).
                promptDispatcher.send({
                    channel: pending.channel,
                    prompt: pending.prompt,
                    cdp: pending.cdp,
                    inboundImages: pending.inboundImages,
                    options: pending.options,
                }).catch((e) => { logger.error('[interrupt:now] dispatch failed:', e); });
                return;
            }

            // INTERRUPT_QUEUE_PREFIX — queue to run after current task finishes
            try { await ctx.editMessageText('📥 Message queued — will send after current task.'); } catch (e) { logger.debug('[editMsg] Telegram edit failed:', e); }
            await ctx.answerCallbackQuery({ text: 'Queued' });

            promptDispatcher.send({
                channel: pending.channel,
                prompt: pending.prompt,
                cdp: pending.cdp,
                inboundImages: pending.inboundImages,
                options: pending.options,
            }).catch((e) => { logger.error('[interrupt:queue] dispatch failed:', e); });
            return;
        }

        // Cleanup buttons
        if (data.startsWith(CLEANUP_ARCHIVE_BTN) || data.startsWith(CLEANUP_DELETE_BTN) || data === CLEANUP_CANCEL_BTN) {
            if (data === CLEANUP_CANCEL_BTN) {
                try { await ctx.editMessageText('Cleanup cancelled.'); } catch (e) { logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e); }
                await ctx.answerCallbackQuery({ text: 'Cancelled' });
                return;
            }

            const isDelete = data.startsWith(CLEANUP_DELETE_BTN);
            const callbackDays = parseInt(data.split(':')[1], 10) || 7;
            const guildId = String(ch.chatId);
            const inactive = cleanupHandler.findInactiveSessions(guildId, callbackDays);

            let processed = 0;
            for (const { binding } of inactive) {
                const threadId = binding.channelId.includes(':')
                    ? Number(binding.channelId.split(':')[1])
                    : undefined;

                if (threadId) {
                    try {
                        if (isDelete) {
                            await bot.api.deleteForumTopic(ch.chatId, threadId);
                        } else {
                            await bot.api.closeForumTopic(ch.chatId, threadId);
                        }
                    } catch (e: any) {
                        logger.warn(`[Cleanup] Topic operation failed for ${binding.channelId}: ${e.message}`);
                    }
                }

                cleanupHandler.cleanupByChannelId(binding.channelId);
                processed++;
            }

            const action = isDelete ? 'deleted' : 'archived';
            try { await ctx.editMessageText(`✅ Cleanup complete — ${processed} session(s) ${action}.`); } catch (e) { logger.debug('[editMsg] Telegram edit failed (expected for unmodified):', e); }
            await ctx.answerCallbackQuery({ text: `${processed} session(s) ${action}` });
            return;
        }


        await ctx.answerCallbackQuery();
    });

    // =============================================================================
    // Text message handler (main chat flow)
    // =============================================================================

    bot.on('message:text', async (ctx) => {
        const ch = getChannel(ctx);
        const key = channelKey(ch);
        const text = ctx.message.text.trim();

        if (!text) return;

        // Plan edit interception
        const pendingPlanEdit = planEditPendingChannels.get(key);
        if (pendingPlanEdit) {
            if (text === '/cancel') {
                planEditPendingChannels.delete(key);
                await ctx.reply('Plan edit cancelled.');
                return;
            }

            planEditPendingChannels.delete(key);
            const editPrompt = `Please revise the plan based on the following feedback:\n\n${text}`;
            const resolved = await resolveWorkspaceAndCdp(ch);
            const cdp = resolved?.cdp ?? getCurrentCdp(bridge);
            if (!cdp) {
                await ctx.reply('Not connected to CDP.');
                return;
            }
            await ctx.reply('Sending plan edit...');
            promptDispatcher.send({
                channel: ch,
                prompt: editPrompt,
                cdp,
                inboundImages: [],
                options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator },
            }).catch((e) => logger.error('[planEdit] dispatch failed:', e));
            return;
        }

        // Check if it looks like a text command
        const parsed = parseMessageContent(text);
        if (parsed.isCommand && parsed.commandName) {
            if (parsed.commandName === 'autoaccept') {
                const result = bridge.autoAccept.handle(parsed.args?.[0]);
                await ctx.reply(result.message);
                return;
            }

            if (parsed.commandName === 'screenshot') {
                await handleScreenshot(
                    async (input, caption) => { await ctx.replyWithPhoto(input, { caption }); },
                    async (text) => { await ctx.reply(text); },
                    getCurrentCdp(bridge),
                );
                return;
            }

            if (parsed.commandName === 'status') {
                const activeNames = bridge.pool.getActiveWorkspaceNames();
                const currentMode = modeService.getCurrentMode();
                let statusText = `<b>🔧 Bot Status</b>\n\n`;
                statusText += `<b>CDP:</b> ${activeNames.length > 0 ? `🟢 ${activeNames.length} project(s)` : '⚪ Disconnected'}\n`;
                statusText += `<b>Mode:</b> ${escapeHtml(MODE_DISPLAY_NAMES[currentMode] || currentMode)}\n`;
                statusText += `<b>Auto Approve:</b> ${bridge.autoAccept.isEnabled() ? '🟢 ON' : '⚪ OFF'}`;
                await replyHtml(ctx, statusText);
                return;
            }

            const result = await slashCommandHandler.handleCommand(parsed.commandName, parsed.args || []);
            await ctx.reply(result.message);

            if (result.prompt) {
                const cdp = getCurrentCdp(bridge);
                if (cdp) {
                    promptDispatcher.send({
                        channel: ch,
                        prompt: result.prompt,
                        cdp,
                        inboundImages: [],
                        options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator },
                    }).catch((e) => logger.error('[slashCmd] dispatch failed:', e));
                } else {
                    await ctx.reply('Not connected to CDP. Send a message first to connect to a project.');
                }
            }
            return;
        }

        // Regular message — route to Antigravity
        const resolved = await resolveWorkspaceAndCdp(ch);
        if (!resolved) {
            await ctx.reply('No project is configured for this chat. Use /project to select one.');
            return;
        }

        // ── Concurrency gate: check if workspace is busy ────────────────────
        const wsKey = promptDispatcher.getWorkspaceKey(ch, resolved.cdp);
        const busy = promptDispatcher.isBusy(ch, resolved.cdp);
        const bypassed = busy ? consumeBypass(wsKey) : false;
        logger.info(`[concurrencyGate] wsKey=${wsKey} busy=${busy} bypassed=${bypassed}`);
        if (busy && !bypassed) {
            const dispatchOptions = { chatSessionService, chatSessionRepo, topicManager, titleGenerator };
            const position = addPendingInterrupt(wsKey, {
                prompt: text,
                channel: ch,
                cdp: resolved.cdp,
                inboundImages: [],
                options: dispatchOptions,
            });

            if (position === null) {
                await ctx.reply(`⚠️ Queue full (${MAX_QUEUE_DEPTH} messages pending). Please wait or /stop the current task.`);
                return;
            }

            if (position === 1) {
                // First in queue — show the interrupt keyboard
                const { text: uiText, keyboard } = buildInterruptUI(wsKey, text);
                const sent = await bot.api.sendMessage(ch.chatId, uiText, {
                    parse_mode: 'HTML',
                    message_thread_id: ch.threadId,
                    reply_markup: keyboard,
                });
                const pending = getFirstPendingInterrupt(wsKey);
                if (pending) pending.interruptMsgId = sent.message_id;
            } else {
                await ctx.reply(`📥 Message queued (#${position} in line)`);
            }
            return;
        }
        // ── End concurrency gate ────────────────────────────────────────────

        const session = chatSessionRepo.findByChannelId(key);
        if (session?.displayName) {
            registerApprovalSessionChannel(bridge, resolved.projectName, session.displayName, ch);
        }

        if (session?.isRenamed && session.displayName) {
            const activationResult = await chatSessionService.activateSessionByTitle(resolved.cdp, session.displayName);
            if (!activationResult.ok) {
                await ctx.reply(`⚠️ Could not route to session (${session.displayName}).`);
                return;
            }
        } else if (session && !session.isRenamed) {
            try { await chatSessionService.startNewChat(resolved.cdp); }
            catch (e) { logger.debug('[startNewChat] Failed, continuing anyway:', e); }
        }

        const userMsgDetector = bridge.pool.getUserMessageDetector?.(resolved.projectName);
        if (userMsgDetector) userMsgDetector.addEchoHash(text);

        // Fire-and-forget: do NOT await so Grammy can process the next update immediately.
        // The lock is set synchronously inside send() before its first await,
        // so isBusy() will see it when the next message handler runs.
        promptDispatcher.send({
            channel: ch,
            prompt: text,
            cdp: resolved.cdp,
            inboundImages: [],
            options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator },
        }).catch((e) => logger.error('[textMsg] dispatch failed:', e));
    });

    // Photo message handler
    bot.on('message:photo', async (ctx) => {
        const ch = getChannel(ctx);
        const photos = ctx.message.photo;
        if (!photos || photos.length === 0) return;

        const largest = photos[photos.length - 1];
        const caption = ctx.message.caption?.trim() || 'Please review the attached images and respond accordingly.';

        const resolved = await resolveWorkspaceAndCdp(ch);
        if (!resolved) { await ctx.reply('No project configured. Use /project first.'); return; }

        const inboundImages = await downloadTelegramImages(
            bot.api,
            config.telegramBotToken,
            [largest],
            String(ctx.message.message_id),
        );

        // ── Concurrency gate ────────────────────────────────────────────────
        const wsKey = promptDispatcher.getWorkspaceKey(ch, resolved.cdp);
        if (promptDispatcher.isBusy(ch, resolved.cdp) && !consumeBypass(wsKey)) {
            const position = addPendingInterrupt(wsKey, {
                prompt: caption,
                channel: ch,
                cdp: resolved.cdp,
                inboundImages,
                options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator },
            });

            if (position === null) {
                await cleanupInboundImageAttachments(inboundImages);
                await ctx.reply(`⚠️ Queue full (${MAX_QUEUE_DEPTH} messages pending). Please wait or /stop the current task.`);
                return;
            }

            if (position === 1) {
                const keyboard = new InlineKeyboard()
                    .text('📥 Queue', `interrupt:queue:${wsKey}`)
                    .text('⚡ Stop & Send Now', `interrupt:now:${wsKey}`)
                    .text('🗑 Discard', `interrupt:discard:${wsKey}`);
                await replyHtml(ctx,
                    `⏳ <b>AI is still generating a response…</b>\n\n🖼️ Photo message queued.`,
                    keyboard,
                );
            } else {
                await ctx.reply(`📥 Photo message queued (#${position} in line)`);
            }
            return; // Images kept in interruptState; cleaned up on dispatch or discard
        }
        // ── End concurrency gate ────────────────────────────────────────────

        // Fire-and-forget; cleanup images after dispatch completes (not immediately)
        promptDispatcher.send({
            channel: ch,
            prompt: caption,
            cdp: resolved.cdp,
            inboundImages,
            options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator },
        }).catch((e) => logger.error('[photoMsg] dispatch failed:', e))
         .finally(() => cleanupInboundImageAttachments(inboundImages).catch(() => {}));
    });

    // Voice message handler (voice-to-prompt via local Whisper transcription)
    bot.on('message:voice', async (ctx) => {
        const ch = getChannel(ctx);

        const whisperIssue = checkWhisperAvailability();
        if (whisperIssue) {
            await ctx.reply(whisperIssue);
            return;
        }

        const resolved = await resolveWorkspaceAndCdp(ch);
        if (!resolved) {
            await ctx.reply('No project configured. Use /project first.');
            return;
        }

        await ctx.reply('🎙️ Transcribing voice message...');

        let voicePath: string;
        try {
            voicePath = await downloadTelegramVoice(bot.api, config.telegramBotToken, ctx.message.voice);
        } catch (error: any) {
            logger.error('[Voice] Download failed:', error?.message || error);
            await ctx.reply('❌ Could not download voice message. Please try again.');
            return;
        }

        const transcript = await transcribeVoice(voicePath);
        if (!transcript) {
            await ctx.reply('❌ Could not transcribe voice message. Please try again or type your prompt.');
            return;
        }

        // Check if transcription is a slash command
        const parsed = parseMessageContent(transcript);
        if (parsed.isCommand && parsed.commandName) {
            const result = await slashCommandHandler.handleCommand(parsed.commandName, parsed.args || []);
            await ctx.reply(`🎙️ "${transcript}"\n\n${result.message}`);

            if (result.prompt) {
                const cdp = getCurrentCdp(bridge);
                if (cdp) {
                    promptDispatcher.send({
                        channel: ch,
                        prompt: result.prompt,
                        cdp,
                        inboundImages: [],
                        options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator },
                    }).catch((e) => logger.error('[voiceCmd] dispatch failed:', e));
                }
            }
            return;
        }

        await ctx.reply(`📝 "${transcript}"`);

        // ── Concurrency gate ────────────────────────────────────────────────
        const wsKey = promptDispatcher.getWorkspaceKey(ch, resolved.cdp);
        if (promptDispatcher.isBusy(ch, resolved.cdp) && !consumeBypass(wsKey)) {
            const position = addPendingInterrupt(wsKey, {
                prompt: transcript,
                channel: ch,
                cdp: resolved.cdp,
                inboundImages: [],
                options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator },
            });

            if (position === null) {
                await ctx.reply(`⚠️ Queue full (${MAX_QUEUE_DEPTH} messages pending). Please wait or /stop the current task.`);
                return;
            }

            if (position === 1) {
                const keyboard = new InlineKeyboard()
                    .text('📥 Queue', `interrupt:queue:${wsKey}`)
                    .text('⚡ Stop & Send Now', `interrupt:now:${wsKey}`)
                    .text('🗑 Discard', `interrupt:discard:${wsKey}`);
                const preview = transcript.length > 80 ? transcript.slice(0, 77) + '…' : transcript;
                await replyHtml(ctx,
                    `⏳ <b>AI is still generating a response…</b>\n\n🎙️ Voice: <i>${escapeHtml(preview)}</i>`,
                    keyboard,
                );
            } else {
                await ctx.reply(`📥 Voice message queued (#${position} in line)`);
            }
            return;
        }
        // ── End concurrency gate ────────────────────────────────────────────

        const userMsgDetector = bridge.pool.getUserMessageDetector?.(resolved.projectName);
        if (userMsgDetector) userMsgDetector.addEchoHash(transcript);

        // Fire-and-forget: same pattern as text handler
        promptDispatcher.send({
            channel: ch,
            prompt: transcript,
            cdp: resolved.cdp,
            inboundImages: [],
            options: { chatSessionService, chatSessionRepo, topicManager, titleGenerator },
        }).catch((e) => logger.error('[voiceMsg] dispatch failed:', e));
    });

    logger.info('Starting Remoat Telegram bot...');

    // Graceful shutdown: close database on exit
    const closeDb = () => { try { db.close(); } catch (e) { logger.debug('[shutdown] db.close() failed:', e); } };
    process.on('exit', closeDb);
    process.on('SIGINT', () => { closeDb(); process.exit(0); });
    process.on('SIGTERM', () => { closeDb(); process.exit(0); });

    bot.catch((err) => {
        logger.error('Bot error:', err);
    });

    await bot.start({
        onStart: async (botInfo) => {
            logger.info(`Bot started as @${botInfo.username} | extractionMode=${config.extractionMode}`);
            try {
                await bot.api.setMyCommands([
                    { command: 'start', description: 'Welcome message' },
                    { command: 'help', description: 'Show all commands' },
                    { command: 'project', description: 'Select a project' },
                    { command: 'new', description: 'Start a new chat session' },
                    { command: 'chat', description: 'Current session info' },
                    { command: 'mode', description: 'Change execution mode' },
                    { command: 'model', description: 'Change LLM model' },
                    { command: 'stop', description: 'Interrupt active generation' },
                    { command: 'close', description: 'Terminate active Antigravity session' },
                    { command: 'screenshot', description: 'Capture Antigravity screen' },
                    { command: 'template', description: 'Show prompt templates' },
                    { command: 'template_add', description: 'Register a template' },
                    { command: 'template_delete', description: 'Delete a template' },
                    { command: 'autoaccept', description: 'Toggle auto-approve mode' },
                    { command: 'status', description: 'Bot status overview' },
                    { command: 'ping', description: 'Check latency' },
                ]);
                logger.info('Telegram command menu registered successfully');
            } catch (err) {
                logger.error('Failed to register command menu:', err);
            }
        },
    });
};
