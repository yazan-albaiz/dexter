import YahooFinance from 'yahoo-finance2';
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
import { readCache, writeCache } from '../../utils/cache.js';

/**
 * Returns true when no FINANCIAL_DATASETS_API_KEY is set,
 * meaning we should use Yahoo Finance as the free fallback.
 */
export function useYahooFinance(): boolean {
  return !process.env.FINANCIAL_DATASETS_API_KEY;
}

// ---------------------------------------------------------------------------
// Stock Prices
// ---------------------------------------------------------------------------

export async function yahooGetStockPrice(ticker: string) {
  const quote = await yahooFinance.quote(ticker, {}, { validateResult: false }) as any;
  return {
    ticker: quote.symbol,
    price: quote.regularMarketPrice,
    open: quote.regularMarketOpen,
    high: quote.regularMarketDayHigh,
    low: quote.regularMarketDayLow,
    close: quote.regularMarketPreviousClose,
    volume: quote.regularMarketVolume,
    market_cap: quote.marketCap,
    day_change: quote.regularMarketChange,
    day_change_percent: quote.regularMarketChangePercent,
    fifty_two_week_high: quote.fiftyTwoWeekHigh,
    fifty_two_week_low: quote.fiftyTwoWeekLow,
    time: quote.regularMarketTime,
  };
}

export async function yahooGetStockPrices(
  ticker: string,
  startDate: string,
  endDate: string,
  interval: string = 'day',
) {
  // Check cache first
  const cacheParams = { ticker, startDate, endDate, interval };
  const cached = readCache('yahoo-stock-prices', cacheParams);
  if (cached) return cached.data;

  // Map interval names to Yahoo format
  const intervalMap: Record<string, string> = {
    minute: '1m',
    day: '1d',
    week: '1wk',
    month: '1mo',
    year: '1mo', // Yahoo doesn't have yearly, use monthly
  };

  const result = await yahooFinance.historical(ticker, {
    period1: startDate,
    period2: endDate,
    interval: (intervalMap[interval] || '1d') as any,
  }, { validateResult: false }) as any;

  const prices = result.map((item: any) => ({
    ticker,
    date: item.date instanceof Date ? item.date.toISOString().split('T')[0] : String(item.date),
    open: item.open,
    high: item.high,
    low: item.low,
    close: item.close,
    volume: item.volume,
  }));

  // Cache if end date is in the past
  const now = new Date().toISOString().split('T')[0];
  if (endDate < now) {
    writeCache('yahoo-stock-prices', cacheParams, prices as any, 'yahoo-finance');
  }

  return prices;
}

// ---------------------------------------------------------------------------
// Fundamentals
// ---------------------------------------------------------------------------

async function getQuoteSummary(ticker: string, modules: string[]) {
  return await yahooFinance.quoteSummary(ticker, { modules: modules as any }, { validateResult: false }) as any;
}

export async function yahooGetIncomeStatements(
  ticker: string,
  period: string = 'annual',
  limit: number = 4,
) {
  const cached = readCache('yahoo-income-statements', { ticker, period, limit });
  if (cached) return cached.data;

  const type = period === 'quarterly' ? 'quarterly' : 'annual';
  const raw = await yahooFinance.fundamentalsTimeSeries(ticker, {
    period1: '2020-01-01',
    module: 'financials',
    type,
  }, { validateResult: false }) as any[];

  const statements = raw.slice(0, limit);

  const result = statements.map((s: any) => ({
    ticker,
    report_period: s.date instanceof Date ? s.date.toISOString().split('T')[0] : String(s.date),
    period: type,
    revenue: s.totalRevenue,
    cost_of_revenue: s.costOfRevenue,
    gross_profit: s.grossProfit,
    operating_income: s.operatingIncome,
    net_income: s.netIncome,
    ebitda: s.EBITDA,
    eps_basic: s.basicEPS,
    research_and_development: s.researchAndDevelopment,
    selling_general_and_administrative: s.sellingGeneralAndAdministration,
    interest_expense: s.interestExpense,
    income_tax_expense: s.taxProvision,
  }));

  writeCache('yahoo-income-statements', { ticker, period, limit }, result as any, 'yahoo-finance');
  return result;
}

