import { CdpService } from '../../src/services/cdpService';
import * as child_process from 'child_process';
import { EventEmitter } from 'events';

// Mock logger to avoid printing during tests
jest.mock('../../src/utils/logger', () => ({
    logger: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    },
}));

jest.mock('child_process');

const mockedSpawn = child_process.spawn as unknown as jest.Mock;

/**
 * Regression guard for CdpService.runCommand()'s spawn options.
 *
 * Everywhere else in the suite runCommand is stubbed out
 * (cdpService.workspace.test.ts spies on it), so the real spawn options — the
 * single highest-risk part of the Antigravity v2 change — would otherwise have
 * zero coverage. Getting `shell` wrong on Windows word-splits both the
 * executable path ("Antigravity IDE.exe") and the workspace path
 * ("C:\My Projects\App").
 */
describe('CdpService - runCommand spawn options', () => {
    let service: CdpService;
    let originalPlatform: PropertyDescriptor;

    const setPlatform = (platform: NodeJS.Platform) => {
        Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    };

    beforeEach(() => {
        originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        service = new CdpService({ portsToScan: [9999], maxReconnectAttempts: 0 });

        mockedSpawn.mockImplementation(() => {
            const child = new EventEmitter();
            // Resolve runCommand's promise on the next tick with a success code.
            setImmediate(() => child.emit('close', 0));
            return child;
        });
    });

    afterEach(() => {
        Object.defineProperty(process, 'platform', originalPlatform);
        jest.resetAllMocks();
    });

    const run = (command: string, args: string[]) =>
        (service as unknown as { runCommand(c: string, a: string[]): Promise<void> }).runCommand(command, args);

    describe('Windows', () => {
        const V2_EXE = 'C:\\Users\\Test User\\AppData\\Local\\Programs\\Antigravity IDE\\Antigravity IDE.exe';

        it('spawns a space-bearing .exe with shell:false and no quoting', async () => {
            setPlatform('win32');

            await run(V2_EXE, ['--remote-debugging-port=9999']);

            expect(mockedSpawn).toHaveBeenCalledTimes(1);
            const [command, args, options] = mockedSpawn.mock.calls[0];
            expect(command).toBe(V2_EXE);
            expect(command).not.toContain('"');
            expect(options.shell).toBe(false);
            expect(args).toEqual(['--remote-debugging-port=9999']);
        });

        it('passes a space-bearing workspace path as one unmodified argv element', async () => {
            setPlatform('win32');
            const workspacePath = 'C:\\My Projects\\App';

            await run(V2_EXE, ['--remote-debugging-port=9999', '--new-window', workspacePath]);

            const [, args, options] = mockedSpawn.mock.calls[0];
            expect(options.shell).toBe(false);
            expect(args).toEqual(['--remote-debugging-port=9999', '--new-window', workspacePath]);
            expect(args[2]).toBe(workspacePath);
            expect(args[2]).not.toContain('"');
        });

        it('uses shell:true with every token quoted for a .cmd shim', async () => {
            setPlatform('win32');
            const cmdShim = 'C:\\Users\\Test User\\AppData\\Local\\Programs\\Antigravity IDE\\bin\\antigravity.cmd';

            await run(cmdShim, ['--remote-debugging-port=9999', 'C:\\My Projects\\App']);

            const [command, args, options] = mockedSpawn.mock.calls[0];
            expect(options.shell).toBe(true);
            expect(command).toBe(`"${cmdShim}"`);
            expect(args).toEqual(['"--remote-debugging-port=9999"', '"C:\\My Projects\\App"']);
        });

        it('treats .bat shims the same as .cmd shims', async () => {
            setPlatform('win32');

            await run('C:\\tools\\antigravity.BAT', ['--flag']);

            const [command, args, options] = mockedSpawn.mock.calls[0];
            expect(options.shell).toBe(true);
            expect(command).toBe('"C:\\tools\\antigravity.BAT"');
            expect(args).toEqual(['"--flag"']);
        });
    });

    describe('POSIX', () => {
        it('never uses a shell on darwin and passes the executable unquoted', async () => {
            setPlatform('darwin');

            await run('open', ['-a', 'Antigravity IDE', '--args', '--remote-debugging-port=9999']);

            const [command, args, options] = mockedSpawn.mock.calls[0];
            expect(options.shell).toBeFalsy();
            expect(command).toBe('open');
            // The app name must arrive as ONE argv element and must NOT be quoted.
            expect(args).toEqual(['-a', 'Antigravity IDE', '--args', '--remote-debugging-port=9999']);
        });

        it('never uses a shell on darwin even for a .cmd-looking name', async () => {
            setPlatform('darwin');

            await run('/opt/weird/antigravity.cmd', ['--flag']);

            const [command, args, options] = mockedSpawn.mock.calls[0];
            expect(options.shell).toBeFalsy();
            expect(command).toBe('/opt/weird/antigravity.cmd');
            expect(args).toEqual(['--flag']);
        });

        it('never uses a shell on linux', async () => {
            setPlatform('linux');

            await run('/opt/Antigravity IDE/antigravity-ide', ['--remote-debugging-port=9999', '/home/me/My Project']);

            const [command, args, options] = mockedSpawn.mock.calls[0];
            expect(options.shell).toBeFalsy();
            expect(command).toBe('/opt/Antigravity IDE/antigravity-ide');
            expect(args).toEqual(['--remote-debugging-port=9999', '/home/me/My Project']);
        });
    });

    it('rejects when the child reports a non-zero exit code', async () => {
        setPlatform('linux');
        mockedSpawn.mockImplementation(() => {
            const child = new EventEmitter();
            setImmediate(() => child.emit('close', 3));
            return child;
        });

        await expect(run('antigravity', [])).rejects.toThrow('antigravity exited with code 3');
    });

    it('rejects when the child emits an error', async () => {
        setPlatform('linux');
        mockedSpawn.mockImplementation(() => {
            const child = new EventEmitter();
            setImmediate(() => child.emit('error', new Error('ENOENT')));
            return child;
        });

        await expect(run('antigravity', [])).rejects.toThrow('ENOENT');
    });
});
