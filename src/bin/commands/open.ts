import * as net from 'net';
import * as os from 'os';
import { execFile, spawn } from 'child_process';
import { CDP_PORTS } from '../../utils/cdpPorts';
import { getAntigravityCliCandidates, getAntigravityCliPath, getAntigravityMacAppName } from '../../utils/pathUtils';

/** Product family name — console prose ONLY. Never derive an executable or macOS app name from this. */
const APP_DISPLAY_NAME = 'Antigravity';

/** Resolve Antigravity path from ANTIGRAVITY_PATH env var, if set. */
function getCustomPath(): string | undefined {
    return process.env.ANTIGRAVITY_PATH || undefined;
}

const C = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    red: '\x1b[31m',
} as const;

/**
 * Check whether a TCP port is available (not in use) by attempting to listen on it.
 */
function isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.once('listening', () => {
            server.close(() => resolve(true));
        });
        server.listen(port, '127.0.0.1');
    });
}

async function findAvailablePort(): Promise<number | null> {
    for (const port of CDP_PORTS) {
        if (await isPortAvailable(port)) {
            return port;
        }
    }
    return null;
}

function openMacOS(port: number): Promise<void> {
    const customPath = getCustomPath();
    return new Promise((resolve, reject) => {
        if (customPath) {
            // Use explicit path: run the binary directly
            const child = spawn(customPath, [`--remote-debugging-port=${port}`], {
                detached: true,
                stdio: 'ignore',
            });
            child.unref();
            child.on('error', (err) => {
                reject(new Error(`Failed to open ${customPath}: ${err.message}`));
            });
            setTimeout(() => resolve(), 500);
        } else {
            // Default: use macOS `open -a` to find the app in /Applications.
            // The app name is passed as a single argv element (no shell), so a
            // space in "Antigravity IDE" is already safe and must NOT be quoted.
            const appName = getAntigravityMacAppName();
            execFile('open', ['-a', appName, '--args', `--remote-debugging-port=${port}`], (err) => {
                if (!err) {
                    resolve();
                    return;
                }
                if (appName === APP_DISPLAY_NAME) {
                    reject(new Error(`Failed to open ${appName}: ${err.message}`));
                    return;
                }
                // One-shot retry with the v1 bundle name in case the probed
                // bundle is stale or not registered with LaunchServices.
                execFile('open', ['-a', APP_DISPLAY_NAME, '--args', `--remote-debugging-port=${port}`], (retryErr) => {
                    if (retryErr) {
                        reject(new Error(`Failed to open ${appName}: ${err.message}`));
                        return;
                    }
                    resolve();
                });
            });
        }
    });
}

function openWindows(port: number): Promise<void> {
    const executable = getAntigravityCliPath();
    // Node does NOT auto-quote the command under shell:true, so a path containing
    // a space (v2's "Antigravity IDE") would be word-split by cmd.exe. Prefer
    // shell:false (argv goes straight to CreateProcess, no quoting needed) and
    // only use a shell for .cmd/.bat shims, which modern Node cannot spawn directly.
    const useShell = /\.(cmd|bat)$/i.test(executable);
    const command = useShell ? `"${executable}"` : executable;
    const args = useShell ? [`"--remote-debugging-port=${port}"`] : [`--remote-debugging-port=${port}`];
    return new Promise((resolve, reject) => {
        try {
            const child = spawn(command, args, {
                detached: true,
                stdio: 'ignore',
                shell: useShell,
            });
            child.unref();
            child.on('error', (err) => {
                reject(new Error(`Failed to open "${executable}": ${err.message}`));
            });
            setTimeout(() => resolve(), 500);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            reject(new Error(`Failed to open "${executable}": ${msg}`));
        }
    });
}

function openLinux(port: number): Promise<void> {
    // getAntigravityCliPath() already honours ANTIGRAVITY_PATH, prefers a
    // PATH-resolvable bare name (so PATH order keeps winning), and only then
    // probes the common absolute install locations.
    const executable = getAntigravityCliPath();
    return new Promise((resolve, reject) => {
        try {
            const child = spawn(executable, [`--remote-debugging-port=${port}`], {
                detached: true,
                stdio: 'ignore',
            });
            child.unref();
            child.on('error', (err) => {
                reject(new Error(`Failed to open ${executable}: ${err.message}`));
            });
            // Give it a moment to detect spawn errors
            setTimeout(() => resolve(), 500);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            reject(new Error(`Failed to open ${executable}: ${msg}`));
        }
    });
}

export async function openAction(): Promise<void> {
    const platform = os.platform();

    console.log(`\n  ${C.cyan}Searching for an available CDP port...${C.reset}`);

    const port = await findAvailablePort();
    if (port === null) {
        console.log(`  ${C.red}No available CDP ports found.${C.reset}`);
        console.log(`  ${C.dim}All candidate ports are in use: ${CDP_PORTS.join(', ')}${C.reset}`);
        console.log(`  ${C.dim}Close an application using one of these ports and try again.${C.reset}\n`);
        process.exitCode = 1;
        return;
    }

    console.log(`  ${C.green}Found available port: ${port}${C.reset}`);
    console.log(`  ${C.dim}Opening ${APP_DISPLAY_NAME} with --remote-debugging-port=${port}...${C.reset}\n`);

    try {
        if (platform === 'darwin') {
            await openMacOS(port);
        } else if (platform === 'win32') {
            await openWindows(port);
        } else {
            await openLinux(port);
        }

        console.log(`  ${C.green}${APP_DISPLAY_NAME} opened on CDP port ${port}${C.reset}`);
        console.log(`  ${C.dim}Run ${C.reset}${C.cyan}remoat start${C.reset}${C.dim} to connect the bot.${C.reset}\n`);
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.log(`  ${C.red}${msg}${C.reset}`);
        console.log(`  ${C.dim}Make sure ${APP_DISPLAY_NAME} is installed on your system.${C.reset}`);
        if (platform === 'darwin') {
            console.log(`  ${C.dim}/Applications/Antigravity.app or "/Applications/Antigravity IDE.app" must exist, or set ANTIGRAVITY_PATH in your .env file.${C.reset}`);
        } else if (platform === 'linux') {
            console.log(`  ${C.dim}Set ANTIGRAVITY_PATH in your .env file (e.g. /opt/applications/antigravity.AppImage).${C.reset}`);
        } else {
            console.log(`  ${C.dim}Tried "${getAntigravityCliPath()}". Set ANTIGRAVITY_PATH in your .env file.${C.reset}`);
            for (const candidate of getAntigravityCliCandidates()) {
                console.log(`  ${C.dim}  probed: "${candidate}"${C.reset}`);
            }
        }
        console.log('');
        process.exitCode = 1;
    }
}
