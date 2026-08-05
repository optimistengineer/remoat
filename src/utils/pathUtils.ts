import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Return the first candidate that exists on disk, or null when none do.
 *
 * `fs.existsSync` can throw on exotic filesystem errors (EPERM, ELOOP), so each
 * probe is guarded individually and a failure simply moves on to the next entry.
 */
function firstExisting(candidates: string[]): string | null {
    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        } catch {
            // Ignore EPERM/ELOOP and keep probing
        }
    }
    return null;
}

/**
 * Return the first command name resolvable via the PATH environment variable,
 * or null when none of them are.
 *
 * The bare name (not the resolved absolute path) is returned on purpose:
 * spawn() then resolves it through PATH order at launch time, so a binary the
 * user installed earlier on PATH keeps beating a stale system copy.
 */
function firstOnPath(commands: string[]): string | null {
    const pathValue = process.env.PATH;
    if (!pathValue) {
        return null;
    }
    const dirs = pathValue.split(path.delimiter).filter(Boolean);
    for (const command of commands) {
        for (const dir of dirs) {
            try {
                // A PATH hit must be an executable regular file — a stray
                // directory or data file named 'antigravity' must not win over
                // a real install in the absolute-candidate list.
                const stat = fs.statSync(path.join(dir, command));
                if (stat.isFile() && (stat.mode & 0o111) !== 0) {
                    return command;
                }
            } catch {
                // ENOENT/EPERM/ELOOP — keep probing
            }
        }
    }
    return null;
}

/**
 * Wrap a token in double quotes only when it contains whitespace.
 *
 * Antigravity v2 renamed the Windows install folder and executable to
 * "Antigravity IDE", which introduces a space. Quoting conditionally keeps the
 * v1 hints byte-identical while making the v2 hints copy-pasteable.
 */
function quoteIfNeeded(token: string): string {
    return /\s/.test(token) ? `"${token}"` : token;
}

/**
 * Ordered list of Antigravity CLI executables to probe on the current platform.
 *
 * Antigravity v2 paths come first so that an in-place upgrade which leaves a
 * stale v1 directory behind still resolves to the install the user actually
 * runs. The ANTIGRAVITY_PATH override and the last-resort fallback are
 * deliberately NOT part of this list — see {@link getAntigravityCliPath}.
 *
 * @returns Candidate paths, most preferred first (never quoted)
 */
export function getAntigravityCliCandidates(): string[] {
    if (process.platform === 'darwin') {
        const home = os.homedir();
        return [
            '/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity',
            '/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity',
            `${home}/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity`,
            `${home}/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity`,
        ];
    }

    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA;
        const programFiles = process.env.ProgramFiles;
        const programFilesX86 = process.env['ProgramFiles(x86)'];

        const candidates: string[] = [];
        if (localAppData) {
            candidates.push(`${localAppData}\\Programs\\Antigravity IDE\\Antigravity IDE.exe`);
            candidates.push(`${localAppData}\\Programs\\Antigravity\\Antigravity.exe`);
        }
        if (programFiles) {
            candidates.push(`${programFiles}\\Antigravity IDE\\Antigravity IDE.exe`);
            candidates.push(`${programFiles}\\Antigravity\\Antigravity.exe`);
        }
        if (programFilesX86) {
            candidates.push(`${programFilesX86}\\Antigravity IDE\\Antigravity IDE.exe`);
            candidates.push(`${programFilesX86}\\Antigravity\\Antigravity.exe`);
        }
        if (localAppData) {
            // VS Code-style CLI shims last: a .cmd forces the shell:true spawn
            // branch, whereas the .exe is the proven path.
            candidates.push(`${localAppData}\\Programs\\Antigravity IDE\\bin\\antigravity.cmd`);
            candidates.push(`${localAppData}\\Programs\\Antigravity\\bin\\antigravity.cmd`);
        }
        return candidates;
    }

    // Linux or any unknown OS
    return [
        '/usr/bin/antigravity',
        '/usr/bin/antigravity-ide',
        '/usr/local/bin/antigravity',
        '/usr/local/bin/antigravity-ide',
        '/opt/Antigravity/antigravity',
        '/opt/Antigravity IDE/antigravity-ide',
        '/snap/bin/antigravity',
    ];
}

