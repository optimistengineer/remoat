// Must mock before importing: pathUtils probes the filesystem via fs.existsSync,
// and these tests assert PLUMBING (what gets spawned) rather than RESOLUTION
// (which path wins — owned by tests/utils/pathUtils.test.ts). Without the mock
// the assertions below would depend on whether the CI box has Antigravity
// installed. The automock makes existsSync return undefined, so the resolver
// falls back to its historical literals — identical on a Mac dev box and Linux CI.
jest.mock('fs');

import { CdpService } from '../../src/services/cdpService';
import * as fs from 'fs';

// Mock logger to avoid printing during tests
jest.mock('../../src/utils/logger', () => ({
    logger: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }
}));

// Mock child_process for spawn
jest.mock('child_process');

const mockedFs = fs as jest.Mocked<typeof fs>;

/** Mark exactly the given paths as existing on disk. */
const existingPaths = (...paths: string[]) =>
    mockedFs.existsSync.mockImplementation((p) => paths.includes(String(p)));

describe('CdpService - Cross-Platform Workspace Launching', () => {
    let service: CdpService;
    let originalPlatform: NodeJS.Platform;
    let originalEnv: NodeJS.ProcessEnv;
    let mockRunCommand: jest.SpyInstance;
    let mockGetJson: jest.SpyInstance;

    /** A fake CDP page that ends the 30s poll loop immediately. */
    const fakeWorkbenchPage = (title = 'MyProject') => ([{
        id: 'new-id',
        type: 'page',
        title,
        webSocketDebuggerUrl: 'ws://debug',
        url: 'file:///workbench',
    }]);

    beforeEach(() => {
        originalPlatform = process.platform;
        originalEnv = { ...process.env };
        // Nothing installed by default -> the resolver returns its legacy literals.
        mockedFs.existsSync.mockReturnValue(false);

        service = new CdpService({ portsToScan: [9999], maxReconnectAttempts: 0 });

        // Mock internal implementation to avoid actual CDP port scanning and connection
        mockGetJson = jest.spyOn(service as any, 'getJson').mockRejectedValue(new Error('Connection refused'));
        jest.spyOn(service as any, 'connect').mockResolvedValue(undefined);

        // We want to spy on runCommand, but let it resolve immediately so we don't have to wait 30s
        mockRunCommand = jest.spyOn(service as any, 'runCommand').mockResolvedValue(undefined);

        // Mock probeWorkbenchPages to return false so it forces a launch if ports somehow matched
        jest.spyOn(service as any, 'probeWorkbenchPages').mockResolvedValue(false);

        // Mock findAvailableCdpPort to return the configured port (avoids real TCP listen)
        jest.spyOn(service as any, 'findAvailableCdpPort').mockResolvedValue(9999);
    });

    afterEach(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
        process.env = originalEnv;
        jest.resetAllMocks();
    });

    // Helper to mock the platform
    const setPlatform = (platform: NodeJS.Platform) => {
        Object.defineProperty(process, 'platform', { value: platform });
    };

    describe('launchAndConnectWorkspace (Mac)', () => {
        it('should launch Antigravity using the Mac application path', async () => {
            setPlatform('darwin');

            // To prevent hanging on the 30-second poll loop in launchAndConnectWorkspace
            // we will make the second call to getJson return a fake new workbench page
            mockGetJson
                .mockRejectedValueOnce(new Error('Initial pre-launch port scan fails'))
                .mockResolvedValue([{
                    id: 'new-id',
                    type: 'page',
                    title: 'MyProject',
                    webSocketDebuggerUrl: 'ws://debug',
                    url: 'file:///workbench'
                }]);

            const workspacePath = '/Users/test/Documents/MyProject';
            await service.discoverAndConnectForWorkspace(workspacePath);

            expect(mockRunCommand).toHaveBeenCalledWith(
                '/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity',
                ['--remote-debugging-port=9999', '--new-window', workspacePath]
            );
        });

        it('should fallback to `open -a Antigravity` if the CLI launch fails on Mac', async () => {
            setPlatform('darwin');

            // First runCommand fails, second succeeds
            mockRunCommand
                .mockRejectedValueOnce(new Error('Command not found'))
                .mockResolvedValueOnce(undefined);

            mockGetJson
                .mockRejectedValueOnce(new Error('Initial pre-launch port scan fails'))
                .mockResolvedValue([{
                    id: 'new-id',
                    type: 'page',
                    title: 'MyProject',
                    webSocketDebuggerUrl: 'ws://debug',
                    url: 'file:///workbench'
                }]);

            const workspacePath = '/Users/test/Documents/MyProject';
            await service.discoverAndConnectForWorkspace(workspacePath);

            expect(mockRunCommand).toHaveBeenCalledTimes(2);
            expect(mockRunCommand).toHaveBeenNthCalledWith(1,
                '/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity',
                ['--remote-debugging-port=9999', '--new-window', workspacePath]
            );
            expect(mockRunCommand).toHaveBeenNthCalledWith(2,
                'open',
                ['-a', 'Antigravity', '--args', '--remote-debugging-port=9999', workspacePath]
            );
        });

        it('passes "Antigravity IDE" as a single unquoted argv element when the v2 bundle is installed', async () => {
            setPlatform('darwin');
            // v2 ships as app.asar, so Contents/Resources/app/bin/antigravity does
            // NOT exist — only the bundle does. The CLI launch therefore fails and
            // `open -a` is the de-facto primary macOS launcher.
            existingPaths('/Applications/Antigravity IDE.app');

            mockRunCommand
                .mockRejectedValueOnce(new Error('Command not found'))
                .mockResolvedValueOnce(undefined);

            mockGetJson
                .mockRejectedValueOnce(new Error('Initial pre-launch port scan fails'))
                .mockResolvedValue(fakeWorkbenchPage());

            const workspacePath = '/Users/test/Documents/MyProject';
            await service.discoverAndConnectForWorkspace(workspacePath);

            expect(mockRunCommand).toHaveBeenNthCalledWith(2,
                'open',
                ['-a', 'Antigravity IDE', '--args', '--remote-debugging-port=9999', workspacePath]
            );
            const appNameArg = mockRunCommand.mock.calls[1][1][1];
            expect(appNameArg).toBe('Antigravity IDE');
            expect(appNameArg).not.toContain('"');
        });

        it('keeps using "Antigravity" when only the v1 bundle is installed (backward compat)', async () => {
            setPlatform('darwin');
            existingPaths('/Applications/Antigravity.app');

            mockRunCommand
                .mockRejectedValueOnce(new Error('Command not found'))
                .mockResolvedValueOnce(undefined);

            mockGetJson
                .mockRejectedValueOnce(new Error('Initial pre-launch port scan fails'))
                .mockResolvedValue(fakeWorkbenchPage());

            const workspacePath = '/Users/test/Documents/MyProject';
            await service.discoverAndConnectForWorkspace(workspacePath);

            expect(mockRunCommand).toHaveBeenNthCalledWith(2,
                'open',
                ['-a', 'Antigravity', '--args', '--remote-debugging-port=9999', workspacePath]
            );
        });

        it('launches the detected v2 macOS CLI when it does exist', async () => {
            setPlatform('darwin');
            const v2Cli = '/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity';
            existingPaths(v2Cli, '/Applications/Antigravity IDE.app');

            mockGetJson
                .mockRejectedValueOnce(new Error('Initial pre-launch port scan fails'))
                .mockResolvedValue(fakeWorkbenchPage());

            const workspacePath = '/Users/test/Documents/MyProject';
            await service.discoverAndConnectForWorkspace(workspacePath);

            expect(mockRunCommand).toHaveBeenCalledWith(
                v2Cli,
                ['--remote-debugging-port=9999', '--new-window', workspacePath]
            );
        });
    });

    describe('launchAndConnectWorkspace (Windows)', () => {
        it('should launch Antigravity using LOCALAPPDATA environment variable', async () => {
            setPlatform('win32');
            process.env.LOCALAPPDATA = 'C:\\Users\\TestUser\\AppData\\Local';

            mockGetJson
                .mockRejectedValueOnce(new Error('Initial pre-launch port scan fails'))
                .mockResolvedValue([{
                    id: 'new-id',
                    type: 'page',
                    title: 'MyProject',
                    webSocketDebuggerUrl: 'ws://debug',
                    url: 'file:///workbench'
                }]);

            const workspacePath = 'C:\\Source\\MyProject';
            await service.discoverAndConnectForWorkspace(workspacePath);

            expect(mockRunCommand).toHaveBeenCalledWith(
                'C:\\Users\\TestUser\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe',
                ['--remote-debugging-port=9999', '--new-window', workspacePath]
            );
        });

        it('should fallback to Antigravity.exe if LOCALAPPDATA is missing on Windows', async () => {
            setPlatform('win32');
            delete process.env.LOCALAPPDATA;

            mockGetJson
                .mockRejectedValueOnce(new Error('Initial pre-launch port scan fails'))
                .mockResolvedValue([{
                    id: 'new-id',
                    type: 'page',
                    title: 'MyProject',
                    webSocketDebuggerUrl: 'ws://debug',
                    url: 'file:///workbench'
                }]);

            const workspacePath = 'C:\\Source\\MyProject';
            await service.discoverAndConnectForWorkspace(workspacePath);

            expect(mockRunCommand).toHaveBeenCalledWith(
                'Antigravity.exe',
                ['--remote-debugging-port=9999', '--new-window', workspacePath]
            );
        });

        it('launches the v2 executable when an Antigravity IDE install is detected', async () => {
            setPlatform('win32');
            process.env.LOCALAPPDATA = 'C:\\Users\\TestUser\\AppData\\Local';
            const v2Exe = 'C:\\Users\\TestUser\\AppData\\Local\\Programs\\Antigravity IDE\\Antigravity IDE.exe';
            existingPaths(v2Exe);

            mockGetJson
                .mockRejectedValueOnce(new Error('Initial pre-launch port scan fails'))
                .mockResolvedValue(fakeWorkbenchPage('App'));

            const workspacePath = 'C:\\My Projects\\App';
            await service.discoverAndConnectForWorkspace(workspacePath);

            expect(mockRunCommand).toHaveBeenCalledWith(
                v2Exe,
                ['--remote-debugging-port=9999', '--new-window', workspacePath]
            );
        });

        it('launches the v1 executable when only an Antigravity install is detected (backward compat)', async () => {
            setPlatform('win32');
            process.env.LOCALAPPDATA = 'C:\\Users\\TestUser\\AppData\\Local';
            const v1Exe = 'C:\\Users\\TestUser\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe';
            existingPaths(v1Exe);

            mockGetJson
                .mockRejectedValueOnce(new Error('Initial pre-launch port scan fails'))
                .mockResolvedValue(fakeWorkbenchPage());

            const workspacePath = 'C:\\Source\\MyProject';
            await service.discoverAndConnectForWorkspace(workspacePath);

            expect(mockRunCommand).toHaveBeenCalledWith(
                v1Exe,
                ['--remote-debugging-port=9999', '--new-window', workspacePath]
            );
        });
    });

    describe('launchAndConnectWorkspace (Linux / Unknown)', () => {
        it('should default to `antigravity` command if ANTIGRAVITY_PATH is not set', async () => {
            setPlatform('linux');
            delete process.env.ANTIGRAVITY_PATH;

            mockGetJson
                .mockRejectedValueOnce(new Error('Initial pre-launch port scan fails'))
                .mockResolvedValue([{
                    id: 'new-id',
                    type: 'page',
                    title: 'MyProject',
                    webSocketDebuggerUrl: 'ws://debug',
                    url: 'file:///workbench'
                }]);

            const workspacePath = '/home/user/MyProject';
            await service.discoverAndConnectForWorkspace(workspacePath);

            expect(mockRunCommand).toHaveBeenCalledWith(
                'antigravity',
                ['--remote-debugging-port=9999', '--new-window', workspacePath]
            );
        });

        it('should use ANTIGRAVITY_PATH if it is set', async () => {
            setPlatform('linux');
            process.env.ANTIGRAVITY_PATH = '/opt/custom/antigravity.AppImage';

            mockGetJson
                .mockRejectedValueOnce(new Error('Initial pre-launch port scan fails'))
                .mockResolvedValue([{
                    id: 'new-id',
                    type: 'page',
                    title: 'MyProject',
                    webSocketDebuggerUrl: 'ws://debug',
                    url: 'file:///workbench'
                }]);

            const workspacePath = '/home/user/MyProject';
            await service.discoverAndConnectForWorkspace(workspacePath);

            expect(mockRunCommand).toHaveBeenCalledWith(
                '/opt/custom/antigravity.AppImage',
                ['--remote-debugging-port=9999', '--new-window', workspacePath]
            );
        });
    });

    describe('Project Name Extraction', () => {
        it('should extract the project name from a Windows path with backslashes', async () => {
            setPlatform('win32');
            process.env.LOCALAPPDATA = 'C:\\Users\\TestUser\\AppData\\Local';

            mockGetJson
                .mockRejectedValueOnce(new Error('Initial pre-launch port scan fails'))
                .mockResolvedValue([{
                    id: 'new-id',
                    type: 'page',
                    title: 'MyProject',
                    webSocketDebuggerUrl: 'ws://debug',
                    url: 'file:///workbench'
                }]);

            const workspacePath = 'C:\\Source\\MyProject';
            await service.discoverAndConnectForWorkspace(workspacePath);

            expect(service.getCurrentWorkspaceName()).toBe('MyProject');
        });

        it('should extract the project name from a Mac/Linux path with forward slashes', async () => {
            setPlatform('darwin');

            mockGetJson
                .mockRejectedValueOnce(new Error('Initial pre-launch port scan fails'))
                .mockResolvedValue([{
                    id: 'new-id',
                    type: 'page',
                    title: 'my-cool-project',
                    webSocketDebuggerUrl: 'ws://debug',
                    url: 'file:///workbench'
                }]);

            const workspacePath = '/Users/test/Documents/my-cool-project';
            await service.discoverAndConnectForWorkspace(workspacePath);

            expect(service.getCurrentWorkspaceName()).toBe('my-cool-project');
        });

        it('should extract the project name from a path with trailing slashes', async () => {
            setPlatform('linux');

            mockGetJson
                .mockRejectedValueOnce(new Error('Initial pre-launch port scan fails'))
                .mockResolvedValue([{
                    id: 'new-id',
                    type: 'page',
                    title: 'trailing-slash-proj',
                    webSocketDebuggerUrl: 'ws://debug',
                    url: 'file:///workbench'
                }]);

            const workspacePath = '/home/user/trailing-slash-proj/';
            await service.discoverAndConnectForWorkspace(workspacePath);

            expect(service.getCurrentWorkspaceName()).toBe('trailing-slash-proj');
        });
    });
});
