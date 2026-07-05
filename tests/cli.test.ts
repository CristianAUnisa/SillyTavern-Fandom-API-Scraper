import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as http from 'http';
import { exec } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

let server: http.Server;
const PORT = 4567;

const runCli = (args: string): Promise<{ stdout: string; stderr: string; code: number }> => {
    return new Promise((resolve) => {
        exec(`node dist/cli.js ${args}`, (error, stdout, stderr) => {
            resolve({
                stdout,
                stderr,
                code: error ? (error.code || 1) : 0,
            });
        });
    });
};

describe('CLI Integration', () => {
    const tempFiles: string[] = [];

    const getTempPath = (filename: string) => {
        const p = path.join(process.cwd(), filename);
        tempFiles.push(p);
        return p;
    };

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            const url = new URL(req.url || '', `http://${req.headers.host}`);
            
            if (url.pathname.endsWith('/api.php')) {
                const action = url.searchParams.get('action');
                if (action === 'query') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        query: {
                            allpages: [
                                { title: 'Test Page 1' },
                                { title: 'Test Page 2' },
                            ],
                        },
                    }));
                } else if (action === 'parse') {
                    const page = url.searchParams.get('page');
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        parse: {
                            title: page,
                            text: {
                                '*': `<div><h1>${page}</h1><p>This is a valid mock scraped page content containing enough character content to easily bypass the minimum text length requirement of 100 characters. Vault 111 is a great starting location in Fallout 4.</p></div>`,
                            },
                        },
                    }));
                } else {
                    res.writeHead(400);
                    res.end();
                }
            } else {
                res.writeHead(404);
                res.end();
            }
        });

        await new Promise<void>((resolve) => {
            server.listen(PORT, () => {
                resolve();
            });
        });
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => {
            server.close(() => {
                resolve();
            });
        });
    });

    afterEach(async () => {
        for (const file of tempFiles) {
            try {
                const stat = await fs.stat(file);
                if (stat.isDirectory()) {
                    await fs.rm(file, { recursive: true, force: true });
                } else {
                    await fs.unlink(file);
                }
            } catch {
                // ignore
            }
        }
        tempFiles.length = 0;
    });

    it('should archive a wiki page with a regular expression filter to a single JSON file', async () => {
        const outPath = getTempPath('test-cli-filter.json');
        
        const { code, stdout } = await runCli(`-u http://localhost:${PORT} -r "^Test Page 1$" -f json -o "${outPath}"`);
        
        expect(code).toBe(0);
        expect(stdout).toContain('Scraping completed');
        expect(stdout).toContain('Total pages scraped: 1');
        
        const fileContent = await fs.readFile(outPath, 'utf-8');
        const parsed = JSON.parse(fileContent);
        
        expect(parsed).toBeInstanceOf(Array);
        expect(parsed).toHaveLength(1);
        expect(parsed[0].title).toBe('Test Page 1');
        expect(parsed[0].content).toContain('This is a valid mock scraped page content');
    }, 10000);

    it('should scrape specific page titles from an input file to a consolidated markdown file', async () => {
        const inputPath = getTempPath('test-cli-titles.txt');
        const outPath = getTempPath('test-cli-titles.md');
        
        await fs.writeFile(inputPath, 'Test Page 2\n# Comment line\n\n', 'utf-8');
        
        const { code, stdout } = await runCli(`-u http://localhost:${PORT} -i "${inputPath}" -f md-single -o "${outPath}"`);
        
        expect(code).toBe(0);
        expect(stdout).toContain('Scraping completed');
        expect(stdout).toContain('Total pages scraped: 1');
        
        const fileContent = await fs.readFile(outPath, 'utf-8');
        expect(fileContent).toContain('# Test Page 2');
    }, 10000);

    it('should scrape URLs from an input file to individual markdown files', async () => {
        const inputPath = getTempPath('test-cli-urls.txt');
        const outDir = getTempPath('test-cli-md-dir');
        
        await fs.writeFile(inputPath, `http://localhost:${PORT}/wiki/Test_Page_1\n`, 'utf-8');
        
        const { code, stdout } = await runCli(`-i "${inputPath}" -f md -o "${outDir}"`);
        
        expect(code).toBe(0);
        expect(stdout).toContain('Scraping completed');
        
        const files = await fs.readdir(outDir);
        expect(files).toContain('Test Page 1.md');
        
        const fileContent = await fs.readFile(path.join(outDir, 'Test Page 1.md'), 'utf-8');
        expect(fileContent).toContain('# Test Page 1');
    }, 10000);
});
