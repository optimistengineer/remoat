// Must mock before importing the module under test (pathUtils probes the
// filesystem at call time via fs.existsSync).
jest.mock('fs');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    extractProjectNameFromPath,
    findMacAppBundlePath,
    getAntigravityCdpHint,
    getAntigravityCliCandidates,
    getAntigravityCliPath,
    getAntigravityMacAppName,
    getMacAppBundleCandidates,
} from '../../src/utils/pathUtils';

const mockedFs = fs as jest.Mocked<typeof fs>;

// Helper to temporarily override process.platform
function withPlatform(platform: string, fn: () => void): void {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    try {
        fn();
    } finally {
        Object.defineProperty(process, 'platform', original);
    }
}

const HOME = os.homedir();

const MAC_V1_CLI = '/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity';
const MAC_V2_CLI = '/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity';
const MAC_V1_BUNDLE = '/Applications/Antigravity.app';
const MAC_V2_BUNDLE = '/Applications/Antigravity IDE.app';

const LOCALAPPDATA = 'C:\\Users\\Test User\\AppData\\Local';
const WIN_V1_EXE = `${LOCALAPPDATA}\\Programs\\Antigravity\\Antigravity.exe`;
const WIN_V2_EXE = `${LOCALAPPDATA}\\Programs\\Antigravity IDE\\Antigravity IDE.exe`;
const WIN_V2_CMD = `${LOCALAPPDATA}\\Programs\\Antigravity IDE\\bin\\antigravity.cmd`;