export async function yahooGetBalanceSheets(
  ticker: string,
  period: string = 'annual',
  limit: number = 4,
) {
  const cached = readCache('yahoo-balance-sheets', { ticker, period, limit });
  if (cached) return cached.data;

  const type = period === 'quarterly' ? 'quarterly' : 'annual';
  const raw = await yahooFinance.fundamentalsTimeSeries(ticker, {
    period1: '2020-01-01',
    module: 'balance-sheet',
    type,
  }, { validateResult: false }) as any[];

  const sheets = raw.slice(0, limit);

  const result = sheets.map((s: any) => ({
    ticker,
    report_period: s.date instanceof Date ? s.date.toISOString().split('T')[0] : String(s.date),
    period: type,
    total_assets: s.totalAssets,
    total_liabilities: s.totalLiabilitiesNetMinorityInterest,
    total_equity: s.stockholdersEquity,
    cash_and_equivalents: s.cashAndCashEquivalents,
    short_term_investments: s.otherShortTermInvestments,
    total_current_assets: s.currentAssets,
    total_current_liabilities: s.currentLiabilities,
    long_term_debt: s.longTermDebt,
    short_term_debt: s.currentDebt,
    retained_earnings: s.retainedEarnings,
    total_debt: s.totalDebt,
    net_cash: (s.cashAndCashEquivalents || 0) - (s.totalDebt || 0),
  }));

  writeCache('yahoo-balance-sheets', { ticker, period, limit }, result as any, 'yahoo-finance');
  return result;
}

export async function yahooGetCashFlowStatements(
  ticker: string,
  period: string = 'annual',
  limit: number = 4,
) {
  const cached = readCache('yahoo-cash-flow', { ticker, period, limit });
  if (cached) return cached.data;

  const type = period === 'quarterly' ? 'quarterly' : 'annual';
  const raw = await yahooFinance.fundamentalsTimeSeries(ticker, {
    period1: '2020-01-01',
    module: 'cash-flow',
    type,
  }, { validateResult: false }) as any[];

  const flows = raw.slice(0, limit);

  const result = flows.map((s: any) => ({
    ticker,
    report_period: s.date instanceof Date ? s.date.toISOString().split('T')[0] : String(s.date),
    period: type,
    operating_cash_flow: s.operatingCashFlow,
    investing_cash_flow: s.investingCashFlow,
    financing_cash_flow: s.financingCashFlow,
    capital_expenditure: s.capitalExpenditure,
    free_cash_flow: s.freeCashFlow,
    dividends_paid: s.cashDividendsPaid,
    share_repurchases: s.repurchaseOfCapitalStock,
    net_change_in_cash: s.changesInCash,
    depreciation_and_amortization: s.depreciationAndAmortization,
  }));

  writeCache('yahoo-cash-flow', { ticker, period, limit }, result as any, 'yahoo-finance');
  return result;
}

export async function yahooGetAllFinancialStatements(
  ticker: string,
  period: string = 'annual',
  limit: number = 4,
) {
  const [income, balance, cashFlow] = await Promise.all([
    yahooGetIncomeStatements(ticker, period, limit),
    yahooGetBalanceSheets(ticker, period, limit),
    yahooGetCashFlowStatements(ticker, period, limit),
  ]);

  return {
    income_statements: income,
    balance_sheets: balance,
    cash_flow_statements: cashFlow,
  };
}

// ---------------------------------------------------------------------------
// Key Ratios / Financial Metrics
// ---------------------------------------------------------------------------

export async function yahooGetKeyRatios(ticker: string) {
  const data = await getQuoteSummary(ticker, [
    'defaultKeyStatistics',
    'financialData',
    'summaryDetail',
  ]);

  const stats = (data as any).defaultKeyStatistics || {};
  const fin = (data as any).financialData || {};
  const summary = (data as any).summaryDetail || {};

  return {
    ticker,
    market_cap: stats.enterpriseValue, // approximate
    pe_ratio: summary.trailingPE,
    forward_pe_ratio: summary.forwardPE,
    ps_ratio: summary.priceToSalesTrailing12Months,
    pb_ratio: summary.priceToBook,
    peg_ratio: stats.pegRatio,
    ev_to_ebitda: stats.enterpriseToEbitda,
    ev_to_revenue: stats.enterpriseToRevenue,
    profit_margin: fin.profitMargins,
    operating_margin: fin.operatingMargins,
    gross_margin: fin.grossMargins,
    return_on_equity: fin.returnOnEquity,
    return_on_assets: fin.returnOnAssets,
    revenue_growth: fin.revenueGrowth,
    earnings_growth: fin.earningsGrowth,
    dividend_yield: summary.dividendYield,
    beta: summary.beta,
    debt_to_equity: fin.debtToEquity,
    current_ratio: fin.currentRatio,
    quick_ratio: fin.quickRatio,
    revenue_per_share: fin.revenuePerShare,
    earnings_per_share: fin.earningsPerShare || stats.trailingEps,
    book_value_per_share: stats.bookValue,
    free_cash_flow_per_share: null, // not directly available as snapshot
    short_ratio: stats.shortRatio,
    shares_outstanding: stats.sharesOutstanding,
    float_shares: stats.floatShares,
  };
}

