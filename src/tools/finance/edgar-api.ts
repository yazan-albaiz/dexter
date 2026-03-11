import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { parseHTML } from 'linkedom';
import { readCache, writeCache } from '../../utils/cache.js';

const SEC_BASE = 'https://data.sec.gov';
const SEC_FILINGS_BASE = 'https://www.sec.gov';
const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const TICKERS_CACHE = join(process.cwd(), '.dexter', 'edgar-tickers.json');
const TICKERS_TTL = 24 * 60 * 60 * 1000; // 24 hours
const USER_AGENT = 'Dexter/1.0 (github.com/dexter-finance)';

/**
 * Returns true when no FINANCIAL_DATASETS_API_KEY is set,
 * meaning we should use SEC EDGAR as the free fallback for filings.
 */
export function useEdgar(): boolean {
  return !process.env.FINANCIAL_DATASETS_API_KEY;
}

// ---------------------------------------------------------------------------
// CIK Lookup
// ---------------------------------------------------------------------------

interface TickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

let tickerCache: Record<string, TickerEntry> | null = null;

async function loadTickerMap(): Promise<Record<string, TickerEntry>> {
  if (tickerCache) return tickerCache;

  // Check file cache
  if (existsSync(TICKERS_CACHE)) {
    try {
      const cached = JSON.parse(readFileSync(TICKERS_CACHE, 'utf-8'));
      if (cached.timestamp && Date.now() - cached.timestamp < TICKERS_TTL) {
        tickerCache = cached.data;
        return tickerCache!;
      }
    } catch {
      // Cache corrupted, re-fetch
    }
  }

  const response = await fetch(TICKERS_URL, {
    headers: { 'User-Agent': USER_AGENT },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch SEC ticker map: ${response.status}`);
  }

  const raw = (await response.json()) as Record<string, TickerEntry>;

  // Index by uppercase ticker for fast lookup
  const byTicker: Record<string, TickerEntry> = {};
  for (const entry of Object.values(raw)) {
    byTicker[entry.ticker.toUpperCase()] = entry;
  }

  // Save to file cache
  const dir = join(process.cwd(), '.dexter');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(TICKERS_CACHE, JSON.stringify({ timestamp: Date.now(), data: byTicker }));

  tickerCache = byTicker;
  return byTicker;
}

export async function getCIK(ticker: string): Promise<string> {
  const map = await loadTickerMap();
  const entry = map[ticker.toUpperCase()];
  if (!entry) throw new Error(`Ticker ${ticker} not found in SEC EDGAR`);
  return String(entry.cik_str).padStart(10, '0');
}

// ---------------------------------------------------------------------------
// Filings Metadata
// ---------------------------------------------------------------------------

interface EdgarFiling {
  accessionNumber: string;
  filingDate: string;
  reportDate: string;
  form: string;
  primaryDocument: string;
  primaryDocDescription: string;
  filingUrl: string;
}

export async function edgarGetFilings(
  ticker: string,
  formTypes: string[] = ['10-K', '10-Q', '8-K'],
  limit: number = 10,
): Promise<EdgarFiling[]> {
  const cacheParams = { ticker, formTypes: formTypes.join(','), limit };
  const cached = readCache('edgar-filings', cacheParams);
  if (cached) return cached.data as unknown as EdgarFiling[];

  const cik = await getCIK(ticker);
  const url = `${SEC_BASE}/submissions/CIK${cik}.json`;

  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
  });

  if (!response.ok) {
    throw new Error(`EDGAR filings fetch failed: ${response.status}`);
  }

  const data = (await response.json()) as any;
  const recent = data.filings?.recent;
  if (!recent) return [];

  const filings: EdgarFiling[] = [];
  const formSet = new Set(formTypes.map((f) => f.toUpperCase()));

  for (let i = 0; i < recent.form.length && filings.length < limit; i++) {
    const form = recent.form[i];
    if (formSet.size > 0 && !formSet.has(form.toUpperCase())) continue;

    const accession = recent.accessionNumber[i].replace(/-/g, '');
    const accessionFormatted = recent.accessionNumber[i];
    const primaryDoc = recent.primaryDocument[i];

    filings.push({
      accessionNumber: accessionFormatted,
      filingDate: recent.filingDate[i],
      reportDate: recent.reportDate[i],
      form,
      primaryDocument: primaryDoc,
      primaryDocDescription: recent.primaryDocDescription?.[i] || '',
      filingUrl: `${SEC_FILINGS_BASE}/Archives/edgar/data/${data.cik}/${accession}/${primaryDoc}`,
    });
  }

  writeCache('edgar-filings', cacheParams, filings as unknown as Record<string, unknown>, url);
  return filings;
}

// ---------------------------------------------------------------------------
// Filing Content
// ---------------------------------------------------------------------------

export async function edgarGetFilingContent(filingUrl: string): Promise<string> {
  const cached = readCache('edgar-filing-content', { url: filingUrl });
  if (cached) return cached.data as unknown as string;

  const response = await fetch(filingUrl, {
    headers: { 'User-Agent': USER_AGENT },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch filing: ${response.status}`);
  }

  const html = await response.text();
  const { document } = parseHTML(html);

  // Remove script and style elements
  for (const el of document.querySelectorAll('script, style, head')) {
    el.remove();
  }

  // Extract text content, preserving structure
  let text = document.body?.textContent || '';

  // Clean up whitespace
  text = text
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();

  // Truncate if very long (SEC filings can be massive)
  const MAX_LENGTH = 100000;
  if (text.length > MAX_LENGTH) {
    text = text.slice(0, MAX_LENGTH) + '\n\n[Content truncated - filing is very long]';
  }

  writeCache('edgar-filing-content', { url: filingUrl }, text as unknown as Record<string, unknown>, filingUrl);
  return text;
}

