import axios from 'axios';

const apiCache = new Map<string, string>();

export function getFandomApiUrl(fandom: string): string {
    try {
        fandom = fandom.trim();
        if (fandom.includes('.')) {
            const url = new URL(
                fandom.startsWith('http') ? fandom : `https://${fandom}`,
            );
            if (url.hostname.endsWith('fandom.com')) {
                return `${url.protocol}//${url.hostname}/api.php`;
            }
        }
        return `https://${fandom}.fandom.com/api.php`;
    } catch (error) {
        return `https://${fandom}.fandom.com/api.php`;
    }
}

export function getMediaWikiApiUrl(urlStr: string): string {
    let url = urlStr.trim();
    if (url.endsWith('/')) url = url.slice(0, -1);
    if (!url.endsWith('api.php')) {
        return `${url}/api.php`;
    }
    return url;
}

export function regexFromString(input: string): RegExp | undefined {
    try {
        const match = input?.match(/(\/?)(.+)\1([a-z]*)/i);
        if (!match) return;
        if (match[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(match[3])) {
            return RegExp(input, 'i');
        }
        return new RegExp(match[2], match[3]);
    } catch {
        return;
    }
}

export function parseWikiUrl(urlStr: string): { domain: string; pageTitle: string; protocol: string } | null {
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
            domain: url.host,
            pageTitle,
            protocol: url.protocol,
        };
    } catch {
        return null;
    }
}

export async function resolveApiUrl(domain: string, protocol: string): Promise<string> {
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

export function getApiCache(): Map<string, string> {
    return apiCache;
}
