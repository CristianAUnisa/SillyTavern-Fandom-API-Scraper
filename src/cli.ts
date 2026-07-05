import { Command } from 'commander';
import * as fs from 'fs/promises';
import * as path from 'path';
import chalk from 'chalk';
import axios from 'axios';
import {
    performScrape,
    performScrapePages,
    getFandomApiUrl,
    getMediaWikiApiUrl,
    regexFromString,
    ScrapeConfig,
    Page
} from './index';

const program = new Command();

program
    .name('fandom-archiver')
    .description('A standalone CLI tool to scrape and archive Fandom and MediaWiki wikis')
    .version('1.0.3');

program
    .option('-w, --wiki <name>', 'Fandom wiki name (e.g. "fallout" or "community.fandom.com")')
    .option('-u, --url <url>', 'Generic MediaWiki API base URL or endpoint (e.g. "https://minecraft.wiki")')
    .option('-i, --input-file <path>', 'Path to a text file containing page URLs or page titles to scrape (one per line)')
    .option('-o, --output <path>', 'Output file or directory path (default: <wiki-name>.json or archive.json)')
    .option('-f, --format <format>', 'Output format: json, txt, md, md-single, txt-single', 'json')
    .option('-c, --concurrency <number>', 'Number of concurrent requests (default: 30 for Fandom, 2 for MediaWiki)', (val) => parseInt(val, 10))
    .option('--min-delay <ms>', 'Minimum delay in milliseconds between requests (default: 0 for Fandom, 100 for MediaWiki)', (val) => parseInt(val, 10))
    .option('--max-delay <ms>', 'Maximum delay in milliseconds between requests (default: 0 for Fandom, 800 for MediaWiki)', (val) => parseInt(val, 10))
    .option('--listing-delay <ms>', 'Delay in milliseconds between page list fetches (default: 0 for Fandom, 200 for MediaWiki)', (val) => parseInt(val, 10))
    .option('-r, --filter <regex>', 'Regular expression to filter page titles (e.g. "^Character:")')
    .option('--lang-filter', 'Enable automatic language subpage filtering (e.g., removing /ru, /es)', undefined)
    .option('--no-lang-filter', 'Disable automatic language subpage filtering');

const apiCache = new Map<string, string>();

async function resolveApiUrl(domain: string, protocol: string): Promise<string> {
    if (apiCache.has(domain)) {
        return apiCache.get(domain)!;
    }

    if (domain.endsWith('fandom.com')) {
        const apiUrl = `${protocol}//${domain}/api.php`;
        apiCache.set(domain, apiUrl);
        return apiUrl;
    }

    const candidates = [
        `${protocol}//${domain}/w/api.php`,
        `${protocol}//${domain}/api.php`,
    ];

    for (const candidate of candidates) {
        try {
            const response = await axios.get(candidate, {
                params: { action: 'query', format: 'json' },
                headers: {
                    'User-Agent':
                        'SillyTavern-Fandom-API-Scraper/1.0.3 (https://github.com/Nidelon/SillyTavern-Fandom-API-Scraper)',
                    Accept: 'application/json',
                },
                timeout: 5000,
            });
            if (
                response.status === 200 &&
                response.data &&
                typeof response.data === 'object'
            ) {
                apiCache.set(domain, candidate);
                return candidate;
            }
        } catch {
            // ignore and try next
        }
    }

    const fallback = `${protocol}//${domain}/api.php`;
    apiCache.set(domain, fallback);
    return fallback;
}

function parseWikiUrl(urlStr: string): { domain: string; pageTitle: string; protocol: string } | null {
    try {
        const url = new URL(urlStr);
        let pageTitle = '';

        if (url.searchParams.has('title')) {
            pageTitle = url.searchParams.get('title') || '';
        } else {
            const pathname = url.pathname;
            const segments = pathname.split('/').filter(Boolean);
            if (
                segments.length >= 2 &&
                (segments[0] === 'wiki' || segments[0] === 'w')
            ) {
                pageTitle = segments.slice(1).join('/');
            } else if (segments.length > 0) {
                pageTitle = segments[segments.length - 1];
            }
        }

        if (!pageTitle) return null;

        pageTitle = decodeURIComponent(pageTitle).replace(/_/g, ' ');

        return {
            domain: url.hostname,
            pageTitle,
            protocol: url.protocol,
        };
    } catch {
        return null;
    }
}

