import { Api, InlineKeyboard } from 'grammy';

import { t } from '../utils/i18n';
import { logger } from '../utils/logger';
import { escapeHtml } from '../utils/telegramFormatter';
import { ApprovalDetector, ApprovalInfo } from './approvalDetector';
import { AutoAcceptService } from './autoAcceptService';
import { CdpConnectionPool } from './cdpConnectionPool';
import { CdpService } from './cdpService';
import { ErrorPopupDetector, ErrorPopupInfo } from './errorPopupDetector';
import { PlanningDetector, PlanningInfo } from './planningDetector';
import { QuotaService } from './quotaService';
import { UserMessageDetector, UserMessageInfo } from './userMessageDetector';
import { buildPlanNotificationUI } from '../ui/planUi';

/** Represents a Telegram chat target: either a chat_id or chat_id + message_thread_id */
export interface TelegramChannel {
    chatId: number | string;
    threadId?: number;
}

export interface CdpBridge {
    pool: CdpConnectionPool;
    quota: QuotaService;
    autoAccept: AutoAcceptService;
    lastActiveWorkspace: string | null;
    lastActiveChannel: TelegramChannel | null;
    approvalChannelByWorkspace: Map<string, TelegramChannel>;
    approvalChannelBySession: Map<string, TelegramChannel>;
    botApi: Api | null;
    botToken: string;
}

const APPROVE_ACTION_PREFIX = 'approve_action';
const ALWAYS_ALLOW_ACTION_PREFIX = 'always_allow_action';
const DENY_ACTION_PREFIX = 'deny_action';
const PLANNING_OPEN_ACTION_PREFIX = 'planning_open_action';
const PLANNING_PROCEED_ACTION_PREFIX = 'planning_proceed_action';
const ERROR_POPUP_DISMISS_ACTION_PREFIX = 'error_popup_dismiss_action';
const ERROR_POPUP_COPY_DEBUG_ACTION_PREFIX = 'error_popup_copy_debug_action';
const ERROR_POPUP_RETRY_ACTION_PREFIX = 'error_popup_retry_action';

function normalizeSessionTitle(title: string): string {
    return title.trim().toLowerCase();
}

function buildSessionRouteKey(projectName: string, sessionTitle: string): string {
    return `${projectName}::${normalizeSessionTitle(sessionTitle)}`;
}

const GET_CURRENT_CHAT_TITLE_SCRIPT = `(() => {
    const panel = document.querySelector('.antigravity-agent-side-panel');
    if (!panel) return '';
    const header = panel.querySelector('div[class*="border-b"]');
    if (!header) return '';
    const titleEl = header.querySelector('div[class*="text-ellipsis"]');
    const title = titleEl ? (titleEl.textContent || '').trim() : '';
    if (!title || title === 'Agent') return '';
    return title;
})()`;

export async function getCurrentChatTitle(cdp: CdpService): Promise<string | null> {
    const contexts = cdp.getContexts();
    for (const ctx of contexts) {
        try {
            const result = await cdp.call('Runtime.evaluate', {
                expression: GET_CURRENT_CHAT_TITLE_SCRIPT,
                returnByValue: true,
                contextId: ctx.id,
            });
            const value = result?.result?.value;
            if (typeof value === 'string' && value.trim().length > 0) {
                return value.trim();
            }
        } catch (e) { logger.debug('[CdpBridgeManager] Title probe failed, continuing:', e); }
    }
    return null;
}

export function registerApprovalWorkspaceChannel(
    bridge: CdpBridge,
    projectName: string,
    channel: TelegramChannel,
): void {
    bridge.approvalChannelByWorkspace.set(projectName, channel);
}

export function registerApprovalSessionChannel(
    bridge: CdpBridge,
    projectName: string,
    sessionTitle: string,
    channel: TelegramChannel,
): void {
    if (!sessionTitle || sessionTitle.trim().length === 0) return;
    bridge.approvalChannelBySession.set(buildSessionRouteKey(projectName, sessionTitle), channel);
    bridge.approvalChannelByWorkspace.set(projectName, channel);
}

export function resolveApprovalChannelForCurrentChat(
    bridge: CdpBridge,
    projectName: string,
    currentChatTitle: string | null,
): TelegramChannel | null {
    if (currentChatTitle && currentChatTitle.trim().length > 0) {
        const key = buildSessionRouteKey(projectName, currentChatTitle);
        const sessionChannel = bridge.approvalChannelBySession.get(key);
        if (sessionChannel) return sessionChannel;
    }
    return bridge.approvalChannelByWorkspace.get(projectName) ?? null;
}

