import { ChatSessionRepository } from '../database/chatSessionRepository';
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
    /** Called when a prompt is queued behind an active one. Lets the user know their message is waiting. */
    notifyQueued?: (channel: TelegramChannel, prompt: string) => void;
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

    async send(req: PromptDispatchRequest): Promise<void> {
        const chKey = this.channelKey(req.channel);
        const wsName = req.cdp.getCurrentWorkspaceName();
        const wsKey = wsName ? `ws:${wsName}` : null;

        // Serialize per workspace (primary) and per channel (fallback).
        // Two topics bound to the same workspace must not poll the DOM concurrently.
        const lockKey = wsKey ?? chKey;
        const previous = this.workspaceLocks.get(lockKey);
        if (previous !== undefined) {
            // Something is already running for this workspace/channel — notify the user.
            this.deps.notifyQueued?.(req.channel, req.prompt);
        }
        const current = (previous ?? Promise.resolve()).then(() =>
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
        // Also keep per-channel entry so callers that check channel ordering still work
        this.channelLocks.set(chKey, current);

        try {
            await current;
        } finally {
            if (this.workspaceLocks.get(lockKey) === current) {
                this.workspaceLocks.delete(lockKey);
            }
            if (this.channelLocks.get(chKey) === current) {
                this.channelLocks.delete(chKey);
            }
        }
    }
}
