// Must mock before importing: openAction resolves the Antigravity executable
// through pathUtils, which probes the filesystem via fs.existsSync.
jest.mock('fs');
jest.mock('net');
jest.mock('child_process');

import * as fs from 'fs';
import * as net from 'net';
import * as child_process from 'child_process';
import { EventEmitter } from 'events';
import { openAction } from '../../src/bin/commands/open';

const mockedFs = fs as jest.Mocked<typeof fs>;
const mockedSpawn = child_process.spawn as unknown as jest.Mock;
const mockedExecFile = child_process.execFile as unknown as jest.Mock;
const mockedCreateServer = net.createServer as unknown as jest.Mock;

/**
 * Mark exactly the given paths as existing on disk (as executable files —
 * firstOnPath statSyncs its PATH probes). Separator-insensitive so the Linux
 * PATH-first test behaves identically on a win32 dev host.
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

const LOCALAPPDATA = 'C:\\Users\\Test User\\AppData\\Local';
const WIN_V2_EXE = `${LOCALAPPDATA}\\Programs\\Antigravity IDE\\Antigravity IDE.exe`;
const WIN_V1_EXE = `${LOCALAPPDATA}\\Programs\\Antigravity\\Antigravity.exe`;
const WIN_V2_CMD = `${LOCALAPPDATA}\\Programs\\Antigravity IDE\\bin\\antigravity.cmd`;

describe('remoat open', () => {
    const originalEnv = process.env;
    let originalPlatform: PropertyDescriptor;
    let originalOsPlatform: jest.SpyInstance;

    const setPlatform = (platform: NodeJS.Platform) => {
        Object.defineProperty(process, 'platform', { value: platform, configurable: true });
        // openAction() branches on os.platform(), openWindows/openLinux on the
        // resolver's process.platform — keep both in sync.
        originalOsPlatform.mockReturnValue(platform);
    };

    beforeEach(() => {
        jest.resetAllMocks();
        originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        originalOsPlatform = jest.spyOn(require('os'), 'platform');

        process.env = { ...originalEnv };
        delete process.env.ANTIGRAVITY_PATH;
        delete process.env.LOCALAPPDATA;
        delete process.env.ProgramFiles;
        delete process.env['ProgramFiles(x86)'];
        // Linux PATH-first resolution must not depend on the host's real PATH;
        // tests that exercise it set PATH explicitly.
        process.env.PATH = '/test/path-not-probed';
        process.exitCode = undefined;

        mockedFs.existsSync.mockReturnValue(false);

        // Every CDP port reports as available -> port 9222 is chosen.
        mockedCreateServer.mockImplementation(() => {
            const server = new EventEmitter() as EventEmitter & {
                listen: (...a: unknown[]) => void;
                close: (cb: () => void) => void;
            };
            server.listen = () => setImmediate(() => server.emit('listening'));
            server.close = (cb: () => void) => cb();
            return server;
        });

        mockedSpawn.mockImplementation(() => {
            const child = new EventEmitter() as EventEmitter & { unref: () => void };
            child.unref = () => undefined;
            return child;
        });

        mockedExecFile.mockImplementation((_cmd: string, _args: string[], cb: (e: Error | null) => void) => {
            setImmediate(() => cb(null));
            return new EventEmitter();
        });

        jest.spyOn(console, 'log').mockImplementation(() => undefined);
    });

    afterEach(() => {
        Object.defineProperty(process, 'platform', originalPlatform);
        process.env = originalEnv;
        process.exitCode = undefined;
        jest.restoreAllMocks();
    });

    describe('Windows', () => {
        it('spawns a space-bearing v2 .exe with shell:false and no quoting', async () => {
            setPlatform('win32');
            process.env.LOCALAPPDATA = LOCALAPPDATA;
            existingPaths(WIN_V2_EXE);

            await openAction();

            expect(mockedSpawn).toHaveBeenCalledTimes(1);
            const [command, args, options] = mockedSpawn.mock.calls[0];
            expect(command).toBe(WIN_V2_EXE);
            expect(command).not.toContain('"');
            expect(options.shell).toBe(false);
            expect(args).toEqual(['--remote-debugging-port=9222']);
        });

        it('keeps working for a v1 install (backward compat)', async () => {
            setPlatform('win32');
            process.env.LOCALAPPDATA = LOCALAPPDATA;
            existingPaths(WIN_V1_EXE);

            await openAction();

            const [command, , options] = mockedSpawn.mock.calls[0];
            expect(command).toBe(WIN_V1_EXE);
            expect(options.shell).toBe(false);
        });

        it('uses shell:true with a quoted command for a .cmd shim', async () => {
            setPlatform('win32');
            process.env.LOCALAPPDATA = LOCALAPPDATA;
            existingPaths(WIN_V2_CMD);

            await openAction();

            const [command, args, options] = mockedSpawn.mock.calls[0];
            expect(options.shell).toBe(true);
            expect(command).toBe(`"${WIN_V2_CMD}"`);
            expect(args).toEqual(['"--remote-debugging-port=9222"']);
        });

        it('honours ANTIGRAVITY_PATH', async () => {
            setPlatform('win32');
            process.env.ANTIGRAVITY_PATH = 'D:\\Custom Tools\\Antigravity IDE.exe';

            await openAction();

            const [command, , options] = mockedSpawn.mock.calls[0];
            expect(command).toBe('D:\\Custom Tools\\Antigravity IDE.exe');
            expect(options.shell).toBe(false);
        });
    });

    describe('Linux', () => {
        it('spawns exactly "antigravity" when nothing is detected', async () => {
            setPlatform('linux');

            await openAction();

            const [command, args, options] = mockedSpawn.mock.calls[0];
            // Guards the APP_NAME.toLowerCase() trap that would yield "antigravity ide".
            expect(command).toBe('antigravity');
            expect(command).not.toContain(' ');
            expect(args).toEqual(['--remote-debugging-port=9222']);
            expect(options.shell).toBeUndefined();
        });

        it('spawns the detected binary when one is installed', async () => {
            setPlatform('linux');
            existingPaths('/usr/bin/antigravity-ide');

            await openAction();

            expect(mockedSpawn.mock.calls[0][0]).toBe('/usr/bin/antigravity-ide');
        });

        it('spawns the bare name when it is PATH-resolvable, so PATH order keeps winning', async () => {
            setPlatform('linux');
            process.env.PATH = '/usr/bin';
            existingPaths('/usr/bin/antigravity');

            await openAction();

            expect(mockedSpawn.mock.calls[0][0]).toBe('antigravity');
        });

        it('honours ANTIGRAVITY_PATH', async () => {
            setPlatform('linux');
            process.env.ANTIGRAVITY_PATH = '/opt/custom/antigravity.AppImage';

            await openAction();

            expect(mockedSpawn.mock.calls[0][0]).toBe('/opt/custom/antigravity.AppImage');
        });
    });

    describe('macOS', () => {
        it('uses execFile with an unquoted app name for a v1 install', async () => {
            setPlatform('darwin');
            existingPaths('/Applications/Antigravity.app');

            await openAction();

            expect(mockedExecFile).toHaveBeenCalledTimes(1);
            const [command, args] = mockedExecFile.mock.calls[0];
            expect(command).toBe('open');
            expect(args).toEqual(['-a', 'Antigravity', '--args', '--remote-debugging-port=9222']);
        });

        it('passes "Antigravity IDE" as a single unquoted argv element for a v2-only bundle', async () => {
            setPlatform('darwin');
            existingPaths('/Applications/Antigravity IDE.app');

            await openAction();

            const [, args] = mockedExecFile.mock.calls[0];
            expect(args).toEqual(['-a', 'Antigravity IDE', '--args', '--remote-debugging-port=9222']);
            expect(args[1]).toBe('Antigravity IDE');
            expect(args[1]).not.toContain('"');
        });

        it('retries once with the v1 bundle name when the v2 name fails', async () => {
            setPlatform('darwin');
            existingPaths('/Applications/Antigravity IDE.app');
            mockedExecFile
                .mockImplementationOnce((_c: string, _a: string[], cb: (e: Error | null) => void) => {
                    setImmediate(() => cb(new Error('Unable to find application')));
                    return new EventEmitter();
                })
                .mockImplementationOnce((_c: string, _a: string[], cb: (e: Error | null) => void) => {
                    setImmediate(() => cb(null));
                    return new EventEmitter();
                });

            await openAction();

            expect(mockedExecFile).toHaveBeenCalledTimes(2);
            expect(mockedExecFile.mock.calls[1][1]).toEqual([
                '-a', 'Antigravity', '--args', '--remote-debugging-port=9222',
            ]);
            expect(process.exitCode).toBeUndefined();
        });

        it('honours ANTIGRAVITY_PATH by spawning the binary directly (no shell)', async () => {
            setPlatform('darwin');
            process.env.ANTIGRAVITY_PATH = '/Applications/Antigravity IDE.app/Contents/MacOS/Antigravity IDE';

            await openAction();

            expect(mockedExecFile).not.toHaveBeenCalled();
            const [command, args, options] = mockedSpawn.mock.calls[0];
            expect(command).toBe('/Applications/Antigravity IDE.app/Contents/MacOS/Antigravity IDE');
            expect(args).toEqual(['--remote-debugging-port=9222']);
            expect(options.shell).toBeUndefined();
        });
    });
});
