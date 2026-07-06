import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { scrapePage, performScrapePages, performScrape, ScrapeConfig } from '../src/index';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

const mockConfig: ScrapeConfig = {
    concurrency: 1,
    minDelay: 0,
    maxDelay: 0,
    autoFilterLangs: false,
    listingDelay: 0,
};

describe('scraper', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('scrapePage', () => {
        it('should fetch and parse page content correctly', async () => {
            const mockHtml = `
                <div>
                    <h2>Page Title</h2>
                    <div class="portable-infobox">Should be kept</div>
                    <div class="navbox">Should be removed</div>
                    <p>This is a valid scraped page content containing enough character content to easily bypass the minimum text length requirement of 100 characters. Vault 111 is a great starting location in Fallout 4.</p>
                    <script>console.log("removed");</script>
                </div>
            `;

            mockedAxios.get.mockResolvedValueOnce({
                status: 200,
                data: {
                    parse: {
                        text: {
                            '*': mockHtml,
                        },
                    },
                },
            } as any);

            const content = await scrapePage('https://fallout.fandom.com/api.php', 'Test Page', mockConfig);
            expect(content).not.toBeNull();
            expect(content).toContain('This is a valid scraped page content');
            expect(content).toContain('Should be kept');
            expect(content).toContain('::: INFOBOX START :::');
            expect(content).toContain('::: INFOBOX END :::');
            expect(content).not.toContain('Should be removed');
            expect(content).not.toContain('removed');
        });

        it('should return null if parsed content is too short', async () => {
            mockedAxios.get.mockResolvedValueOnce({
                status: 200,
                data: {
                    parse: {
                        text: {
                            '*': '<p>Too short</p>',
                        },
                    },
                },
            } as any);

            const content = await scrapePage('https://fallout.fandom.com/api.php', 'Short Page', mockConfig);
            expect(content).toBeNull();
        });

        it('should handle rate limits (429) and retry', async () => {
            mockedAxios.get
                .mockRejectedValueOnce({
                    response: { status: 429 },
                })
                .mockResolvedValueOnce({
                    status: 200,
                    data: {
                        parse: {
                            text: {
                                '*': '<p>This is a valid scraped page content containing enough character content to easily bypass the minimum text length requirement of 100 characters. Vault 111 is a great starting location in Fallout 4.</p>',
                            },
                        },
                    },
                } as any);

            vi.useFakeTimers();

            const scrapePromise = scrapePage('https://fallout.fandom.com/api.php', 'Retry Page', mockConfig);

            await vi.runAllTimersAsync();

            const content = await scrapePromise;
            expect(content).not.toBeNull();
            expect(content).toContain('Vault 111 is a great starting location');
            
            vi.useRealTimers();
        });

        it('should keep and parse dialogue tables with translation tabs and audio files', async () => {
            const mockHtml = `
                <div>
                    <h2>Dialogue Test</h2>
                    <table class="wikitable dialogue-table" lang="ja">
                        <tbody>
                            <tr>
                                <th colspan="4">Disclaimer: Before adding Translations, please be careful</th>
                            </tr>
                            <tr>
                                <th class="DialogueNoticeHeader">Occasion</th>
                                <th class="DialogueNoticeHeader">Japanese</th>
                                <th class="DialogueNoticeHeader">English</th>
                                <th class="DialogueNoticeHeader">Audio</th>
                            </tr>
                            <tr>
                                <th colspan="4">Summoning</th>
                            </tr>
                            <tr>
                                <th id="Summoned">Summoned</th>
                                <td>ブリュンヒルデ……</td>
                                <td>
                                    <div class="wds-tabber">
                                        <ul class="wds-tabs">
                                            <li class="wds-tabs__tab"><div class="wds-tabs__tab-label">NA</div></li>
                                            <li class="wds-tabs__tab"><div class="wds-tabs__tab-label">TL</div></li>
                                        </ul>
                                        <div class="wds-tab__content">Brynhild...</div>
                                        <div class="wds-tab__content">Brynhildr.</div>
                                    </div>
                                </td>
                                <td>
                                    <audio src="https://static.wikia.nocookie.net/s088_summon.ogg"></audio>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            `;

            mockedAxios.get.mockResolvedValueOnce({
                status: 200,
                data: {
                    parse: {
                        text: {
                            '*': mockHtml,
                        },
                    },
                },
            } as any);

            const content = await scrapePage('https://fallout.fandom.com/api.php', 'Dialogue Page', mockConfig);
            expect(content).not.toBeNull();
            expect(content).toContain('SUMMONING');
            expect(content).toContain('SUMMONED');
            expect(content).toContain('ブリュンヒルデ……');
            expect(content).toContain('English (NA):');
            expect(content).toContain('Brynhild...');
            expect(content).toContain('English (TL):');
            expect(content).toContain('Brynhildr.');
        });
    });

    describe('performScrapePages', () => {
        it('should scrape a list of specific pages', async () => {
            mockedAxios.get.mockResolvedValue({
                status: 200,
                data: {
                    parse: {
                        text: {
                            '*': '<p>This is a valid scraped page content containing enough character content to easily bypass the minimum text length requirement of 100 characters. Vault 111 is a great starting location in Fallout 4.</p>',
                        },
                    },
                },
            } as any);

            const pages = await performScrapePages('https://fallout.fandom.com/api.php', ['Page 1', 'Page 2'], mockConfig);
            expect(pages).toHaveLength(2);
            expect(pages[0].title).toBe('Page 1');
            expect(pages[1].title).toBe('Page 2');
        });
    });

    describe('performScrape', () => {
        it('should fetch list of pages and then scrape them', async () => {
            mockedAxios.get.mockResolvedValueOnce({
                status: 200,
                data: {
                    query: {
                        allpages: [
                            { title: 'Scraped Page 1' },
                            { title: 'Scraped Page 2' },
                        ],
                    },
                },
            } as any);

            mockedAxios.get.mockResolvedValue({
                status: 200,
                data: {
                    parse: {
                        text: {
                            '*': '<p>This is a valid scraped page content containing enough character content to easily bypass the minimum text length requirement of 100 characters. Vault 111 is a great starting location in Fallout 4.</p>',
                        },
                    },
                },
            } as any);

            const pages = await performScrape('https://fallout.fandom.com/api.php', mockConfig);
            expect(pages).toHaveLength(2);
            expect(pages[0].title).toBe('Scraped Page 1');
            expect(pages[1].title).toBe('Scraped Page 2');
        });
    });
});
