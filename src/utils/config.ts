import { ConfigLoader } from './configLoader';
import type { LogLevel } from './logger';

export type ExtractionMode = 'legacy' | 'structured';

export interface AppConfig {
    telegramBotToken: string;
    allowedUserIds: string[];
    workspaceBaseDir: string;
    autoApproveFileEdits: boolean;
    logLevel: LogLevel;
    extractionMode: ExtractionMode;
    useTopics: boolean;
    display?: string;
}

export type ResponseDeliveryMode = 'stream';

export function resolveResponseDeliveryMode(): ResponseDeliveryMode {
    return 'stream';
}

export function loadConfig(): AppConfig {
    return ConfigLoader.load();
}
