import { File } from 'node:buffer';

// https://github.com/Nidelon/SillyTavern-Fandom-API-Scraper/issues/1
if (typeof global.File === 'undefined') {
    (global as any).File = File;
}

import chalk from 'chalk';
import axios from 'axios';
import { convert } from 'html-to-text';
import * as cheerio from 'cheerio';
import pLimit from 'p-limit';
import { getFandomApiUrl, getMediaWikiApiUrl, regexFromString } from './utils';

export { getFandomApiUrl, getMediaWikiApiUrl, regexFromString };


interface WikiApiResponse {
    query?: {
        allpages?: Array<{ title: string }>;
    };
    continue?: Record<string, string>;
    parse?: {
        text?: {
            '*': string;
        };
    };
}

export interface Page {
    title: string;
    content: string;
}

export interface ScrapeConfig {
    concurrency: number;
    minDelay: number;
    maxDelay: number;
    autoFilterLangs: boolean;
    listingDelay: number;
}

const MODULE_NAME = '[STFAPIS]';
const MIN_TEXT_LENGTH = 100;
const MAX_RETRIES = 10;
const BASE_RETRY_DELAY = 5000;

const DEFAULT_HEADERS = {
    'User-Agent':
        'SillyTavern-Fandom-API-Scraper/1.0.3 (https://github.com/Nidelon/SillyTavern-Fandom-API-Scraper)',
    Accept: 'application/json',
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'keep-alive',
};

const SELECTORS_TO_REMOVE = [
    '.navbox',
    '.toc',
    '.wds-tabs',
    '.mw-editsection',
    'style',
    'script',
    '.aside',
    '.printfooter',
    '#catlinks',
    '.gallery',
    '.wikia-gallery',
    '.messagebox',
    '.notice',
    '.error',
    'table:not([class*="infobox"]):not([class*="pi-"])',
    'figure',
    'video',
    '.reference',
    '.mw-jump-link',
    '#mw-navigation',
    '.ambox',
    '[class*="trfc"]',
    '[class*="quick-answers"]',
    '[class*="QuickAnswers"]',
];

