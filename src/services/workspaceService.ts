import fs from 'fs';
import { resolveSafePath } from '../middleware/sanitize';

/**
 * Service for workspace filesystem operations and path validation.
 * Manages directories under WORKSPACE_BASE_DIR.
 */
export class WorkspaceService {
    private readonly baseDir: string;

    constructor(baseDir: string) {
        this.baseDir = baseDir;
    }

    /**
     * Ensure the base directory exists, creating it if necessary
     */
    public ensureBaseDir(): void {
        if (!fs.existsSync(this.baseDir)) {
            fs.mkdirSync(this.baseDir, { recursive: true });
        }
    }

    /**
     * Return a list of subdirectories in the specified relative path
     */
    public scanWorkspaces(relativePath: string = ''): string[] {
        this.ensureBaseDir();
        const absolutePath = this.validatePath(relativePath);

        try {
            const entries = fs.readdirSync(absolutePath, { withFileTypes: true });
            return entries
                .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
                .map((entry) => entry.name)
                .sort();
        } catch {
            return [];
        }
    }

    /**
     * Validate a relative path and return a safe absolute path
     * @throws On path traversal detection
     */
    public validatePath(relativePath: string): string {
        return resolveSafePath(relativePath, this.baseDir);
    }

    /**
     * Get the base directory path
     */
    public getBaseDir(): string {
        return this.baseDir;
    }

    /**
     * Return the absolute path of the specified workspace
     */
    public getWorkspacePath(workspaceName: string): string {
        return this.validatePath(workspaceName);
    }

    /**
     * Check if the specified workspace exists
     */
    public exists(workspaceName: string): boolean {
        const fullPath = this.validatePath(workspaceName);
        return fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory();
    }
}