program.action(async (options) => {
    try {
        if (!options.wiki && !options.url && !options.inputFile) {
            console.error(
                chalk.red(
                    'Error: You must specify either --wiki (-w), --url (-u), or --input-file (-i).',
                ),
            );
            program.help();
            process.exit(1);
        }

        // Parse regex filter
        let filterRegExp: RegExp | undefined;
        if (options.filter) {
            filterRegExp = regexFromString(options.filter);
            if (!filterRegExp) {
                console.error(
                    chalk.red(
                        `Error: Invalid regular expression: "${options.filter}"`,
                    ),
                );
                process.exit(1);
            }
        }

        const getScrapeConfig = (apiUrl: string): ScrapeConfig => {
            const isFandom = apiUrl.includes('fandom.com');
            const concurrency = options.concurrency ?? (isFandom ? 30 : 2);
            const minDelay = options.minDelay ?? (isFandom ? 0 : 100);
            const maxDelay = options.maxDelay ?? (isFandom ? 0 : 800);
            const listingDelay = options.listingDelay ?? (isFandom ? 0 : 200);

            let autoFilterLangs = isFandom ? false : true;
            if (options.langFilter !== undefined) {
                autoFilterLangs = options.langFilter;
            }

            return {
                concurrency,
                minDelay,
                maxDelay,
                autoFilterLangs,
                listingDelay,
            };
        };

        let pages: Page[] = [];
        const startTime = Date.now();

        if (options.inputFile) {
            let fileContent = '';
            try {
                fileContent = await fs.readFile(options.inputFile, 'utf-8');
            } catch (e: any) {
                console.error(
                    chalk.red(
                        `Error: Failed to read input file "${options.inputFile}": ${e.message}`,
                    ),
                );
                process.exit(1);
            }

            const lines = fileContent.split(/\r?\n/);
            const groups = new Map<string, string[]>();

            let baseApiUrl = '';
            if (options.wiki) {
                baseApiUrl = getFandomApiUrl(options.wiki);
            } else if (options.url) {
                baseApiUrl = getMediaWikiApiUrl(options.url);
            }

            for (let line of lines) {
                line = line.trim();
                if (!line || line.startsWith('#')) {
                    continue;
                }

                if (
                    line.startsWith('http://') ||
                    line.startsWith('https://')
                ) {
                    const parsed = parseWikiUrl(line);
                    if (parsed) {
                        const apiUrl = await resolveApiUrl(
                            parsed.domain,
                            parsed.protocol,
                        );
                        if (!groups.has(apiUrl)) {
                            groups.set(apiUrl, []);
                        }
                        groups.get(apiUrl)!.push(parsed.pageTitle);
                    } else {
                        console.log(
                            chalk.yellow(
                                `Warning: Could not parse wiki page URL from line: "${line}"`,
                            ),
                        );
                    }
                } else {
                    if (baseApiUrl) {
                        if (!groups.has(baseApiUrl)) {
                            groups.set(baseApiUrl, []);
                        }
                        groups.get(baseApiUrl)!.push(line);
                    } else {
                        console.log(
                            chalk.yellow(
                                `Warning: Ignoring line "${line}" because it is not a valid URL and no base wiki (-w) or url (-u) is specified.`,
                            ),
                        );
                    }
                }
            }

            if (groups.size === 0) {
                console.log(
                    chalk.yellow(
                        'No valid URLs or page titles found to scrape. Exiting.',
                    ),
                );
                process.exit(0);
            }

            console.log(chalk.green('Starting wiki archive scraper...'));

            for (const [apiUrl, pageTitles] of groups.entries()) {
                console.log(
                    chalk.blue(
                        `Scraping ${pageTitles.length} pages from API: ${apiUrl}`,
                    ),
                );
                const uniqueTitles = Array.from(new Set(pageTitles));
                const config = getScrapeConfig(apiUrl);

                let filteredTitles = uniqueTitles;
                if (filterRegExp) {
                    filteredTitles = uniqueTitles.filter((title) =>
                        filterRegExp.test(title),
                    );
                    console.log(
                        chalk.blue(
                            `Filtered page titles: ${filteredTitles.length} (from ${uniqueTitles.length})`,
                        ),
                    );
                }

                if (filteredTitles.length === 0) {
                    continue;
                }

                const scrapedPages = await performScrapePages(
                    apiUrl,
                    filteredTitles,
                    config,
                );
                pages = pages.concat(scrapedPages);
            }
        } else {
            let apiUrl = '';
            if (options.wiki) {
                apiUrl = getFandomApiUrl(options.wiki);
            } else if (options.url) {
                apiUrl = getMediaWikiApiUrl(options.url);
            }

            const config = getScrapeConfig(apiUrl);
            console.log(chalk.green('Starting wiki archive scraper...'));

            pages = await performScrape(apiUrl, config, filterRegExp);
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(chalk.green(`\nScraping completed in ${duration}s.`));
        console.log(chalk.green(`Total pages scraped: ${pages.length}`));

        if (pages.length === 0) {
            console.log(
                chalk.yellow(
                    'No pages were scraped. Exiting without writing output.',
                ),
            );
            process.exit(0);
        }

        // Determine default output path if not provided
        let outputPath = options.output;
        const format = options.format.toLowerCase();
        if (!outputPath) {
            let name = 'archive';
            if (options.inputFile) {
                name = path
                    .basename(
                        options.inputFile,
                        path.extname(options.inputFile),
                    )
                    .replace(/[^a-zA-Z0-9]/g, '_');
            } else if (options.wiki) {
                name = options.wiki
                    .replace(/https?:\/\/|\.fandom\.com/gi, '')
                    .replace(/[^a-zA-Z0-9]/g, '_');
            } else if (options.url) {
                try {
                    name = new URL(options.url).hostname.replace(
                        /[^a-zA-Z0-9]/g,
                        '_',
                    );
                } catch {
                    name = options.url.replace(/[^a-zA-Z0-9]/g, '_');
                }
            }
            
            if (format === 'json') {
                outputPath = `${name}.json`;
            } else if (format === 'single-md' || format === 'md-single') {
                outputPath = `${name}.md`;
            } else if (format === 'single-txt' || format === 'txt-single') {
                outputPath = `${name}.txt`;
            } else {
                outputPath = `${name}_archive`;
            }
        }

        if (format === 'json') {
            console.log(chalk.blue(`Writing results to JSON file: ${outputPath}`));
            await fs.writeFile(outputPath, JSON.stringify(pages, null, 2), 'utf-8');
            console.log(chalk.green(`Successfully saved to ${outputPath}`));
        } else if (format === 'single-md' || format === 'md-single') {
            console.log(chalk.blue(`Writing consolidated results to MD file: ${outputPath}`));
            if (!outputPath.endsWith('.md')) {
                outputPath += '.md';
            }
            const content = pages.map(p => `# ${p.title}\n\n${p.content}`).join('\n\n---\n\n');
            await fs.writeFile(outputPath, content, 'utf-8');
            console.log(chalk.green(`Successfully saved to ${outputPath}`));
        } else if (format === 'single-txt' || format === 'txt-single') {
            console.log(chalk.blue(`Writing consolidated results to TXT file: ${outputPath}`));
            if (!outputPath.endsWith('.txt')) {
                outputPath += '.txt';
            }
            const content = pages.map(p => `Title: ${p.title}\n\n${p.content}`).join('\n\n========================================\n\n');
            await fs.writeFile(outputPath, content, 'utf-8');
            console.log(chalk.green(`Successfully saved to ${outputPath}`));
        } else if (format === 'txt' || format === 'md') {
            console.log(chalk.blue(`Writing results as ${format.toUpperCase()} files in directory: ${outputPath}`));
            await fs.mkdir(outputPath, { recursive: true });

            let written = 0;
            for (const page of pages) {
                const sanitizedTitle = page.title.replace(/[\/\\:*?"<>|]/g, '_');
                const filePath = path.join(outputPath, `${sanitizedTitle}.${format}`);
                
                let fileContent = page.content;
                if (format === 'md') {
                    fileContent = `# ${page.title}\n\n${page.content}`;
                }
                
                await fs.writeFile(filePath, fileContent, 'utf-8');
                written++;
            }
            console.log(chalk.green(`Successfully wrote ${written} files in ${outputPath}`));
        } else {
            console.error(chalk.red(`Error: Unsupported format "${options.format}". Use json, txt, md, md-single, or txt-single.`));
            process.exit(1);
        }

    } catch (err: any) {
        console.error(chalk.red(`\nAn error occurred during execution:`), err.message);
        process.exit(1);
    }
});

program.parse(process.argv);