const TEXT_CONVERT_OPTIONS = {
    wordwrap: false,
    selectors: [
        { selector: 'a', options: { ignoreHref: true } },
        { selector: 'img', format: 'skip' },
        { selector: 'table[class*="infobox"]', format: 'table' },
        { selector: 'table[class*="pi-"]', format: 'table' },
        { selector: 'table', format: 'skip' },
    ],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const randomSleep = (min: number, max: number) => {
    if (min === 0 && max === 0) return Promise.resolve();
    return sleep(Math.floor(Math.random() * (max - min + 1) + min));
};

export async function performScrape(
    apiUrl: string,
    config: ScrapeConfig,
    filter?: RegExp,
): Promise<Page[]> {
    console.log(chalk.blue(MODULE_NAME), `Target API: ${apiUrl}`);
    console.log(
        chalk.gray(MODULE_NAME),
        `Mode: Concurrency=${config.concurrency}, Delay=${config.minDelay}-${config.maxDelay}ms, FilterLangs=${config.autoFilterLangs}`,
    );

    let allPages: Array<{ title: string }> = [];
    const queryParams: any = {
        action: 'query',
        list: 'allpages',
        aplimit: 500,
        apfilterredir: 'nonredirects',
        format: 'json',
    };
    let continueToken: any = null;

    try {
        console.log(chalk.blue(MODULE_NAME), 'Fetching page list...');
        do {
            const params = { ...queryParams, ...continueToken };

            if (config.listingDelay > 0) await sleep(config.listingDelay);

            const response = await axios.get<WikiApiResponse>(apiUrl, {
                params: params,
                headers: DEFAULT_HEADERS,
            });

            const data = response.data;
            if (data.query && data.query.allpages) {
                allPages = allPages.concat(data.query.allpages);
            }

            if (data.continue) {
                continueToken = data.continue;
            } else {
                continueToken = null;
            }

            if (allPages.length % 2000 === 0) {
                console.log(
                    chalk.gray(MODULE_NAME),
                    `Discovered ${allPages.length} pages...`,
                );
            }
        } while (continueToken);
    } catch (err: any) {
        throw new Error(`Failed to fetch page list: ${err.message}`);
    }

    const originalCount = allPages.length;

    if (!filter && config.autoFilterLangs) {
        allPages = allPages.filter(
            (p) => !/\/[a-z]{2,3}(-[a-z]+)?$/i.test(p.title),
        );
        console.log(
            chalk.blue(MODULE_NAME),
            `Auto-filtered language subpages. Remaining: ${allPages.length} (from ${originalCount})`,
        );
    } else if (filter) {
        allPages = allPages.filter((p) => filter.test(p.title));
        console.log(
            chalk.blue(MODULE_NAME),
            `Filtered pages: ${allPages.length} (from ${originalCount})`,
        );
    } else {
        console.log(
            chalk.blue(MODULE_NAME),
            `Total pages to parse: ${allPages.length}`,
        );
    }

    console.log(chalk.blue(MODULE_NAME), 'Starting parsing...');

    const limit = pLimit(config.concurrency);
    const results: Page[] = [];
    let completed = 0;

    const tasks = allPages.map((page) =>
        limit(async () => {
            const content = await scrapePage(apiUrl, page.title, config);
            if (content !== null) {
                results.push({ title: page.title, content });
            }
        }).finally(() => {
            completed++;
            const logStep = config.concurrency > 10 ? 200 : 20;
            if (completed % logStep === 0 || completed === allPages.length) {
                console.log(
                    chalk.gray(MODULE_NAME),
                    `Progress: ${completed}/${allPages.length} | Scraped: ${results.length}`,
                );
            }
        }),
    );

    await Promise.all(tasks);
    return results;
}

export async function scrapePage(
    apiUrl: string,
    pageTitle: string,
    config: ScrapeConfig,
): Promise<string | null> {
    let attempts = 0;
    let success = false;

    while (!success && attempts < MAX_RETRIES) {
        try {
            await randomSleep(config.minDelay, config.maxDelay);

            const response = await axios.get<WikiApiResponse>(apiUrl, {
                params: {
                    action: 'parse',
                    page: pageTitle,
                    prop: 'text',
                    format: 'json',
                    disablelimitreport: 1,
                    disableeditsection: 1,
                    redirects: 1,
                },
                headers: DEFAULT_HEADERS,
                timeout: 15000,
            });

            const data = response.data;
            success = true;

            if (!data.parse || !data.parse.text) return null;

            const html = data.parse.text['*'];
            const $ = cheerio.load(html);

            parseDialogueTables($);

            $(SELECTORS_TO_REMOVE.join(', ')).remove();

            // Remove Wikipedia link "WP" superscript icons
            $('sup').each((i, el) => {
                if ($(el).text().trim() === 'WP') {
                    $(el).remove();
                }
            });

            // Restructure pi-smart-group elements to pair labels and values on the same line
            $('.pi-smart-group').each((i, group) => {
                const head = $(group).find('.pi-smart-group-head');
                const body = $(group).find('.pi-smart-group-body');

                if (head.length > 0 && body.length > 0) {
                    const labels = head.children();
                    const values = body.children();
                    let replacementHtml = '';
                    labels.each((idx, labelNode) => {
                        const labelText = $(labelNode).text().trim();
                        const valueNode = values.eq(idx);
                        if (valueNode.length > 0) {
                            const valueText = valueNode.text().trim();
                            replacementHtml += `<div class="pi-smart-pair"><strong>${labelText}</strong> ${valueText}</div>`;
                        }
                    });
                    if (replacementHtml) {
                        $(group).replaceWith(replacementHtml);
                    }
                } else if (body.length > 0) {
                    const children = body.children();
                    let replacementHtml = '';
                    for (let idx = 0; idx < children.length; idx += 2) {
                        const labelNode = children.eq(idx);
                        const valueNode = children.eq(idx + 1);
                        if (labelNode.length > 0 && valueNode.length > 0) {
                            const labelText = labelNode.text().trim();
                            const valueText = valueNode.text().trim();
                            replacementHtml += `<div class="pi-smart-pair"><strong>${labelText}:</strong> ${valueText}</div>`;
                        }
                    }
                    if (replacementHtml) {
                        $(group).replaceWith(replacementHtml);
                    }
                }
            });
            $('h2, h3, h4, h5, h6').each((i, el) => {
                if ($(el).parents('.portable-infobox, .infobox, aside').length > 0) {
                    return;
                }
                const next = $(el).next();
                if (
                    next.length === 0 ||
                    /^h[2-6]$/.test(next[0].name)
                ) {
                    $(el).remove();
                }
            });

            $('.portable-infobox, .infobox, aside').each((i, el) => {
                if ($(el).parents('.portable-infobox, .infobox, aside').length > 0) {
                    return;
                }
                $(el).before('<div>::: INFOBOX START :::</div>');
                $(el).after('<div>::: INFOBOX END :::</div>');
            });

            let text = convert($.html(), TEXT_CONVERT_OPTIONS as any);
            text = text
                .replace(/\[edit\]/gi, '')
                .replace(/[ \t]+/g, ' ')
                .replace(/\n\s*\n/g, '\n\n')
                .trim();

            if (text.length >= MIN_TEXT_LENGTH) {
                return text;
            }
            return null;
        } catch (e: any) {
            attempts++;
            const status = e.response ? e.response.status : 'Unknown';

            if (status === 429) {
                const waitTime =
                    BASE_RETRY_DELAY * Math.pow(2, attempts - 1);
                console.log(
                    chalk.yellow(MODULE_NAME),
                    `Rate Limited (429) on "${pageTitle}". Retrying in ${waitTime / 1000}s...`,
                );
                await sleep(waitTime);
            } else if (
                status === 503 ||
                status === 502 ||
                e.code === 'ECONNRESET'
            ) {
                await sleep(2000);
            } else {
                if (attempts === 1) {
                    if (config.concurrency < 5) {
                        console.error(
                            chalk.red(MODULE_NAME),
                            `Failed "${pageTitle}": ${e.message} (${status})`,
                        );
                    }
                }
                break;
            }
        }
    }
    return null;
}

export async function performScrapePages(
    apiUrl: string,
    pageTitles: string[],
    config: ScrapeConfig,
): Promise<Page[]> {
    console.log(chalk.blue(MODULE_NAME), `Target API: ${apiUrl}`);
    console.log(
        chalk.gray(MODULE_NAME),
        `Mode: Concurrency=${config.concurrency}, Delay=${config.minDelay}-${config.maxDelay}ms, Specific Pages Scraping`,
    );

    const limit = pLimit(config.concurrency);
    const results: Page[] = [];
    let completed = 0;

    const tasks = pageTitles.map((title) =>
        limit(async () => {
            const content = await scrapePage(apiUrl, title, config);
            if (content !== null) {
                results.push({ title, content });
            }
        }).finally(() => {
            completed++;
            const logStep = config.concurrency > 10 ? 200 : 20;
            if (completed % logStep === 0 || completed === pageTitles.length) {
                console.log(
                    chalk.gray(MODULE_NAME),
                    `Progress: ${completed}/${pageTitles.length} | Scraped: ${results.length}`,
                );
            }
        }),
    );

    await Promise.all(tasks);
    return results;
}

function parseDialogueTables($: cheerio.CheerioAPI) {
    $('table').each((i, tableEl) => {
        const table = $(tableEl);

        const hasClass = table.hasClass('dialogue-table') || 
                         (table.attr('class') && table.attr('class')?.includes('dialogue'));
        
        let hasOccasionHeader = false;
        let hasTranslationHeader = false;

        table.find('th').each((j, thEl) => {
            const txt = $(thEl).text().trim().toLowerCase();
            if (txt === 'occasion' || txt === 'line' || txt === 'trigger') {
                hasOccasionHeader = true;
            }
            if (txt === 'japanese' || txt === 'english' || txt === 'translation' || txt === 'original') {
                hasTranslationHeader = true;
            }
        });

        const isDialogueTable = hasClass || (hasOccasionHeader && hasTranslationHeader);

        if (!isDialogueTable) {
            return;
        }

        let totalHeaderCols = 0;
        let occasionColIdx = -1;
        const dataCols: Array<{ index: number; title: string }> = [];
        let headerRowFound = false;

        // Try to identify column headers
        table.find('tr').each((rowIdx, trEl) => {
            if (headerRowFound) return;
            const row = $(trEl);
            const ths = row.find('th');
            if (ths.length >= 2) {
                let hasKeyHeader = false;
                ths.each((thIdx, thEl) => {
                    const text = $(thEl).text().trim().toLowerCase();
                    if (
                        text === 'occasion' ||
                        text === 'line' ||
                        text === 'trigger' ||
                        text === 'japanese' ||
                        text === 'english' ||
                        text === 'translation'
                    ) {
                        hasKeyHeader = true;
                    }
                });

                if (hasKeyHeader) {
                    headerRowFound = true;
                    totalHeaderCols = ths.length;
                    ths.each((thIdx, thEl) => {
                        const cleanTitle = $(thEl).text().trim();
                        const lowerTitle = cleanTitle.toLowerCase();

                        if (
                            lowerTitle === 'occasion' ||
                            lowerTitle === 'line' ||
                            lowerTitle === 'trigger' ||
                            lowerTitle === 'context' ||
                            lowerTitle === 'situation'
                        ) {
                            occasionColIdx = thIdx;
                        } else if (
                            lowerTitle.includes('audio') ||
                            lowerTitle.includes('file') ||
                            lowerTitle.includes('note') ||
                            lowerTitle.includes('ref') ||
                            lowerTitle.includes('source') ||
                            lowerTitle.includes('disclaimer') ||
                            lowerTitle.includes('proof')
                        ) {
                            // skip
                        } else {
                            dataCols.push({ index: thIdx, title: cleanTitle });
                        }
                    });
                }
            }
        });

        // Fallback defaults
        if (!headerRowFound) {
            totalHeaderCols = 4;
            occasionColIdx = 0;
            dataCols.push({ index: 1, title: 'Japanese' });
            dataCols.push({ index: 2, title: 'English' });
        }

        let replacementHtml = '<div class="dialogue-block">';
        let currentSection = '';
        let currentOccasion = '';

        table.find('tr').each((rowIdx, trEl) => {
            const row = $(trEl);
            const ths = row.find('th');
            const tds = row.find('td');

            // Section header row
            if (ths.length > 0 && tds.length === 0) {
                const headerText = ths.first().text().trim();
                const lowerHeader = headerText.toLowerCase();

                if (
                    lowerHeader.includes('disclaimer') ||
                    lowerHeader.includes('notice') ||
                    lowerHeader.includes('before adding') ||
                    lowerHeader.includes('occasion') ||
                    lowerHeader.includes('japanese') ||
                    lowerHeader.includes('english') ||
                    lowerHeader.includes('translation')
                ) {
                    return;
                }

                currentSection = headerText;
                replacementHtml += `<h3>${currentSection}</h3>`;
                return;
            }

            const cells = row.children();
            if (cells.length < 1) {
                return;
            }

            const hasOccasionInRow = occasionColIdx !== -1 && cells.length >= totalHeaderCols;

            let occasionText = '';
            if (hasOccasionInRow) {
                occasionText = cells.eq(occasionColIdx).text().trim();
                if (occasionText) {
                    currentOccasion = occasionText;
                }
            }

            const lowerOccasion = occasionText.toLowerCase();
            if (lowerOccasion === 'occasion' || lowerOccasion.includes('disclaimer') || lowerOccasion.includes('notice')) {
                return;
            }

            let entryHtml = '';
            dataCols.forEach((col) => {
                const cellIdx = (occasionColIdx !== -1 && !hasOccasionInRow && col.index > occasionColIdx) 
                                ? col.index - 1 
                                : col.index;
                if (cellIdx >= 0 && cellIdx < cells.length) {
                    const cell = cells.eq(cellIdx);
                    const tabber = cell.find('.wds-tabber');
                    if (tabber.length > 0) {
                        const tabs = tabber.find('.wds-tabs__tab-label');
                        const contents = tabber.find('.wds-tab__content');
                        tabs.each((tabIdx, tabEl) => {
                            const tabName = $(tabEl).text().trim();
                            const contentEl = contents.eq(tabIdx);
                            if (contentEl.length > 0) {
                                entryHtml += `<p><strong>${col.title} (${tabName}):</strong><br>${contentEl.html() || ''}</p>`;
                            }
                        });
                    } else {
                        entryHtml += `<p><strong>${col.title}:</strong><br>${cell.html() || ''}</p>`;
                    }
                }
            });

            if (entryHtml) {
                replacementHtml += `
                    <div class="dialogue-entry">
                        <h4>${currentOccasion}</h4>
                        ${entryHtml}
                    </div>
                `;
            }
        });

        replacementHtml += '</div>';
        table.replaceWith(replacementHtml);
    });
}

