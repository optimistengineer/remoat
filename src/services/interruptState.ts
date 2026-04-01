/**
 * Interrupt state management for Telegram concurrency queue.
 *
 * When a user sends a message while the AI is still generating, we store
 * the pending request here and show an inline keyboard.  Only the first
 * pending message gets the keyboard; messages 2–3 auto-queue silently.
 *
 * Inspired by cc-claw's pendingInterrupts / bypassBusyCheck pattern.
 */

import type { TelegramChannel } from './cdpBridgeManager';
import type { CdpService } from './cdpService';
import type { PromptDispatchOptions } from './promptDispatcher';
import type { InboundImageAttachment } from '../utils/imageHandler';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PendingInterrupt {
    /** The user's prompt text */
    prompt: string;
    /** Telegram channel (chatId + threadId) */
    channel: TelegramChannel;
    /** CDP service for the target workspace */
    cdp: CdpService;
    /** Images attached to the message */
    inboundImages: InboundImageAttachment[];
    /** Dispatch options (session service, etc.) */
    options?: PromptDispatchOptions;
    /** Position in queue (1 = first / has keyboard) */
    position: number;
    /** Timestamp when the interrupt was created */
    createdAt: number;
    /** Telegram message ID of the interrupt keyboard message (position=1 only) */
    interruptMsgId?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of pending messages per workspace. */
export const MAX_QUEUE_DEPTH = 3;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * Pending interrupts keyed by workspace key.
 * Each workspace has an ordered array of up to MAX_QUEUE_DEPTH items.
 */
const pendingInterrupts = new Map<string, PendingInterrupt[]>();

/**
 * Workspace keys that should bypass the busy check on their next dispatch.
 * Set when the user taps Queue or Send Now; consumed by the message handler.
 */
const bypassBusyCheck = new Set<string>();

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

/**
 * Add a pending interrupt for a workspace.
 * Returns the position in queue (1-based) or null if the queue is full.
 */
export function addPendingInterrupt(wsKey: string, interrupt: Omit<PendingInterrupt, 'position' | 'createdAt'>): number | null {
    const queue = pendingInterrupts.get(wsKey) ?? [];

    if (queue.length >= MAX_QUEUE_DEPTH) {
        return null; // Queue full
    }

    const position = queue.length + 1;
    queue.push({
        ...interrupt,
        position,
        createdAt: Date.now(),
    });
    pendingInterrupts.set(wsKey, queue);
    return position;
}

/**
 * Get the first (keyboard-holding) pending interrupt for a workspace.
 */
export function getFirstPendingInterrupt(wsKey: string): PendingInterrupt | undefined {
    const queue = pendingInterrupts.get(wsKey);
    return queue?.[0];
}

/**
 * Get all pending interrupts for a workspace (ordered).
 */
export function getAllPendingInterrupts(wsKey: string): PendingInterrupt[] {
    return pendingInterrupts.get(wsKey) ?? [];
}

/**
 * Get the queue depth for a workspace.
 */
export function getQueueDepth(wsKey: string): number {
    return pendingInterrupts.get(wsKey)?.length ?? 0;
}

/**
 * Remove and return the first pending interrupt (the one with the keyboard).
 * Remaining items stay in the queue with positions renumbered.
 */
export function shiftPendingInterrupt(wsKey: string): PendingInterrupt | undefined {
    const queue = pendingInterrupts.get(wsKey);
    if (!queue || queue.length === 0) return undefined;

    const first = queue.shift()!;

    // Renumber remaining items
    for (let i = 0; i < queue.length; i++) {
        queue[i].position = i + 1;
    }

    if (queue.length === 0) {
        pendingInterrupts.delete(wsKey);
    }

    return first;
}

/**
 * Remove and return ALL pending interrupts for a workspace.
 * Used when dispatching the entire queue (Queue / Send Now).
 */
export function drainPendingInterrupts(wsKey: string): PendingInterrupt[] {
    const queue = pendingInterrupts.get(wsKey) ?? [];
    pendingInterrupts.delete(wsKey);
    return queue;
}

/**
 * Check if a workspace has any pending interrupts.
 */
export function hasPendingInterrupts(wsKey: string): boolean {
    const queue = pendingInterrupts.get(wsKey);
    return !!queue && queue.length > 0;
}

/**
 * Clear all pending interrupts for a workspace (used on discard-all or cleanup).
 */
export function clearPendingInterrupts(wsKey: string): void {
    pendingInterrupts.delete(wsKey);
}

// ---------------------------------------------------------------------------
// Bypass management
// ---------------------------------------------------------------------------

/**
 * Mark a workspace key to bypass the busy check on next dispatch.
 */
export function addBypass(wsKey: string): void {
    bypassBusyCheck.add(wsKey);
}

/**
 * Check and consume a bypass flag. Returns true if the bypass was set.
 */
export function consumeBypass(wsKey: string): boolean {
    return bypassBusyCheck.delete(wsKey);
}

/**
 * Check if a bypass is set (without consuming it).
 */
export function hasBypass(wsKey: string): boolean {
    return bypassBusyCheck.has(wsKey);
}
