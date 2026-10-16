jest.mock('fs');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveLinuxDisplay, getLinuxDisplayEnv } from '../../src/utils/displayUtils';

const mockedFs = fs as jest.Mocked<typeof fs>;

describe('displayUtils', () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const originalEnv = { ...process.env };

    function setPlatform(platform: NodeJS.Platform) {
        Object.defineProperty(process, 'platform', {
            value: platform,
            configurable: true,
            writable: true,
        });
    }

    beforeEach(() => {
        process.env = { ...originalEnv };
        delete process.env.DISPLAY;
        delete process.env.REMOAT_DISPLAY;
        delete process.env.XAUTHORITY;
        mockedFs.existsSync.mockReset();
        mockedFs.readdirSync.mockReset();
    });

    afterEach(() => {
        Object.defineProperty(process, 'platform', originalPlatform);
        process.env = originalEnv;
        jest.restoreAllMocks();
    });

    describe('resolveLinuxDisplay', () => {
        it('returns undefined on non-Linux platforms', () => {
            setPlatform('darwin');
            process.env.DISPLAY = ':0';
            expect(resolveLinuxDisplay()).toBeUndefined();

            setPlatform('win32');
            expect(resolveLinuxDisplay('localhost:1.0')).toBeUndefined();
        });

        it('prioritizes process.env.DISPLAY on Linux', () => {
            setPlatform('linux');
            process.env.DISPLAY = ':5';
            process.env.REMOAT_DISPLAY = ':10';
            expect(resolveLinuxDisplay(':2')).toBe(':5');
        });

        it('falls back to process.env.REMOAT_DISPLAY when DISPLAY is not set', () => {
            setPlatform('linux');
            process.env.REMOAT_DISPLAY = ':10';
            expect(resolveLinuxDisplay(':2')).toBe(':10');
        });

        it('falls back to customDisplay argument when env vars are unset', () => {
            setPlatform('linux');
            expect(resolveLinuxDisplay('localhost:1.0')).toBe('localhost:1.0');
        });

        it('auto-detects lowest display number from /tmp/.X11-unix if available', () => {
            setPlatform('linux');
            mockedFs.existsSync.mockReturnValue(true);
            mockedFs.readdirSync.mockReturnValue(['X1', 'X0', 'other_file'] as any);

            expect(resolveLinuxDisplay()).toBe(':0');
        });

        it('returns undefined if /tmp/.X11-unix does not exist and no config/env provided', () => {
            setPlatform('linux');
            mockedFs.existsSync.mockReturnValue(false);
            expect(resolveLinuxDisplay()).toBeUndefined();
        });
    });

    describe('getLinuxDisplayEnv', () => {
        it('returns empty object on non-Linux', () => {
            setPlatform('win32');
            expect(getLinuxDisplayEnv(':0')).toEqual({});
        });

        it('populates DISPLAY and XAUTHORITY on Linux', () => {
            setPlatform('linux');
            process.env.DISPLAY = ':1';
            const fakeXauth = path.join(os.homedir(), '.Xauthority');
            mockedFs.existsSync.mockImplementation((p) => p === fakeXauth);

            const env = getLinuxDisplayEnv();
            expect(env.DISPLAY).toBe(':1');
            expect(env.XAUTHORITY).toBe(fakeXauth);
        });

        it('preserves existing process.env.XAUTHORITY', () => {
            setPlatform('linux');
            process.env.DISPLAY = ':1';
            process.env.XAUTHORITY = '/custom/path/.Xauthority';

            const env = getLinuxDisplayEnv();
            expect(env.DISPLAY).toBe(':1');
            expect(env.XAUTHORITY).toBeUndefined(); // getLinuxDisplayEnv leaves it to process.env
        });
    });
});
