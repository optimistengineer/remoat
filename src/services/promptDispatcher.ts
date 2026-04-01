import { ChatSessionRepository } from '../database/chatSessionRepository';
import { logger } from '../utils/logger';
import { CdpBridge, TelegramChannel } from './cdpBridgeManager';
import { CdpService } from './cdpService';
import { ModeService } from './modeService';
import { ModelService } from './modelService';
import { TitleGeneratorService } from './titleGeneratorService';
import { TelegramTopicManager } from './telegramTopicManager';
import { ChatSessionService } from './chatSessionService';
import { InboundImageAttachment } from '../utils/imageHandler';

export interface PromptDispatchOptions {
    chatSessionService: ChatSessionService;
    chatSessionRepo: ChatSessionRepository;
    topicManager: TelegramTopicManager;
    titleGenerator: TitleGeneratorService;
}

export interface PromptDispatchRequest {
    channel: TelegramChannel;
    prompt: string;
    cdp: CdpService;
    inboundImages?: InboundImageAttachment[];
    options?: PromptDispatchOptions;
}

export interface PromptDispatcherDeps {
    bridge: CdpBridge;
    modeService: ModeService;
    modelService: ModelService;
    sendPromptImpl: (
        bridge: CdpBridge,
        channel: TelegramChannel,
        prompt: string,
        cdp: CdpService,
        modeService: ModeService,
        modelService: ModelService,
        inboundImages?: InboundImageAttachment[],
        options?: PromptDispatchOptions,
    ) => Promise<void>;
    /** Called after each task completes (success or error). Used for auto-queue fallback. */
    onTaskComplete?: (channel: TelegramChannel, wsKey: string) => void;
}

export class PromptDispatcher {
    /** Per-channel lock to prevent concurrent prompt dispatch */
    private channelLocks = new Map<string, Promise<void>>();
    /** Per-workspace lock to prevent cross-topic races on the same workspace */
    private workspaceLocks = new Map<string, Promise<void>>();

    constructor(private readonly deps: PromptDispatcherDeps) { }

    private channelKey(ch: TelegramChannel): string {
        return ch.threadId ? `${ch.chatId}:${ch.threadId}` : String(ch.chatId);
    }

    /**
     * Resolve the workspace lock key for a channel + cdp pair.
     * Exposed so the interrupt state module can use the same key.
     */
    getWorkspaceKey(ch: TelegramChannel, cdp: CdpService): string {
        const wsName = cdp.getCurrentWorkspaceName();
        return wsName ? `ws:${wsName}` : this.channelKey(ch);
    }

    /**
     * Check if a workspace is currently processing a prompt.
     * Returns true when a workspace lock is held (generation in progress).
     */
    isBusy(ch: TelegramChannel, cdp: CdpService): boolean {
        const lockKey = this.getWorkspaceKey(ch, cdp);
        const busy = this.workspaceLocks.has(lockKey);
        logger.debug(`[PromptDispatcher] isBusy(${lockKey}) = ${busy} (locks: ${this.workspaceLocks.size})`);
        return busy;
    }

    async send(req: PromptDispatchRequest): Promise<void> {
        const chKey = this.channelKey(req.channel);
        const wsName = req.cdp.getCurrentWorkspaceName();
        const wsKey = wsName ? `ws:${wsName}` : null;

        // Serialize per workspace (primary) and per channel (fallback).
        // Two topics bound to the same workspace must not poll the DOM concurrently.
        const lockKey = wsKey ?? chKey;
        const previous = this.workspaceLocks.get(lockKey) ?? Promise.resolve();
        const current = previous.then(() =>
            this.deps.sendPromptImpl(
                this.deps.bridge,
                req.channel,
                req.prompt,
                req.cdp,
                this.deps.modeService,
                this.deps.modelService,
                req.inboundImages ?? [],
                req.options,
            ),
        ).catch(() => { /* errors handled inside sendPromptImpl */ });

        this.workspaceLocks.set(lockKey, current);
        logger.debug(`[PromptDispatcher] Lock ACQUIRED: ${lockKey} (total: ${this.workspaceLocks.size})`);
        // Also keep per-channel entry so callers that check channel ordering still work
        this.channelLocks.set(chKey, current);

        try {
            await current;
        } finally {
            if (this.workspaceLocks.get(lockKey) === current) {
                this.workspaceLocks.delete(lockKey);
                logger.debug(`[PromptDispatcher] Lock RELEASED: ${lockKey} (total: ${this.workspaceLocks.size})`);
            }
            if (this.channelLocks.get(chKey) === current) {
                this.channelLocks.delete(chKey);
            }
            this.deps.onTaskComplete?.(req.channel, lockKey);
        }
    }
}
