import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import {
    getFandomApiUrl,
    getMediaWikiApiUrl,
    regexFromString,
    parseWikiUrl,
    resolveApiUrl,
    getApiCache,
} from '../src/utils';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

describe('utils', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getApiCache().clear();
    });

    describe('getFandomApiUrl', () => {
        it('should handle simple wiki names', () => {
            expect(getFandomApiUrl('fallout')).toBe('https://fallout.fandom.com/api.php');
            expect(getFandomApiUrl(' community ')).toBe('https://community.fandom.com/api.php');
        });

        it('should handle full fandom domains', () => {
            expect(getFandomApiUrl('fallout.fandom.com')).toBe('https://fallout.fandom.com/api.php');
            expect(getFandomApiUrl('https://community.fandom.com')).toBe('https://community.fandom.com/api.php');
        });
    });

    describe('getMediaWikiApiUrl', () => {
        it('should append api.php if missing', () => {
            expect(getMediaWikiApiUrl('https://minecraft.wiki')).toBe('https://minecraft.wiki/api.php');
            expect(getMediaWikiApiUrl('https://minecraft.wiki/')).toBe('https://minecraft.wiki/api.php');
        });

        it('should not append api.php if already present', () => {
            expect(getMediaWikiApiUrl('https://minecraft.wiki/w/api.php')).toBe('https://minecraft.wiki/w/api.php');
        });
    });

    describe('regexFromString', () => {
        it('should parse simple string as regex', () => {
            const regex = regexFromString('^Character:');
            expect(regex).toBeInstanceOf(RegExp);
            expect(regex?.source).toBe('^Character:');
        });

        it('should parse regex-like strings with slashes and flags', () => {
            const regex = regexFromString('/^Character:/i');
            expect(regex).toBeInstanceOf(RegExp);
            expect(regex?.source).toBe('^Character:');
            expect(regex?.flags).toBe('i');
        });

        it('should return undefined for invalid regex flags', () => {
            expect(() => regexFromString('/[a-z/invalid')).not.toThrow();
        });
    });

    describe('parseWikiUrl', () => {
        it('should extract title and domain from standard wiki URLs', () => {
            const res = parseWikiUrl('https://fallout.fandom.com/wiki/Vault_111');
            expect(res).toEqual({
                domain: 'fallout.fandom.com',
                pageTitle: 'Vault 111',
                protocol: 'https:',
            });
        });

        it('should extract title and domain from index.php with query string', () => {
            const res = parseWikiUrl('https://minecraft.wiki/w/index.php?title=Creeper&action=edit');
            expect(res).toEqual({
                domain: 'minecraft.wiki',
                pageTitle: 'Creeper',
                protocol: 'https:',
            });
        });

        it('should handle special URL decoded characters', () => {
            const res = parseWikiUrl('https://fallout.fandom.com/wiki/Sole%20Survivor');
            expect(res).toEqual({
                domain: 'fallout.fandom.com',
                pageTitle: 'Sole Survivor',
                protocol: 'https:',
            });
        });

        it('should return null for invalid URLs', () => {
            expect(parseWikiUrl('not-a-url')).toBeNull();
        });
    });

    describe('resolveApiUrl', () => {
        it('should instantly return fandom API URLs without probing', async () => {
            const res = await resolveApiUrl('fallout.fandom.com', 'https:');
            expect(res).toBe('https://fallout.fandom.com/api.php');
            expect(mockedAxios.get).not.toHaveBeenCalled();
        });

        it('should probe and cache valid api.php endpoints for generic wikis', async () => {
            mockedAxios.get.mockImplementationOnce((url: string) => {
                if (url === 'https://minecraft.wiki/w/api.php') {
                    return Promise.resolve({
                        status: 200,
                        data: { query: {} },
                    } as any);
                }
                return Promise.reject(new Error('Not found'));
            });

            const res1 = await resolveApiUrl('minecraft.wiki', 'https:');
            expect(res1).toBe('https://minecraft.wiki/w/api.php');
            expect(mockedAxios.get).toHaveBeenCalledTimes(1);

            const res2 = await resolveApiUrl('minecraft.wiki', 'https:');
            expect(res2).toBe('https://minecraft.wiki/w/api.php');
            expect(mockedAxios.get).toHaveBeenCalledTimes(1);
        });

        it('should try fallback to domain/api.php if candidate 1 fails and candidate 2 succeeds', async () => {
            mockedAxios.get
                .mockRejectedValueOnce(new Error('Fail 1'))
                .mockResolvedValueOnce({
                    status: 200,
                    data: { query: {} },
                } as any);

            const res = await resolveApiUrl('custom.wiki', 'https:');
            expect(res).toBe('https://custom.wiki/api.php');
            expect(mockedAxios.get).toHaveBeenCalledTimes(2);
        });

        it('should fallback to domain/api.php if both probes fail', async () => {
            mockedAxios.get.mockRejectedValue(new Error('Fail all'));

            const res = await resolveApiUrl('broken.wiki', 'https:');
            expect(res).toBe('https://broken.wiki/api.php');
            expect(mockedAxios.get).toHaveBeenCalledTimes(2);
        });
    });
});