/**
 * Helper to resolve the correct Antigravity CLI executable path based on the operating system
 * and environment variables.
 *
 * Precedence:
 * 1. process.env.ANTIGRAVITY_PATH (Explicit override — never existence-checked)
 * 2. Linux only: a bare command name resolvable via PATH ('antigravity',
 *    'antigravity-ide') — kept ahead of the absolute probes so a binary the
 *    user put earlier on PATH beats a stale copy in /usr/bin
 * 3. The first entry of {@link getAntigravityCliCandidates} that exists on disk
 * 4. OS-specific default paths (Mac: /Applications/..., Windows: %LOCALAPPDATA%\..., Linux: 'antigravity')
 *
 * The value is always returned raw and unquoted — quoting is the responsibility
 * of the (single) spawn site that actually uses a shell.
 */
export function getAntigravityCliPath(): string {
    // Allow user to set explicit path via ANTIGRAVITY_PATH (especially useful for Linux AppImages)
    if (process.env.ANTIGRAVITY_PATH) {
        return process.env.ANTIGRAVITY_PATH;
    }

    if (process.platform !== 'darwin' && process.platform !== 'win32') {
        const onPath = firstOnPath(['antigravity', 'antigravity-ide']);
        if (onPath) {
            return onPath;
        }
    }

    const hit = firstExisting(getAntigravityCliCandidates());
    if (hit) {
        return hit;
    }

    // Nothing detected: fall back to the historical defaults so behaviour is
    // unchanged for anyone whose install we cannot see.
    if (process.platform === 'darwin') {
        return '/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity';
    }

    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA;
        if (localAppData) {
            return `${localAppData}\\Programs\\Antigravity\\Antigravity.exe`;
        }
        return 'Antigravity.exe'; // Fallback if LOCALAPPDATA is undefined
    }

    // Default for Linux or any unknown OS, assuming 'antigravity' is in the system PATH
    return 'antigravity';
}

/**
 * Ordered list of macOS application bundles to probe, v2 name first.
 *
 * @returns Absolute `.app` bundle paths, most preferred first
 */
export function getMacAppBundleCandidates(): string[] {
    const home = os.homedir();
    return [
        '/Applications/Antigravity IDE.app',
        '/Applications/Antigravity.app',
        `${home}/Applications/Antigravity IDE.app`,
        `${home}/Applications/Antigravity.app`,
    ];
}

/**
 * Locate the installed macOS Antigravity application bundle.
 *
 * @returns Absolute path to the `.app` bundle, or null when none is installed
 */
export function findMacAppBundlePath(): string | null {
    return firstExisting(getMacAppBundleCandidates());
}

/**
 * Resolve the macOS application name to pass to `open -a`.
 *
 * The result has no `.app` suffix and is never quoted — callers must pass it as
 * a single argv element to `execFile`/`spawn` (shell: false), where a space in
 * the name is already safe.
 *
 * @returns The bundle display name, defaulting to 'Antigravity' when not installed
 */
export function getAntigravityMacAppName(): string {
    const bundle = findMacAppBundlePath();
    if (!bundle) {
        return 'Antigravity';
    }
    const name = extractProjectNameFromPath(bundle).replace(/\.app$/, '');
    return name || 'Antigravity';
}

/**
 * Helper to extract the project name from a full workspace path.
 * Handles both Windows (backslash) and POSIX (forward slash) paths.
 *
 * @param workspacePath The full path to the workspace directory
 * @returns The final folder name
 */
export function extractProjectNameFromPath(workspacePath: string): string {
    return workspacePath.split(/[/\\]/).filter(Boolean).pop() || '';
}

/**
 * Get a platform-appropriate hint for starting Antigravity with CDP.
 *
 * Used in user-facing messages (Telegram messages, CLI doctor, logs).
 */
export function getAntigravityCdpHint(port: number = 9222): string {
    switch (process.platform) {
        case 'darwin':
            return `open -a ${quoteIfNeeded(getAntigravityMacAppName())} --args --remote-debugging-port=${port}`;
        default: {
            const cli = getAntigravityCliPath();
            // An explicit ANTIGRAVITY_PATH override is always echoed verbatim,
            // even when broken — collapsing it to a basename would hide the
            // misconfiguration from the user. A probed hit is an absolute path
            // to a real install whose directory is typically NOT on PATH (the
            // Windows installer only adds ...\bin), so only the full path yields
            // a copy-pasteable command. When nothing was detected, keep the
            // historical bare-name form — resolved via PATH — using
            // extractProjectNameFromPath (not path.basename) so a Windows
            // fallback still splits correctly on a POSIX host.
            const target = (process.env.ANTIGRAVITY_PATH || firstExisting([cli]))
                ? cli
                : extractProjectNameFromPath(cli);
            return `${quoteIfNeeded(target)} --remote-debugging-port=${port}`;
        }
    }
}
