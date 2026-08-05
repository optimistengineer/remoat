// Must mock before importing: doctorAction probes the filesystem for the
// Antigravity app bundle / executable, and hits every CDP port over HTTP.
jest.mock('fs');
jest.mock('http');
jest.mock('child_process');

import * as fs from 'fs';
import * as http from 'http';
import { EventEmitter } from 'events';
import { doctorAction } from '../../src/bin/commands/doctor';

const mockedFs = fs as jest.Mocked<typeof fs>;
const mockedHttpGet = http.get as unknown as jest.Mock;

/** Mark exactly the given paths as existing on disk. */
const existingPaths = (...paths: string[]) =>
    mockedFs.existsSync.mockImplementation((p) => paths.includes(String(p)));

const LOCALAPPDATA = 'C:\\Users\\Test User\\AppData\\Local';

describe('remoat doctor', () => {
    const originalEnv = process.env;
    let originalPlatform: PropertyDescriptor;
    let osPlatformSpy: jest.SpyInstance;
    let logLines: string[];

    const setPlatform = (platform: NodeJS.Platform) => {
        Object.defineProperty(process, 'platform', { value: platform, configurable: true });
        osPlatformSpy.mockReturnValue(platform);
    };

    const output = () => logLines.join('\n');

    beforeEach(() => {
        jest.resetAllMocks();
        originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        osPlatformSpy = jest.spyOn(require('os'), 'platform');

        process.env = { ...originalEnv };
        delete process.env.ANTIGRAVITY_PATH;
        delete process.env.LOCALAPPDATA;
        delete process.env.ProgramFiles;
        delete process.env['ProgramFiles(x86)'];
        // Linux PATH-first resolution must not depend on the host's real PATH.
        process.env.PATH = '/test/path-not-probed';
        process.env.TELEGRAM_BOT_TOKEN = 'test-token';
        process.env.ALLOWED_USER_IDS = '1';
        process.exitCode = undefined;

        mockedFs.existsSync.mockReturnValue(false);

        // No CDP port responds; fail fast instead of waiting on the 2s timeouts.
        mockedHttpGet.mockImplementation(() => {
            const req = new EventEmitter() as EventEmitter & {
                setTimeout: (ms: number, cb: () => void) => void;
                destroy: () => void;
            };
            req.setTimeout = () => undefined;
            req.destroy = () => undefined;
            setImmediate(() => req.emit('error', new Error('ECONNREFUSED')));
            return req;
        });

        logLines = [];
        jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
            logLines.push(args.map(String).join(' '));
        });
    });

    afterEach(() => {
        Object.defineProperty(process, 'platform', originalPlatform);
        process.env = originalEnv;
        process.exitCode = undefined;
        jest.restoreAllMocks();
    });

    describe('macOS application bundle check', () => {
        it('reports the v2 bundle by name when only "Antigravity IDE.app" is installed', async () => {
            setPlatform('darwin');
            existingPaths('/Applications/Antigravity IDE.app');

            await doctorAction();

            expect(output()).toContain('Antigravity IDE.app found: /Applications/Antigravity IDE.app');
            expect(output()).not.toContain('not found in /Applications');
        });

        it('still reports found for a v1-only install (backward compat)', async () => {
            setPlatform('darwin');
            existingPaths('/Applications/Antigravity.app');

            await doctorAction();

            expect(output()).toContain('Antigravity.app found: /Applications/Antigravity.app');
            expect(output()).not.toContain('not found in /Applications');
        });

        it('warns about BOTH product names when neither bundle exists', async () => {
            setPlatform('darwin');
            mockedFs.existsSync.mockReturnValue(false);

            await doctorAction();

            expect(output()).toContain('Antigravity.app');
            expect(output()).toContain('Antigravity IDE.app');
            expect(output()).toContain('not found in /Applications');
        });

        it('fails loudly when ANTIGRAVITY_PATH is set but does not exist', async () => {
            setPlatform('darwin');
            process.env.ANTIGRAVITY_PATH = '/nope/Antigravity IDE.app';
            mockedFs.existsSync.mockReturnValue(false);

            await doctorAction();

            expect(output()).toContain('ANTIGRAVITY_PATH set but not found: /nope/Antigravity IDE.app');
            expect(process.exitCode).toBe(1);
        });

        it('accepts an existing ANTIGRAVITY_PATH', async () => {
            setPlatform('darwin');
            process.env.ANTIGRAVITY_PATH = '/Applications/Antigravity IDE.app';
            existingPaths('/Applications/Antigravity IDE.app');

            await doctorAction();

            expect(output()).toContain('Antigravity found: /Applications/Antigravity IDE.app');
        });
    });

    describe('resolved executable check (all platforms)', () => {
        it('prints the probed candidate list on Windows when nothing resolves', async () => {
            setPlatform('win32');
            process.env.LOCALAPPDATA = LOCALAPPDATA;
            mockedFs.existsSync.mockReturnValue(false);

            await doctorAction();

            const text = output();
            expect(text).toContain('Antigravity executable not found');
            expect(text).toContain(`${LOCALAPPDATA}\\Programs\\Antigravity IDE\\Antigravity IDE.exe`);
            expect(text).toContain(`${LOCALAPPDATA}\\Programs\\Antigravity\\Antigravity.exe`);
            expect(text).toContain(`${LOCALAPPDATA}\\Programs\\Antigravity IDE\\bin\\antigravity.cmd`);
        });

        it('reports the resolved v2 executable on Windows', async () => {
            setPlatform('win32');
            process.env.LOCALAPPDATA = LOCALAPPDATA;
            const v2Exe = `${LOCALAPPDATA}\\Programs\\Antigravity IDE\\Antigravity IDE.exe`;
            existingPaths(v2Exe);

            await doctorAction();

            expect(output()).toContain(`Antigravity executable resolved: ${v2Exe}`);
        });

        it('reports the resolved binary on Linux', async () => {
            setPlatform('linux');
            existingPaths('/usr/bin/antigravity');

            await doctorAction();

            expect(output()).toContain('Antigravity executable resolved: /usr/bin/antigravity');
        });

        it('does NOT warn about a missing executable on a working macOS install', async () => {
            // Antigravity ships app.asar: Contents/Resources/app/bin/antigravity does
            // not exist even on a healthy install, so probing it on darwin would
            // contradict the bundle check two lines above and push the user toward
            // setting ANTIGRAVITY_PATH — which breaks the `open -a` launcher.
            setPlatform('darwin');
            existingPaths('/Applications/Antigravity.app');

            await doctorAction();

            expect(output()).toContain('Antigravity.app found: /Applications/Antigravity.app');
            expect(output()).not.toContain('Antigravity executable not found');
            expect(output()).not.toContain('Probed the following paths');
        });

        it('does NOT warn on macOS when no bundle is installed either (check 6 owns that)', async () => {
            setPlatform('darwin');
            mockedFs.existsSync.mockReturnValue(false);

            await doctorAction();

            expect(output()).toContain('not found in /Applications');
            expect(output()).not.toContain('Antigravity executable not found');
        });

        it('does NOT warn on Linux when the resolved value is a bare PATH command', async () => {
            // 'antigravity' has no path separator: it is resolved through PATH at
            // spawn time, and existsSync() would evaluate it against process.cwd().
            setPlatform('linux');
            mockedFs.existsSync.mockReturnValue(false);

            await doctorAction();

            expect(output()).not.toContain('Antigravity executable not found');
        });

        it('does NOT warn on Windows when LOCALAPPDATA is unset and the fallback is a bare exe name', async () => {
            setPlatform('win32');
            delete process.env.LOCALAPPDATA;
            mockedFs.existsSync.mockReturnValue(false);

            await doctorAction();

            expect(output()).not.toContain('Antigravity executable not found');
        });

        it('suggests the v2-aware CDP hint when no port responds', async () => {
            setPlatform('darwin');
            existingPaths('/Applications/Antigravity IDE.app');

            await doctorAction();

            expect(output()).toContain('open -a "Antigravity IDE" --args --remote-debugging-port=9222');
        });
    });
});