describe('pathUtils', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        jest.resetAllMocks();
        process.env = { ...originalEnv };
        // Every test declares its own installation state explicitly.
        delete process.env.ANTIGRAVITY_PATH;
        delete process.env.LOCALAPPDATA;
        delete process.env.ProgramFiles;
        delete process.env['ProgramFiles(x86)'];
        // Linux PATH-first resolution must not depend on the host machine's
        // real PATH; tests that exercise it set PATH explicitly.
        process.env.PATH = '/test/path-not-probed';
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    /**
     * Mark exactly the given paths as existing on disk (as executable files —
     * firstOnPath statSyncs its PATH probes). Separator-insensitive so the
     * PATH-first tests behave identically on a win32 dev host, where path.join
     * produces backslashes.
     */
    const existingPaths = (...paths: string[]) => {
        const norm = (p: unknown) => String(p).replace(/\\/g, '/');
        const known = paths.map(norm);
        mockedFs.existsSync.mockImplementation((p) => known.includes(norm(p)));
        (mockedFs.statSync as unknown as jest.Mock).mockImplementation((p: unknown) => {
            if (!known.includes(norm(p))) {
                throw Object.assign(new Error(`ENOENT: no such file: ${String(p)}`), { code: 'ENOENT' });
            }
            return { isFile: () => true, mode: 0o755 };
        });
    };

    describe('extractProjectNameFromPath()', () => {
        it('extracts name from POSIX path', () => {
            expect(extractProjectNameFromPath('/home/user/Code/MyProject')).toBe('MyProject');
        });

        it('extracts name from Windows path', () => {
            expect(extractProjectNameFromPath('D:\\Code\\MyProject')).toBe('MyProject');
        });

        it('extracts name from Windows drive root', () => {
            expect(extractProjectNameFromPath('D:\\categorizer')).toBe('categorizer');
        });

        it('handles trailing slash', () => {
            expect(extractProjectNameFromPath('/home/user/Code/MyProject/')).toBe('MyProject');
        });

        it('handles trailing backslash', () => {
            expect(extractProjectNameFromPath('C:\\Code\\MyProject\\')).toBe('MyProject');
        });

        it('handles mixed separators', () => {
            expect(extractProjectNameFromPath('C:\\Users\\test/Code/MyProject')).toBe('MyProject');
        });

        it('returns empty string for empty input', () => {
            expect(extractProjectNameFromPath('')).toBe('');
        });

        it('returns name as-is for simple name', () => {
            expect(extractProjectNameFromPath('MyProject')).toBe('MyProject');
        });

        it('extracts a space-bearing Windows executable name (v2)', () => {
            expect(extractProjectNameFromPath(WIN_V2_EXE)).toBe('Antigravity IDE.exe');
        });
    });

    // -------------------------------------------------------------------
    // getAntigravityCliCandidates()
    // -------------------------------------------------------------------
    describe('getAntigravityCliCandidates()', () => {
        it('probes the v2 macOS bundle before the v1 bundle', () => {
            withPlatform('darwin', () => {
                const candidates = getAntigravityCliCandidates();
                expect(candidates[0]).toBe(MAC_V2_CLI);
                expect(candidates[1]).toBe(MAC_V1_CLI);
                expect(candidates).toContain(`${HOME}/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity`);
                expect(candidates).toContain(`${HOME}/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity`);
            });
        });

        it('never proposes the Electron Contents/MacOS binary as a CLI candidate', () => {
            withPlatform('darwin', () => {
                for (const candidate of getAntigravityCliCandidates()) {
                    expect(candidate).not.toContain('Contents/MacOS');
                }
            });
        });

        it('omits Windows entries whose source env var is undefined', () => {
            withPlatform('win32', () => {
                process.env.LOCALAPPDATA = LOCALAPPDATA;
                const candidates = getAntigravityCliCandidates();
                expect(candidates[0]).toBe(WIN_V2_EXE);
                expect(candidates[1]).toBe(WIN_V1_EXE);
                expect(candidates.some((c) => c.includes('Program Files'))).toBe(false);
                // .cmd shims are probed last: a .cmd result forces the shell:true spawn branch.
                expect(candidates[candidates.length - 2]).toBe(WIN_V2_CMD);
                expect(candidates[candidates.length - 1]).toBe(`${LOCALAPPDATA}\\Programs\\Antigravity\\bin\\antigravity.cmd`);
            });
        });

        it('returns an empty Windows list when no env var is available', () => {
            withPlatform('win32', () => {
                expect(getAntigravityCliCandidates()).toEqual([]);
            });
        });

        it('includes ProgramFiles and ProgramFiles(x86) entries when set', () => {
            withPlatform('win32', () => {
                process.env.ProgramFiles = 'C:\\Program Files';
                process.env['ProgramFiles(x86)'] = 'C:\\Program Files (x86)';
                const candidates = getAntigravityCliCandidates();
                expect(candidates).toContain('C:\\Program Files\\Antigravity IDE\\Antigravity IDE.exe');
                expect(candidates).toContain('C:\\Program Files\\Antigravity\\Antigravity.exe');
                expect(candidates).toContain('C:\\Program Files (x86)\\Antigravity IDE\\Antigravity IDE.exe');
                expect(candidates).toContain('C:\\Program Files (x86)\\Antigravity\\Antigravity.exe');
            });
        });

        it('probes the common Linux install locations', () => {
            withPlatform('linux', () => {
                const candidates = getAntigravityCliCandidates();
                expect(candidates[0]).toBe('/usr/bin/antigravity');
                expect(candidates).toContain('/usr/bin/antigravity-ide');
                expect(candidates).toContain('/usr/local/bin/antigravity');
                expect(candidates).toContain('/opt/Antigravity/antigravity');
                expect(candidates).toContain('/snap/bin/antigravity');
            });
        });

        it('never returns a quoted candidate on any platform', () => {
            for (const platform of ['darwin', 'win32', 'linux']) {
                withPlatform(platform, () => {
                    process.env.LOCALAPPDATA = LOCALAPPDATA;
                    for (const candidate of getAntigravityCliCandidates()) {
                        expect(candidate.startsWith('"')).toBe(false);
                        expect(candidate.endsWith('"')).toBe(false);
                    }
                });
            }
        });
    });

    // -------------------------------------------------------------------
    // getAntigravityCliPath()
    // -------------------------------------------------------------------
    describe('getAntigravityCliPath()', () => {
        describe('ANTIGRAVITY_PATH override', () => {
            it.each(['darwin', 'win32', 'linux'])(
                'is returned verbatim on %s even when the file does not exist',
                (platform) => {
                    withPlatform(platform, () => {
                        process.env.ANTIGRAVITY_PATH = '/opt/custom/antigravity.AppImage';
                        mockedFs.existsSync.mockReturnValue(false);
                        expect(getAntigravityCliPath()).toBe('/opt/custom/antigravity.AppImage');
                    });
                },
            );

            it('is never existence-checked (the override is the user escape hatch)', () => {
                withPlatform('linux', () => {
                    process.env.ANTIGRAVITY_PATH = '/opt/custom/antigravity.AppImage';
                    existingPaths('/usr/bin/antigravity');
                    expect(getAntigravityCliPath()).toBe('/opt/custom/antigravity.AppImage');
                    expect(mockedFs.existsSync).not.toHaveBeenCalledWith('/opt/custom/antigravity.AppImage');
                });
            });

            it('returns a space-bearing override unquoted and unmodified', () => {
                withPlatform('win32', () => {
                    process.env.ANTIGRAVITY_PATH = WIN_V2_EXE;
                    mockedFs.existsSync.mockReturnValue(false);
                    const result = getAntigravityCliPath();
                    expect(result).toBe(WIN_V2_EXE);
                    expect(result).not.toContain('"');
                });
            });
        });

        describe('macOS resolution', () => {
            it('resolves the v2 CLI when only the v2 bundle is installed', () => {
                withPlatform('darwin', () => {
                    existingPaths(MAC_V2_CLI);
                    expect(getAntigravityCliPath()).toBe(MAC_V2_CLI);
                });
            });

            it('resolves the v1 CLI when only the v1 bundle is installed (backward compat)', () => {
                withPlatform('darwin', () => {
                    existingPaths(MAC_V1_CLI);
                    expect(getAntigravityCliPath()).toBe(MAC_V1_CLI);
                });
            });

            it('prefers v2 when both are installed', () => {
                withPlatform('darwin', () => {
                    existingPaths(MAC_V1_CLI, MAC_V2_CLI);
                    expect(getAntigravityCliPath()).toBe(MAC_V2_CLI);
                });
            });

            it('falls back to the historical v1 literal when nothing is detected', () => {
                withPlatform('darwin', () => {
                    mockedFs.existsSync.mockReturnValue(false);
                    expect(getAntigravityCliPath()).toBe(MAC_V1_CLI);
                });
            });

            it('resolves a user-local ~/Applications install', () => {
                withPlatform('darwin', () => {
                    existingPaths(`${HOME}/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity`);
                    expect(getAntigravityCliPath()).toBe(
                        `${HOME}/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity`,
                    );
                });
            });
        });

        describe('Windows resolution', () => {
            it('resolves the v2 executable when only v2 is installed', () => {
                withPlatform('win32', () => {
                    process.env.LOCALAPPDATA = LOCALAPPDATA;
                    existingPaths(WIN_V2_EXE);
                    expect(getAntigravityCliPath()).toBe(WIN_V2_EXE);
                });
            });

            it('resolves the v1 executable when only v1 is installed (backward compat)', () => {
                withPlatform('win32', () => {
                    process.env.LOCALAPPDATA = LOCALAPPDATA;
                    existingPaths(WIN_V1_EXE);
                    expect(getAntigravityCliPath()).toBe(WIN_V1_EXE);
                });
            });

            it('prefers v2 when a stale v1 directory is left behind by an in-place upgrade', () => {
                withPlatform('win32', () => {
                    process.env.LOCALAPPDATA = LOCALAPPDATA;
                    existingPaths(WIN_V1_EXE, WIN_V2_EXE);
                    expect(getAntigravityCliPath()).toBe(WIN_V2_EXE);
                });
            });

            it('returns the .cmd shim when only the CLI shim is installed', () => {
                withPlatform('win32', () => {
                    process.env.LOCALAPPDATA = LOCALAPPDATA;
                    existingPaths(WIN_V2_CMD);
                    expect(getAntigravityCliPath()).toBe(WIN_V2_CMD);
                });
            });

            it('falls back to the LOCALAPPDATA v1 literal when nothing is detected', () => {
                withPlatform('win32', () => {
                    process.env.LOCALAPPDATA = LOCALAPPDATA;
                    mockedFs.existsSync.mockReturnValue(false);
                    expect(getAntigravityCliPath()).toBe(WIN_V1_EXE);
                });
            });

            it('falls back to bare Antigravity.exe when LOCALAPPDATA is undefined', () => {
                withPlatform('win32', () => {
                    delete process.env.LOCALAPPDATA;
                    mockedFs.existsSync.mockReturnValue(false);
                    expect(getAntigravityCliPath()).toBe('Antigravity.exe');
                });
            });

            it('does not throw when existsSync raises EPERM, and falls through to the fallback', () => {
                withPlatform('win32', () => {
                    process.env.LOCALAPPDATA = LOCALAPPDATA;
                    mockedFs.existsSync.mockImplementation(() => {
                        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
                    });
                    expect(() => getAntigravityCliPath()).not.toThrow();
                    expect(getAntigravityCliPath()).toBe(WIN_V1_EXE);
                });
            });
        });

        describe('Linux resolution', () => {
            it('falls back to the bare command when nothing is detected', () => {
                withPlatform('linux', () => {
                    mockedFs.existsSync.mockReturnValue(false);
                    const result = getAntigravityCliPath();
                    expect(result).toBe('antigravity');
                    expect(result).not.toContain(' ');
                });
            });

            it('resolves /usr/bin/antigravity-ide when that is the only install', () => {
                withPlatform('linux', () => {
                    existingPaths('/usr/bin/antigravity-ide');
                    expect(getAntigravityCliPath()).toBe('/usr/bin/antigravity-ide');
                });
            });

            it('resolves the AppImage-style /opt install', () => {
                withPlatform('linux', () => {
                    existingPaths('/opt/Antigravity/antigravity');
                    expect(getAntigravityCliPath()).toBe('/opt/Antigravity/antigravity');
                });
            });

            it('prefers a PATH-resolvable bare name over the hardcoded absolute candidates', () => {
                withPlatform('linux', () => {
                    process.env.PATH = ['/home/user/.local/bin', '/usr/bin'].join(path.delimiter);
                    existingPaths('/home/user/.local/bin/antigravity', '/usr/bin/antigravity');
                    // Bare name: spawn() re-resolves it via PATH order, so the
                    // user's ~/.local/bin build keeps beating the stale /usr/bin copy.
                    expect(getAntigravityCliPath()).toBe('antigravity');
                });
            });

            it('resolves antigravity-ide via PATH when only the -ide name is installed', () => {
                withPlatform('linux', () => {
                    process.env.PATH = '/usr/bin';
                    existingPaths('/usr/bin/antigravity-ide');
                    expect(getAntigravityCliPath()).toBe('antigravity-ide');
                });
            });

            it('never applies PATH-first resolution on win32 or darwin', () => {
                for (const platform of ['win32', 'darwin']) {
                    jest.resetAllMocks();
                    withPlatform(platform, () => {
                        process.env.PATH = '/usr/bin';
                        existingPaths('/usr/bin/antigravity');
                        const result = getAntigravityCliPath();
                        expect(result).not.toBe('antigravity');
                    });
                }
            });
        });

        it('never returns a quoted path on any platform, detected or not', () => {
            const scenarios: { platform: string; existing: string[] }[] = [
                { platform: 'darwin', existing: [] },
                { platform: 'darwin', existing: [MAC_V2_CLI] },
                { platform: 'win32', existing: [] },
                { platform: 'win32', existing: [WIN_V2_EXE] },
                { platform: 'win32', existing: [WIN_V2_CMD] },
                { platform: 'linux', existing: [] },
                { platform: 'linux', existing: ['/opt/Antigravity IDE/antigravity-ide'] },
            ];

            for (const scenario of scenarios) {
                jest.resetAllMocks();
                withPlatform(scenario.platform, () => {
                    process.env.LOCALAPPDATA = LOCALAPPDATA;
                    existingPaths(...scenario.existing);
                    const result = getAntigravityCliPath();
                    expect(result.startsWith('"')).toBe(false);
                    expect(result.endsWith('"')).toBe(false);
                });
            }
        });
    });

    // -------------------------------------------------------------------
    // getMacAppBundleCandidates() / findMacAppBundlePath()
    // -------------------------------------------------------------------
    describe('getMacAppBundleCandidates()', () => {
        it('probes v2 before v1 and /Applications before ~/Applications', () => {
            expect(getMacAppBundleCandidates()).toEqual([
                MAC_V2_BUNDLE,
                MAC_V1_BUNDLE,
                `${HOME}/Applications/Antigravity IDE.app`,
                `${HOME}/Applications/Antigravity.app`,
            ]);
        });
    });

    describe('findMacAppBundlePath()', () => {
        it('returns null when nothing is installed', () => {
            mockedFs.existsSync.mockReturnValue(false);
            expect(findMacAppBundlePath()).toBeNull();
        });

        it('reports which bundle matched', () => {
            existingPaths(MAC_V1_BUNDLE);
            expect(findMacAppBundlePath()).toBe(MAC_V1_BUNDLE);
        });

        it('prefers the v2 bundle when both exist', () => {
            existingPaths(MAC_V1_BUNDLE, MAC_V2_BUNDLE);
            expect(findMacAppBundlePath()).toBe(MAC_V2_BUNDLE);
        });
    });

    // -------------------------------------------------------------------
    // getAntigravityMacAppName()
    // -------------------------------------------------------------------
    describe('getAntigravityMacAppName()', () => {
        it('defaults to "Antigravity" when no bundle is installed', () => {
            mockedFs.existsSync.mockReturnValue(false);
            expect(getAntigravityMacAppName()).toBe('Antigravity');
        });

        it('returns "Antigravity IDE" for a v2-only install', () => {
            existingPaths(MAC_V2_BUNDLE);
            expect(getAntigravityMacAppName()).toBe('Antigravity IDE');
        });

        it('returns "Antigravity" for a v1-only install (backward compat)', () => {
            existingPaths(MAC_V1_BUNDLE);
            expect(getAntigravityMacAppName()).toBe('Antigravity');
        });

        it('prefers the v2 name when both bundles exist', () => {
            existingPaths(MAC_V1_BUNDLE, MAC_V2_BUNDLE);
            expect(getAntigravityMacAppName()).toBe('Antigravity IDE');
        });

        it('resolves a ~/Applications v1 install', () => {
            existingPaths(`${HOME}/Applications/Antigravity.app`);
            expect(getAntigravityMacAppName()).toBe('Antigravity');
        });

        it('never includes the .app suffix or quote characters', () => {
            const scenarios = [[], [MAC_V1_BUNDLE], [MAC_V2_BUNDLE], [`${HOME}/Applications/Antigravity IDE.app`]];
            for (const existing of scenarios) {
                jest.resetAllMocks();
                existingPaths(...existing);
                const name = getAntigravityMacAppName();
                expect(name).not.toContain('.app');
                expect(name).not.toContain('"');
                expect(name).not.toContain("'");
                expect(name.length).toBeGreaterThan(0);
            }
        });
    });

    // -------------------------------------------------------------------
    // getAntigravityCdpHint()
    // -------------------------------------------------------------------
    describe('getAntigravityCdpHint()', () => {
        // The three assertions below are the design invariant of the conditional
        // quoteIfNeeded() helper: with nothing installed, v1 hints stay byte-identical.
        it('returns open -a hint on macOS', () => {
            withPlatform('darwin', () => {
                expect(getAntigravityCdpHint(9222)).toBe(
                    'open -a Antigravity --args --remote-debugging-port=9222',
                );
            });
        });

        it('returns exe hint on Windows', () => {
            withPlatform('win32', () => {
                expect(getAntigravityCdpHint(9222)).toBe(
                    'Antigravity.exe --remote-debugging-port=9222',
                );
            });
        });

        it('returns lowercase hint on Linux', () => {
            withPlatform('linux', () => {
                expect(getAntigravityCdpHint(9222)).toBe(
                    'antigravity --remote-debugging-port=9222',
                );
            });
        });

        it('uses default port 9222', () => {
            withPlatform('darwin', () => {
                expect(getAntigravityCdpHint()).toContain('9222');
            });
        });

        it('uses custom port', () => {
            withPlatform('darwin', () => {
                expect(getAntigravityCdpHint(9333)).toContain('9333');
            });
        });

        it('quotes the macOS app name when a v2 bundle is installed', () => {
            withPlatform('darwin', () => {
                existingPaths(MAC_V2_BUNDLE);
                // Without quotes `open -a Antigravity IDE` would pass "IDE" as a separate argument.
                expect(getAntigravityCdpHint(9222)).toBe(
                    'open -a "Antigravity IDE" --args --remote-debugging-port=9222',
                );
            });
        });

        it('leaves the macOS app name unquoted for a v1 bundle', () => {
            withPlatform('darwin', () => {
                existingPaths(MAC_V1_BUNDLE);
                expect(getAntigravityCdpHint(9222)).toBe(
                    'open -a Antigravity --args --remote-debugging-port=9222',
                );
            });
        });

        it('prints the full quoted path when a v2 install is detected on Windows', () => {
            withPlatform('win32', () => {
                process.env.LOCALAPPDATA = LOCALAPPDATA;
                existingPaths(WIN_V2_EXE);
                const hint = getAntigravityCdpHint(9222);
                // The install directory is NOT on PATH (the installer only adds
                // ...\bin), so only the full path is a runnable command.
                expect(hint).toBe(`"${WIN_V2_EXE}" --remote-debugging-port=9222`);
                expect(hint).toMatch(/^"/);
            });
        });

        it('prints the full path for a detected v1 install too (quoted: this profile path has a space)', () => {
            withPlatform('win32', () => {
                process.env.LOCALAPPDATA = LOCALAPPDATA;
                existingPaths(WIN_V1_EXE);
                const hint = getAntigravityCdpHint(9222);
                expect(hint).toBe(`"${WIN_V1_EXE}" --remote-debugging-port=9222`);
            });
        });

        it('leaves a space-free detected path unquoted', () => {
            withPlatform('win32', () => {
                process.env.LOCALAPPDATA = 'C:\\AppData\\Local';
                const exe = 'C:\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe';
                existingPaths(exe);
                expect(getAntigravityCdpHint(9222)).toBe(`${exe} --remote-debugging-port=9222`);
            });
        });

        it('keeps the bare-name form only when nothing was detected on Windows', () => {
            withPlatform('win32', () => {
                process.env.LOCALAPPDATA = LOCALAPPDATA;
                existingPaths(/* nothing */);
                // Fallback path does not exist on disk -> historical bare name.
                expect(getAntigravityCdpHint(9222)).toBe('Antigravity.exe --remote-debugging-port=9222');
            });
        });

        it('prints the full resolved path for a probed Linux install', () => {
            withPlatform('linux', () => {
                existingPaths('/usr/bin/antigravity');
                const hint = getAntigravityCdpHint(9222);
                // Guards against `APP_NAME.toLowerCase()` producing "antigravity ide ...".
                expect(hint).not.toMatch(/^\S+\s+\S+\s+--/);
                expect(hint).not.toContain('ide');
                expect(hint).toBe('/usr/bin/antigravity --remote-debugging-port=9222');
            });
        });

        it('prints the full resolved path on Linux when an -ide binary is installed', () => {
            withPlatform('linux', () => {
                existingPaths('/usr/bin/antigravity-ide');
                const hint = getAntigravityCdpHint(9222);
                expect(hint).toBe('/usr/bin/antigravity-ide --remote-debugging-port=9222');
                expect(hint).not.toMatch(/^\S+\s+\S+\s+--/);
            });
        });

        it('echoes a broken ANTIGRAVITY_PATH override verbatim in the hint', () => {
            withPlatform('linux', () => {
                process.env.ANTIGRAVITY_PATH = '/opt/custom dir/antigravity';
                existingPaths(/* nothing exists */);
                // Collapsing the override to a basename would hide the
                // misconfiguration; the user must see the exact path they set.
                expect(getAntigravityCdpHint(9222)).toBe(
                    '"/opt/custom dir/antigravity" --remote-debugging-port=9222',
                );
            });
        });

        it('keeps the bare-name hint for a PATH-resolved Linux install', () => {
            withPlatform('linux', () => {
                process.env.PATH = '/usr/bin';
                existingPaths('/usr/bin/antigravity');
                // PATH-first returns the bare name; the hint stays PATH-resolvable.
                expect(getAntigravityCdpHint(9222)).toBe('antigravity --remote-debugging-port=9222');
            });
        });
    });
});