export function buildApprovalCustomId(
    action: 'approve' | 'always_allow' | 'deny',
    projectName: string,
    channelId?: string,
): string {
    const prefix = action === 'approve'
        ? APPROVE_ACTION_PREFIX
        : action === 'always_allow'
            ? ALWAYS_ALLOW_ACTION_PREFIX
            : DENY_ACTION_PREFIX;
    if (channelId && channelId.trim().length > 0) {
        return `${prefix}:${projectName}:${channelId}`;
    }
    return `${prefix}:${projectName}`;
}

export function parseApprovalCustomId(customId: string): { action: 'approve' | 'always_allow' | 'deny'; projectName: string | null; channelId: string | null } | null {
    for (const [action, prefix] of [['approve', APPROVE_ACTION_PREFIX], ['always_allow', ALWAYS_ALLOW_ACTION_PREFIX], ['deny', DENY_ACTION_PREFIX]] as const) {
        if (customId === prefix) return { action, projectName: null, channelId: null };
        if (customId.startsWith(`${prefix}:`)) {
            const rest = customId.substring(`${prefix}:`.length);
            const [projectName, channelId] = rest.split(':');
            return { action, projectName: projectName || null, channelId: channelId || null };
        }
    }
    return null;
}

export function buildPlanningCustomId(
    action: 'open' | 'proceed',
    projectName: string,
    channelId?: string,
): string {
    const prefix = action === 'open' ? PLANNING_OPEN_ACTION_PREFIX : PLANNING_PROCEED_ACTION_PREFIX;
    if (channelId && channelId.trim().length > 0) return `${prefix}:${projectName}:${channelId}`;
    return `${prefix}:${projectName}`;
}

export function parsePlanningCustomId(customId: string): { action: 'open' | 'proceed'; projectName: string | null; channelId: string | null } | null {
    for (const [action, prefix] of [['open', PLANNING_OPEN_ACTION_PREFIX], ['proceed', PLANNING_PROCEED_ACTION_PREFIX]] as const) {
        if (customId === prefix) return { action, projectName: null, channelId: null };
        if (customId.startsWith(`${prefix}:`)) {
            const rest = customId.substring(`${prefix}:`.length);
            const [projectName, channelId] = rest.split(':');
            return { action, projectName: projectName || null, channelId: channelId || null };
        }
    }
    return null;
}

export function buildErrorPopupCustomId(
    action: 'dismiss' | 'copy_debug' | 'retry',
    projectName: string,
    channelId?: string,
): string {
    const prefix = action === 'dismiss'
        ? ERROR_POPUP_DISMISS_ACTION_PREFIX
        : action === 'copy_debug'
            ? ERROR_POPUP_COPY_DEBUG_ACTION_PREFIX
            : ERROR_POPUP_RETRY_ACTION_PREFIX;
    if (channelId && channelId.trim().length > 0) return `${prefix}:${projectName}:${channelId}`;
    return `${prefix}:${projectName}`;
}

export function parseErrorPopupCustomId(customId: string): { action: 'dismiss' | 'copy_debug' | 'retry'; projectName: string | null; channelId: string | null } | null {
    for (const [action, prefix] of [['dismiss', ERROR_POPUP_DISMISS_ACTION_PREFIX], ['copy_debug', ERROR_POPUP_COPY_DEBUG_ACTION_PREFIX], ['retry', ERROR_POPUP_RETRY_ACTION_PREFIX]] as const) {
        if (customId === prefix) return { action, projectName: null, channelId: null };
        if (customId.startsWith(`${prefix}:`)) {
            const rest = customId.substring(`${prefix}:`.length);
            const [projectName, channelId] = rest.split(':');
            return { action, projectName: projectName || null, channelId: channelId || null };
        }
    }
    return null;
}

export function initCdpBridge(autoApproveDefault: boolean): CdpBridge {
    const pool = new CdpConnectionPool({
        cdpCallTimeout: 15000,
        maxReconnectAttempts: 3,
        reconnectDelayMs: 3000,
    });

    const quota = new QuotaService();
    const autoAccept = new AutoAcceptService(autoApproveDefault);

    return {
        pool,
        quota,
        autoAccept,
        lastActiveWorkspace: null,
        lastActiveChannel: null,
        approvalChannelByWorkspace: new Map(),
        approvalChannelBySession: new Map(),
        botApi: null,
        botToken: '',
    };
}

export function getCurrentCdp(bridge: CdpBridge): CdpService | null {
    if (bridge.lastActiveWorkspace) {
        const cdp = bridge.pool.getConnected(bridge.lastActiveWorkspace);
        if (cdp) return cdp;
    }
    // Fallback: return any connected workspace
    const activeNames = bridge.pool.getActiveWorkspaceNames();
    if (activeNames.length > 0) {
        return bridge.pool.getConnected(activeNames[0]);
    }
    return null;
}

