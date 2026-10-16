import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as dotenv from 'dotenv';
import type { AppConfig, ExtractionMode } from './config';
import type { LogLevel } from './logger';

dotenv.config({ quiet: true });

const CONFIG_DIR_NAME = '.remoat';
const CONFIG_FILE_NAME = 'config.json';
const DEFAULT_DB_NAME = 'antigravity.db';

export interface PersistedConfig {
    telegramBotToken?: string;
    allowedUserIds?: string[];
    workspaceBaseDir?: string;
    autoApproveFileEdits?: boolean;
    logLevel?: LogLevel;
    extractionMode?: 'legacy' | 'structured';
    useTopics?: boolean;
    display?: string;
}

function getConfigDir(): string {
    return path.join(os.homedir(), CONFIG_DIR_NAME);
}

function getConfigFilePath(): string {
    return path.join(getConfigDir(), CONFIG_FILE_NAME);
}

function getDefaultDbPath(): string {
    return path.join(getConfigDir(), DEFAULT_DB_NAME);
}

function expandTilde(raw: string): string {
    if (raw === '~') return os.homedir();
    if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
    return raw;
}

function readPersistedConfig(filePath: string): PersistedConfig {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf-8');
    try {
        return JSON.parse(raw) as PersistedConfig;
    } catch {
        throw new Error(`Failed to parse config file at ${filePath}. Check for syntax errors.`);
    }
}

function mergeConfig(persisted: PersistedConfig): AppConfig {
    const token = process.env.TELEGRAM_BOT_TOKEN ?? persisted.telegramBotToken;
    if (!token) {
        throw new Error('Missing required config: TELEGRAM_BOT_TOKEN');
    }

    const allowedUserIds = resolveAllowedUserIds(persisted);
    if (allowedUserIds.length === 0) {
        throw new Error('Missing required config: ALLOWED_USER_IDS');
    }

    const defaultDir = path.join(os.homedir(), 'Code');
    const rawDir = process.env.WORKSPACE_BASE_DIR ?? persisted.workspaceBaseDir ?? defaultDir;
    const workspaceBaseDir = expandTilde(rawDir);

    const autoApproveFileEdits = resolveBoolean(
        process.env.AUTO_APPROVE_FILE_EDITS,
        persisted.autoApproveFileEdits,
        false,
    );

    const logLevel = resolveLogLevel(
        process.env.LOG_LEVEL,
        persisted.logLevel,
    );

    const extractionMode = resolveExtractionMode(
        process.env.EXTRACTION_MODE,
        persisted.extractionMode,
    );

    const display = process.env.DISPLAY ?? process.env.REMOAT_DISPLAY ?? persisted.display;

    const useTopics = resolveBoolean(
        process.env.USE_TOPICS,
        persisted.useTopics,
        true,
    );

    return {
        telegramBotToken: token,
        allowedUserIds,
        workspaceBaseDir,
        autoApproveFileEdits,
        logLevel,
        extractionMode,
        useTopics,
        ...(display ? { display } : {}),
    };
}

function resolveAllowedUserIds(persisted: PersistedConfig): string[] {
    const envValue = process.env.ALLOWED_USER_IDS;
    if (envValue) {
        return envValue
            .split(',')
            .map((id) => id.trim())
            .filter((id) => id.length > 0);
    }
    if (persisted.allowedUserIds && persisted.allowedUserIds.length > 0) {
        return [...persisted.allowedUserIds];
    }
    return [];
}

const VALID_LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error', 'none'];

function resolveLogLevel(
    envValue: string | undefined,
    persistedValue: LogLevel | undefined,
): LogLevel {
    const raw = envValue?.toLowerCase() ?? persistedValue;
    if (raw && VALID_LOG_LEVELS.includes(raw as LogLevel)) {
        return raw as LogLevel;
    }
    return 'info';
}

function resolveExtractionMode(
    envValue: string | undefined,
    persistedValue: 'legacy' | 'structured' | undefined,
): ExtractionMode {
    const raw = envValue ?? persistedValue;
    if (raw === 'legacy') return 'legacy';
    return 'structured';
}

function resolveBoolean(
    envValue: string | undefined,
    persistedValue: boolean | undefined,
    defaultValue: boolean,
): boolean {
    if (envValue !== undefined) return envValue.toLowerCase() === 'true';
    if (persistedValue !== undefined) return persistedValue;
    return defaultValue;
}

export const ConfigLoader = {
    getConfigDir,
    getConfigFilePath,
    getDefaultDbPath,

    configExists(): boolean {
        return fs.existsSync(getConfigFilePath());
    },

    load(persistedOverride?: PersistedConfig): AppConfig {
        const persisted = persistedOverride ?? readPersistedConfig(getConfigFilePath());
        return mergeConfig(persisted);
    },

    save(config: Partial<PersistedConfig>): void {
        const dir = getConfigDir();
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const existing = readPersistedConfig(getConfigFilePath());
        const merged: PersistedConfig = { ...existing, ...config };

        fs.writeFileSync(getConfigFilePath(), JSON.stringify(merged, null, 2) + '\n', 'utf-8');
    },
};