// ---------------------------------------------------------------------------
// Filing Items (10-K, 10-Q sections)
// ---------------------------------------------------------------------------

export async function edgarGetFilingItems(
  ticker: string,
  filingType: '10-K' | '10-Q' | '8-K',
  items?: string[],
  limit: number = 1,
): Promise<any[]> {
  // Get the most recent filing(s) of this type
  const filings = await edgarGetFilings(ticker, [filingType], limit);

  if (filings.length === 0) {
    return [{ error: `No ${filingType} filings found for ${ticker}` }];
  }

  const results = [];
  for (const filing of filings) {
    const content = await edgarGetFilingContent(filing.filingUrl);

    // If specific items requested, try to extract sections
    if (items && items.length > 0) {
      const sections: Record<string, string> = {};
      for (const item of items) {
        const section = extractSection(content, item);
        sections[item] = section || `Section "${item}" not found in filing.`;
      }
      results.push({
        ticker,
        filing_type: filingType,
        filing_date: filing.filingDate,
        report_date: filing.reportDate,
        url: filing.filingUrl,
        sections,
      });
    } else {
      results.push({
        ticker,
        filing_type: filingType,
        filing_date: filing.filingDate,
        report_date: filing.reportDate,
        url: filing.filingUrl,
        content: content.slice(0, 50000), // Limit content size
      });
    }
  }

  return results;
}

