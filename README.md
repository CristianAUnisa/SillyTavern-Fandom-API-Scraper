# Fandom & MediaWiki API Archiver

A standalone command-line interface (CLI) tool designed to dump an entire Fandom or MediaWiki wiki into structured files (JSON, TXT, or MD) for archiving, offline viewing, or RAG (Retrieval-Augmented Generation) applications.

### Important Notice
MediaWiki parsing can take a long time due to rate limiting. If scraping a generic MediaWiki, use lower concurrency (e.g. 2, which is the default) and a higher request delay. For Fandom wikis, you can typically use higher concurrency (e.g. 30, the default).

---

## Installation

1. **Clone the Repository**
   ```bash
   git clone https://github.com/Nidelon/SillyTavern-Fandom-API-Scraper.git
   cd SillyTavern-Fandom-API-Scraper
   ```

2. **Install Dependencies**
   ```bash
   npm install
   ```

3. **Build the CLI App**
   ```bash
   npm run build
   ```

4. **(Optional) Install Globally**
   You can link the command globally to run it from anywhere:
   ```bash
   npm link
   ```
   Once linked, you can execute the command as `fandom-archiver`.

---

## Usage

You can run the script using `node dist/cli.js [options]` (or simply `fandom-archiver [options]` if globally linked).

### Command Options

| Option | Alias | Description | Default |
|---|---|---|---|
| `--wiki <name>` | `-w` | Fandom wiki name (e.g., `fallout` or `community.fandom.com`) | |
| `--url <url>` | `-u` | Generic MediaWiki base URL or endpoint (e.g., `https://minecraft.wiki`) | |
| `--output <path>` | `-o` | Output file or directory path | `<wiki-name>.json` / `<wiki-name>_archive` |
| `--format <format>` | `-f` | Output format: `json`, `txt`, `md` | `json` |
| `--concurrency <num>`| `-c` | Number of concurrent API requests | `30` (Fandom) / `2` (MediaWiki) |
| `--min-delay <ms>` | | Minimum delay in milliseconds between requests | `0` (Fandom) / `100` (MediaWiki) |
| `--max-delay <ms>` | | Maximum delay in milliseconds between requests | `0` (Fandom) / `800` (MediaWiki) |
| `--listing-delay <ms>`| | Delay in milliseconds between page listing API requests | `0` (Fandom) / `200` (MediaWiki) |
| `--filter <regex>` | `-r` | Regular expression to filter page titles (e.g. `^Character:`) | |
| `--lang-filter` | | Force-enable automatic language subpages filtering (e.g., removes `/ru`, `/es`) | True (MediaWiki) / False (Fandom) |
| `--no-lang-filter` | | Disable automatic language subpages filtering | |
| `--help` | `-h` | Display the help menu | |

---

## Examples

### 1. Archive a Fandom Wiki to a Single JSON File
Downloads all pages from `fallout.fandom.com` and saves them in a JSON file:
```bash
node dist/cli.js --wiki fallout
```

### 2. Archive to Markdown Files
Downloads pages from the `community` Fandom wiki and saves each page as a `.md` file inside the `community_notes` directory:
```bash
node dist/cli.js --wiki community --format md -o community_notes
```

### 3. Archive with Specific Title Filter
Scrapes a Fandom wiki, only fetching pages whose titles match `^Character:`:
```bash
node dist/cli.js --wiki community --filter "^Character:" -o characters.json
```

### 4. Archive a Generic MediaWiki Wiki
Scrapes a custom MediaWiki wiki (e.g., Minecraft Wiki) with conservative concurrency and delays to avoid getting rate-limited:
```bash
node dist/cli.js --url https://minecraft.wiki --concurrency 2 --min-delay 200 --max-delay 1000 -o minecraft.json
```

---

## License

AGPLv3

