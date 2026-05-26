import { Command } from 'commander';
import * as fs from 'fs/promises';
import * as path from 'path';
import chalk from 'chalk';
import {
    performScrape,
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
    .option('-o, --output <path>', 'Output file or directory path (default: <wiki-name>.json or archive.json)')
    .option('-f, --format <format>', 'Output format: json, txt, md, md-single, txt-single', 'json')
    .option('-c, --concurrency <number>', 'Number of concurrent requests (default: 30 for Fandom, 2 for MediaWiki)', (val) => parseInt(val, 10))
    .option('--min-delay <ms>', 'Minimum delay in milliseconds between requests (default: 0 for Fandom, 100 for MediaWiki)', (val) => parseInt(val, 10))
    .option('--max-delay <ms>', 'Maximum delay in milliseconds between requests (default: 0 for Fandom, 800 for MediaWiki)', (val) => parseInt(val, 10))
    .option('--listing-delay <ms>', 'Delay in milliseconds between page list fetches (default: 0 for Fandom, 200 for MediaWiki)', (val) => parseInt(val, 10))
    .option('-r, --filter <regex>', 'Regular expression to filter page titles (e.g. "^Character:")')
    .option('--lang-filter', 'Enable automatic language subpage filtering (e.g., removing /ru, /es)', undefined)
    .option('--no-lang-filter', 'Disable automatic language subpage filtering');

program.action(async (options) => {
    try {
        if (!options.wiki && !options.url) {
            console.error(chalk.red('Error: You must specify either --wiki (-w) or --url (-u).'));
            program.help();
            process.exit(1);
        }

        let apiUrl = '';
        let isFandom = false;

        if (options.wiki) {
            apiUrl = getFandomApiUrl(options.wiki);
            isFandom = true;
        } else if (options.url) {
            apiUrl = getMediaWikiApiUrl(options.url);
            isFandom = apiUrl.includes('fandom.com');
        }

        // Parse regex filter
        let filterRegExp: RegExp | undefined;
        if (options.filter) {
            filterRegExp = regexFromString(options.filter);
            if (!filterRegExp) {
                console.error(chalk.red(`Error: Invalid regular expression: "${options.filter}"`));
                process.exit(1);
            }
        }

        // Set default configurations based on wiki type if not overridden
        const concurrency = options.concurrency ?? (isFandom ? 30 : 2);
        const minDelay = options.minDelay ?? (isFandom ? 0 : 100);
        const maxDelay = options.maxDelay ?? (isFandom ? 0 : 800);
        const listingDelay = options.listingDelay ?? (isFandom ? 0 : 200);

        // Language filtering default behavior: true for generic mediawiki, false for fandom
        // unless explicitly specified via --lang-filter / --no-lang-filter
        let autoFilterLangs = isFandom ? false : true;
        if (options.langFilter !== undefined) {
            autoFilterLangs = options.langFilter;
        }

        const config: ScrapeConfig = {
            concurrency,
            minDelay,
            maxDelay,
            autoFilterLangs,
            listingDelay,
        };

        const startTime = Date.now();
        console.log(chalk.green('Starting wiki archive scraper...'));

        const pages = await performScrape(apiUrl, config, filterRegExp);

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(chalk.green(`\nScraping completed in ${duration}s.`));
        console.log(chalk.green(`Total pages scraped: ${pages.length}`));

        if (pages.length === 0) {
            console.log(chalk.yellow('No pages were scraped. Exiting without writing output.'));
            process.exit(0);
        }

        // Determine default output path if not provided
        let outputPath = options.output;
        const format = options.format.toLowerCase();
        if (!outputPath) {
            const name = options.wiki 
                ? options.wiki.replace(/https?:\/\/|\.fandom\.com/gi, '').replace(/[^a-zA-Z0-9]/g, '_')
                : new URL(apiUrl).hostname.replace(/[^a-zA-Z0-9]/g, '_');
            
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