function extractSection(text: string, itemName: string): string | null {
  // Normalize item name for pattern matching
  // Handle formats like "Item-1A", "Item 1A", "ITEM 1A", "Part-1,Item-1"
  const normalized = itemName
    .replace(/-/g, ' ')
    .replace(/,/g, ', ')
    .replace(/Part (\d+)/i, 'PART $1')
    .replace(/Item (\d+)/i, 'ITEM $1');

  // Build regex pattern for the section header
  const patterns = [
    // "Item 1A" or "ITEM 1A." with possible variations
    new RegExp(`(?:^|\\n)\\s*${normalized.replace(/\s+/g, '\\s*')}\\.?[\\s\\-—:]+([\\s\\S]*?)(?=\\n\\s*(?:ITEM|Item)\\s+\\d|$)`, 'i'),
    // Broader match
    new RegExp(`${normalized.replace(/\s+/g, '\\s*')}[.:\\s-]+([\\s\\S]{100,10000}?)(?=\\n\\s*(?:ITEM|Item)\\s+\\d)`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const section = match[1].trim();
      // Return up to 20k chars of the section
      return section.slice(0, 20000);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Insider Trades (Form 4)
// ---------------------------------------------------------------------------

interface InsiderTrade {
  ticker: string;
  issuer: string;
  owner_name: string;
  owner_title: string;
  transaction_date: string;
  transaction_type: string;
  shares: number;
  price_per_share: number | null;
  total_value: number | null;
  shares_owned_after: number | null;
  filing_date: string;
  filing_url: string;
}

export async function edgarGetInsiderTrades(
  ticker: string,
  limit: number = 10,
): Promise<InsiderTrade[]> {
  const cacheParams = { ticker, limit };
  const cached = readCache('edgar-insider-trades', cacheParams);
  if (cached) return cached.data as unknown as InsiderTrade[];

  const cik = await getCIK(ticker);
  const url = `${SEC_BASE}/submissions/CIK${cik}.json`;

  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
  });

  if (!response.ok) {
    throw new Error(`EDGAR insider trades fetch failed: ${response.status}`);
  }

  const data = (await response.json()) as any;
  const recent = data.filings?.recent;
  if (!recent) return [];

  // Find Form 4 filings (insider transaction reports)
  const form4Filings: { accession: string; date: string; url: string }[] = [];
  for (let i = 0; i < recent.form.length && form4Filings.length < limit; i++) {
    if (recent.form[i] === '4') {
      const accession = recent.accessionNumber[i].replace(/-/g, '');
      const primaryDoc = recent.primaryDocument[i];
      form4Filings.push({
        accession: recent.accessionNumber[i],
        date: recent.filingDate[i],
        url: `${SEC_FILINGS_BASE}/Archives/edgar/data/${data.cik}/${accession}/${primaryDoc}`,
      });
    }
  }

  // Parse Form 4 XML/HTML documents
  const trades: InsiderTrade[] = [];
  for (const filing of form4Filings.slice(0, Math.min(limit, 5))) {
    try {
      const trade = await parseForm4(ticker, filing.url, filing.date);
      if (trade) trades.push(...trade);
    } catch {
      // Skip unparseable filings
    }
  }

  writeCache('edgar-insider-trades', cacheParams, trades.slice(0, limit) as unknown as Record<string, unknown>, url);
  return trades.slice(0, limit);
}

async function parseForm4(
  ticker: string,
  filingUrl: string,
  filingDate: string,
): Promise<InsiderTrade[]> {
  const response = await fetch(filingUrl, {
    headers: { 'User-Agent': USER_AGENT },
  });

  if (!response.ok) return [];

  const text = await response.text();
  const trades: InsiderTrade[] = [];

  // Try XML parsing first (most Form 4s are XML)
  if (text.includes('<ownershipDocument') || text.includes('<XML>')) {
    // Extract key fields from XML using regex (avoiding full XML parser dependency)
    const ownerName = extractXmlValue(text, 'rptOwnerName') || 'Unknown';
    const ownerTitle = extractXmlValue(text, 'officerTitle') || '';
    const issuerName = extractXmlValue(text, 'issuerName') || ticker;

    // Find all non-derivative transactions
    const txnPattern = /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi;
    let match;
    while ((match = txnPattern.exec(text)) !== null) {
      const txn = match[1];
      const txnDate = extractXmlValue(txn, 'transactionDate>.*?<value') || filingDate;
      const shares = parseFloat(extractXmlValue(txn, 'transactionShares>.*?<value') || '0');
      const pricePerShare =
        parseFloat(extractXmlValue(txn, 'transactionPricePerShare>.*?<value') || '0') || null;
      const acquiredDisposed =
        extractXmlValue(txn, 'transactionAcquiredDisposedCode>.*?<value') || 'A';
      const sharesAfter =
        parseFloat(extractXmlValue(txn, 'sharesOwnedFollowingTransaction>.*?<value') || '0') ||
        null;

      trades.push({
        ticker,
        issuer: issuerName,
        owner_name: ownerName,
        owner_title: ownerTitle,
        transaction_date: txnDate,
        transaction_type: acquiredDisposed === 'D' ? 'Sale' : 'Purchase',
        shares: acquiredDisposed === 'D' ? -shares : shares,
        price_per_share: pricePerShare,
        total_value: pricePerShare && shares ? Math.abs(shares * pricePerShare) : null,
        shares_owned_after: sharesAfter,
        filing_date: filingDate,
        filing_url: filingUrl,
      });
    }
  }

  // Fallback: parse HTML table if no XML transactions found
  if (trades.length === 0) {
    // Return a basic entry based on what we can extract
    trades.push({
      ticker,
      issuer: ticker,
      owner_name: 'See filing',
      owner_title: '',
      transaction_date: filingDate,
      transaction_type: 'Unknown',
      shares: 0,
      price_per_share: null,
      total_value: null,
      shares_owned_after: null,
      filing_date: filingDate,
      filing_url: filingUrl,
    });
  }

  return trades;
}

function extractXmlValue(xml: string, tagPattern: string): string | null {
  // Handle nested value tags like <transactionShares><value>100</value></transactionShares>
  const pattern = new RegExp(`<${tagPattern}>\\s*([^<]+)`, 'i');
  const match = xml.match(pattern);
  return match ? match[1].trim() : null;
}
