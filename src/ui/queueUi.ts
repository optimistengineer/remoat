import { InlineKeyboard } from 'grammy';
import { escapeHtml } from '../utils/telegramFormatter';

export const INTERRUPT_QUEUE_PREFIX = 'interrupt:queue:';
export const INTERRUPT_NOW_PREFIX = 'interrupt:now:';
export const INTERRUPT_DISCARD_PREFIX = 'interrupt:discard:';

/**
 * Build the interrupt keyboard shown when the user sends a message
 * while Antigravity is still generating a response.
 */
export function buildInterruptUI(channelKey: string, prompt: string): { text: string; keyboard: InlineKeyboard } {
    const preview = prompt.length > 80 ? prompt.slice(0, 80) + '…' : prompt;

    const text =
        `⏳ <b>Antigravity is working on a request.</b>\n\n` +
        `<i>${escapeHtml(preview)}</i>\n\n` +
        `Choose what to do with your message:`;

    const keyboard = new InlineKeyboard()
        .text('📥 Queue', `${INTERRUPT_QUEUE_PREFIX}${channelKey}`)
        .text('⚡ Send now', `${INTERRUPT_NOW_PREFIX}${channelKey}`)
        .row()
        .text('🗑 Don\'t send', `${INTERRUPT_DISCARD_PREFIX}${channelKey}`);

    return { text, keyboard };
}