async function sendTelegramMessage(
    api: Api,
    channel: TelegramChannel,
    text: string,
    keyboard?: InlineKeyboard,
): Promise<number | null> {
    try {
        const msg = await api.sendMessage(channel.chatId, text, {
            parse_mode: 'HTML',
            message_thread_id: channel.threadId,
            reply_markup: keyboard,
        });
        return msg.message_id;
    } catch (err) {
        logger.error('[Telegram] Failed to send message:', err);
        return null;
    }
}

export function ensureApprovalDetector(
    bridge: CdpBridge,
    cdp: CdpService,
    projectName: string,
): void {
    const existing = bridge.pool.getApprovalDetector(projectName);
    if (existing && existing.isActive()) return;

    let lastMessageId: number | null = null;
    let lastMessageChatId: number | string | null = null;

    const detector = new ApprovalDetector({
        cdpService: cdp,
        pollIntervalMs: 2000,
        onResolved: () => {
            if (!lastMessageId || !lastMessageChatId || !bridge.botApi) return;
            const msgId = lastMessageId;
            const chatId = lastMessageChatId;
            lastMessageId = null;
            lastMessageChatId = null;
            bridge.botApi.editMessageReplyMarkup(chatId, msgId, { reply_markup: undefined })
                .catch(logger.error);
        },
        onApprovalRequired: async (info: ApprovalInfo) => {
            logger.debug(`[ApprovalDetector:${projectName}] Approval detected`);

            const currentChatTitle = await getCurrentChatTitle(cdp);
            const targetChannel = resolveApprovalChannelForCurrentChat(bridge, projectName, currentChatTitle);

            if (!targetChannel || !bridge.botApi) {
                logger.warn(`[ApprovalDetector:${projectName}] Skipped — no target channel`);
                return;
            }

            const targetChannelStr = targetChannel.threadId ? String(targetChannel.threadId) : String(targetChannel.chatId);

            if (bridge.autoAccept.isEnabled()) {
                const accepted = await detector.alwaysAllowButton() || await detector.approveButton();
                const text = accepted
                    ? `✅ <b>Auto-approved</b>\nAn action was automatically approved.\n<b>Workspace:</b> ${escapeHtml(projectName)}`
                    : `⚠️ <b>Auto-approve failed</b>\nManual approval required.\n<b>Workspace:</b> ${escapeHtml(projectName)}`;
                await sendTelegramMessage(bridge.botApi, targetChannel, text);
                if (accepted) return;
            }

            let text = `🔔 <b>Approval Required</b>\n\n`;
            if (info.description) text += `${escapeHtml(info.description)}\n\n`;
            text += `<b>Approve:</b> ${escapeHtml(info.approveText)}\n`;
            if (info.alwaysAllowText) text += `<b>Always:</b> ${escapeHtml(info.alwaysAllowText)}\n`;
            text += `<b>Deny:</b> ${escapeHtml(info.denyText || '(None)')}\n`;
            text += `<b>Workspace:</b> ${escapeHtml(projectName)}`;

            // Use actual button labels from the UI
            const approveLabel = info.approveText.replace(/[⌃⌥⇧⏎⌘\u2318\u2325\u21B5]+/g, '').trim() || 'Allow';
            const denyLabel = info.denyText || 'Deny';
            const keyboard = new InlineKeyboard()
                .text(`✅ ${approveLabel}`, buildApprovalCustomId('approve', projectName, targetChannelStr));
            if (info.alwaysAllowText) {
                keyboard.text('✅ Allow Chat', buildApprovalCustomId('always_allow', projectName, targetChannelStr));
            }
            keyboard.text(`❌ ${denyLabel}`, buildApprovalCustomId('deny', projectName, targetChannelStr));

            const msgId = await sendTelegramMessage(bridge.botApi, targetChannel, text, keyboard);
            if (msgId) {
                lastMessageId = msgId;
                lastMessageChatId = targetChannel.chatId;
            }
        },
    });

    detector.start();
    bridge.pool.registerApprovalDetector(projectName, detector);
    logger.debug(`[ApprovalDetector:${projectName}] Started`);
}

