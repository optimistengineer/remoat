import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Resolves the X11 DISPLAY to use for launching GUI applications on Linux.
 *
 * Precedence:
 * 1. process.env.DISPLAY
 * 2. process.env.REMOAT_DISPLAY
 * 3. Explicit display argument / config.json value
 * 4. Auto-detected X11 display socket in /tmp/.X11-unix/ (e.g. :0, :1)
 */
export function resolveLinuxDisplay(customDisplay?: string): string | undefined {
    if (process.platform !== 'linux') {
        return undefined;
    }

    const envDisplay = process.env.DISPLAY || process.env.REMOAT_DISPLAY;
    if (envDisplay && envDisplay.trim().length > 0) {
        return envDisplay.trim();
    }

    if (customDisplay && customDisplay.trim().length > 0) {
        return customDisplay.trim();
    }

    // Auto-detect available X11 sockets
    const x11Dir = '/tmp/.X11-unix';
    try {
        if (fs.existsSync(x11Dir)) {
            const files = fs.readdirSync(x11Dir);
            const displayNumbers = files
                .filter((f) => /^X\d+$/.test(f))
                .map((f) => parseInt(f.slice(1), 10))
                .sort((a, b) => a - b);

            if (displayNumbers.length > 0) {
                return `:${displayNumbers[0]}`;
            }
        }
    } catch {
        // Silently ignore filesystem errors
    }

    return undefined;
}

/**
 * Returns environment variables needed for GUI child processes on Linux (DISPLAY, XAUTHORITY).
 */
export function getLinuxDisplayEnv(customDisplay?: string): NodeJS.ProcessEnv {
    if (process.platform !== 'linux') {
        return {};
    }

    const env: NodeJS.ProcessEnv = {};
    const display = resolveLinuxDisplay(customDisplay);
    if (display) {
        env.DISPLAY = display;
    }

    if (!process.env.XAUTHORITY) {
        const defaultXauth = path.join(os.homedir(), '.Xauthority');
        try {
            if (fs.existsSync(defaultXauth)) {
                env.XAUTHORITY = defaultXauth;
            }
        } catch {
            // Silently ignore filesystem errors
        }
    }

    return env;
}