export async function yahooGetHistoricalKeyRatios(
  ticker: string,
  _period: string = 'annual',
  _limit: number = 4,
) {
  // Yahoo Finance doesn't provide historical time-series of key ratios.
  // Return current snapshot with a note.
  const snapshot = await yahooGetKeyRatios(ticker);
  return {
    note: 'Yahoo Finance only provides current key ratios. For historical time-series ratios, configure FINANCIAL_DATASETS_API_KEY.',
    metrics: [snapshot],
  };
}

// ---------------------------------------------------------------------------
// Analyst Estimates
// ---------------------------------------------------------------------------

export async function yahooGetAnalystEstimates(ticker: string) {
  const data = await getQuoteSummary(ticker, ['earningsTrend', 'financialData']);
  const trend = (data as any).earningsTrend?.trend || [];
  const fin = (data as any).financialData || {};

  const estimates = trend.map((t: any) => ({
    ticker,
    period: t.period,
    end_date: t.endDate,
    eps_estimate_avg: t.earningsEstimate?.avg,
    eps_estimate_low: t.earningsEstimate?.low,
    eps_estimate_high: t.earningsEstimate?.high,
    eps_estimate_count: t.earningsEstimate?.numberOfAnalysts,
    revenue_estimate_avg: t.revenueEstimate?.avg,
    revenue_estimate_low: t.revenueEstimate?.low,
    revenue_estimate_high: t.revenueEstimate?.high,
    revenue_estimate_count: t.revenueEstimate?.numberOfAnalysts,
    growth: t.growth,
  }));

  return {
    estimates,
    target_price: {
      mean: fin.targetMeanPrice,
      low: fin.targetLowPrice,
      high: fin.targetHighPrice,
      median: fin.targetMedianPrice,
      number_of_analysts: fin.numberOfAnalystOpinions,
      recommendation: fin.recommendationKey,
    },
  };
}

// ---------------------------------------------------------------------------
// News
// ---------------------------------------------------------------------------

export async function yahooGetCompanyNews(ticker: string, limit: number = 5) {
  // Yahoo Finance search endpoint for news
  const result = await yahooFinance.search(ticker, { newsCount: limit }, { validateResult: false }) as any;
  const news = (result as any).news || [];

  return news.map((item: any) => ({
    title: item.title,
    url: item.link,
    source: item.publisher,
    published_at: item.providerPublishTime
      ? new Date(item.providerPublishTime * 1000).toISOString()
      : null,
    thumbnail: item.thumbnail?.resolutions?.[0]?.url || null,
  }));
}

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------

export async function yahooGetCryptoPrice(ticker: string) {
  // Yahoo uses format like BTC-USD
  const yahooTicker = ticker.includes('-') ? ticker : `${ticker}-USD`;
  const quote = await yahooFinance.quote(yahooTicker, {}, { validateResult: false }) as any;

  return {
    ticker: quote.symbol,
    price: quote.regularMarketPrice,
    open: quote.regularMarketOpen,
    high: quote.regularMarketDayHigh,
    low: quote.regularMarketDayLow,
    volume: quote.regularMarketVolume,
    market_cap: quote.marketCap,
    day_change: quote.regularMarketChange,
    day_change_percent: quote.regularMarketChangePercent,
    time: quote.regularMarketTime,
  };
}

export async function yahooGetCryptoPrices(
  ticker: string,
  startDate: string,
  endDate: string,
) {
  const yahooTicker = ticker.includes('-') ? ticker : `${ticker}-USD`;

  const cached = readCache('yahoo-crypto-prices', { ticker: yahooTicker, startDate, endDate });
  if (cached) return cached.data;

  const result = await yahooFinance.historical(yahooTicker, {
    period1: startDate,
    period2: endDate,
    interval: '1d' as any,
  }, { validateResult: false }) as any;

  const prices = result.map((item: any) => ({
    ticker: yahooTicker,
    date: item.date instanceof Date ? item.date.toISOString().split('T')[0] : String(item.date),
    open: item.open,
    high: item.high,
    low: item.low,
    close: item.close,
    volume: item.volume,
  }));

  const now = new Date().toISOString().split('T')[0];
  if (endDate < now) {
    writeCache('yahoo-crypto-prices', { ticker: yahooTicker, startDate, endDate }, prices as any, 'yahoo-finance');
  }

  return prices;
}