export function ensurePlanningDetector(
    bridge: CdpBridge,
    cdp: CdpService,
    projectName: string,
): void {
    const existing = bridge.pool.getPlanningDetector(projectName);
    if (existing && existing.isActive()) return;

    let lastMessageId: number | null = null;
    let lastMessageChatId: number | string | null = null;

    const detector = new PlanningDetector({
        cdpService: cdp,
        pollIntervalMs: 2000,
        onResolved: () => {
            if (!lastMessageId || !lastMessageChatId || !bridge.botApi) return;
            const msgId = lastMessageId;
            const chatId = lastMessageChatId;
            lastMessageId = null;
            lastMessageChatId = null;
            bridge.botApi.editMessageReplyMarkup(chatId, msgId, { reply_markup: undefined })
                .catch(logger.error);
        },
        onPlanningRequired: async (info: PlanningInfo) => {
            logger.debug(`[PlanningDetector:${projectName}] Planning detected`);

            const currentChatTitle = await getCurrentChatTitle(cdp);
            const targetChannel = resolveApprovalChannelForCurrentChat(bridge, projectName, currentChatTitle);

            if (!targetChannel || !bridge.botApi) return;

            const targetChannelStr = targetChannel.threadId ? String(targetChannel.threadId) : String(targetChannel.chatId);

            const { text, keyboard } = buildPlanNotificationUI(info, projectName, targetChannelStr);

            const msgId = await sendTelegramMessage(bridge.botApi, targetChannel, text, keyboard);
            if (msgId) {
                lastMessageId = msgId;
                lastMessageChatId = targetChannel.chatId;
            }
        },
        onAutoOpened: async (chipText: string) => {
            logger.info(`[PlanningDetector:${projectName}] Auto-opened: "${chipText}"`);

            const currentChatTitle = await getCurrentChatTitle(cdp);
            const targetChannel = resolveApprovalChannelForCurrentChat(bridge, projectName, currentChatTitle);

            if (!targetChannel || !bridge.botApi) return;

            const text = `📄 <b>${chipText}</b> opened in <b>${projectName}</b>\n\n<i>Auto-opened — view in Antigravity editor.</i>`;
            await sendTelegramMessage(bridge.botApi, targetChannel, text);
        },
    });

    detector.start();
    bridge.pool.registerPlanningDetector(projectName, detector);
    logger.debug(`[PlanningDetector:${projectName}] Started`);
}

export function ensureErrorPopupDetector(
    bridge: CdpBridge,
    cdp: CdpService,
    projectName: string,
): void {
    const existing = bridge.pool.getErrorPopupDetector(projectName);
    if (existing && existing.isActive()) return;

    let lastMessageId: number | null = null;
    let lastMessageChatId: number | string | null = null;

    const detector = new ErrorPopupDetector({
        cdpService: cdp,
        pollIntervalMs: 3000,
        onResolved: () => {
            if (!lastMessageId || !lastMessageChatId || !bridge.botApi) return;
            const msgId = lastMessageId;
            const chatId = lastMessageChatId;
            lastMessageId = null;
            lastMessageChatId = null;
            bridge.botApi.editMessageReplyMarkup(chatId, msgId, { reply_markup: undefined })
                .catch(logger.error);
        },
        onErrorPopup: async (info: ErrorPopupInfo) => {
            logger.debug(`[ErrorPopupDetector:${projectName}] Error popup detected`);

            const currentChatTitle = await getCurrentChatTitle(cdp);
            const targetChannel = resolveApprovalChannelForCurrentChat(bridge, projectName, currentChatTitle);

            if (!targetChannel || !bridge.botApi) return;

            const targetChannelStr = targetChannel.threadId ? String(targetChannel.threadId) : String(targetChannel.chatId);
            const bodyText = info.body || t('An error occurred in the Antigravity agent.');

            let text = `❌ <b>${escapeHtml(info.title || 'Agent Error')}</b>\n\n`;
            text += escapeHtml(bodyText.substring(0, 3800)) + `\n\n`;
            text += `<b>Buttons:</b> ${escapeHtml(info.buttons.join(', ') || '(None)')}\n`;
            text += `<b>Workspace:</b> ${escapeHtml(projectName)}`;

            const keyboard = new InlineKeyboard()
                .text('🔇 Dismiss', buildErrorPopupCustomId('dismiss', projectName, targetChannelStr))
                .text('📋 Copy Debug', buildErrorPopupCustomId('copy_debug', projectName, targetChannelStr))
                .text('🔄 Retry', buildErrorPopupCustomId('retry', projectName, targetChannelStr));

            const msgId = await sendTelegramMessage(bridge.botApi, targetChannel, text, keyboard);
            if (msgId) {
                lastMessageId = msgId;
                lastMessageChatId = targetChannel.chatId;
            }
        },
    });

    detector.start();
    bridge.pool.registerErrorPopupDetector(projectName, detector);
    logger.debug(`[ErrorPopupDetector:${projectName}] Started`);
}

export function ensureUserMessageDetector(
    bridge: CdpBridge,
    cdp: CdpService,
    projectName: string,
    onUserMessage: (info: UserMessageInfo) => void,
): void {
    const existing = bridge.pool.getUserMessageDetector(projectName);
    if (existing && existing.isActive()) return;

    const detector = new UserMessageDetector({
        cdpService: cdp,
        pollIntervalMs: 2000,
        onUserMessage,
    });

    detector.start();
    bridge.pool.registerUserMessageDetector(projectName, detector);
    logger.debug(`[UserMessageDetector:${projectName}] Started`);
}
