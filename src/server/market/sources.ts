export interface Ticker {
  exchange: string;
  url: string;
  market: string;
  last: number;
  bid: number | null;
  ask: number | null;
  high24h: number | null;
  low24h: number | null;
  changePct24h: number | null;
  baseVolume: number;
  quoteVolume: number;
  timestamp: number;
}

export interface MarketAggregate {
  price: number;
  changePct24h: number | null;
  high24h: number | null;
  low24h: number | null;
  totalBaseVolume: number;
  totalQuoteVolume: number;
  bestBid: { exchange: string; price: number } | null;
  bestAsk: { exchange: string; price: number } | null;
  spreadPct: number | null;
  divergencePct: number;
  tickers: Ticker[];
  timestamp: number;
}

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

// MEXC: https://api.mexc.com/api/v3/ticker/24hr?symbol=XELUSDT
async function mexc(): Promise<Ticker> {
  interface MexcTicker {
    priceChangePercent: string; lastPrice: string;
    bidPrice: string; askPrice: string; highPrice: string; lowPrice: string;
    volume: string; quoteVolume: string; closeTime: number;
  }
  const t = await json<MexcTicker>("https://api.mexc.com/api/v3/ticker/24hr?symbol=XELUSDT");
  return {
    exchange: "MEXC",
    url: "https://www.mexc.com/",
    market: "XEL/USDT",
    last: +t.lastPrice,
    bid: +t.bidPrice,
    ask: +t.askPrice,
    high24h: +t.highPrice,
    low24h: +t.lowPrice,
    changePct24h: +t.priceChangePercent * 100,
    baseVolume: +t.volume,
    quoteVolume: +t.quoteVolume,
    timestamp: +t.closeTime,
  };
}

// CoinEx v2: https://api.coinex.com/v2/spot/ticker?market=XELUSDT (period=86400 default)
async function coinex(): Promise<Ticker> {
  interface CoinExResp {
    code: number;
    data: Array<{ last: string; open: string; high: string; low: string; value: string; volume: string; volume_buy: string; volume_sell: string }>;
  }
  const r = await json<CoinExResp>("https://api.coinex.com/v2/spot/ticker?market=XELUSDT");
  const t = r.data[0];
  const open = +t.open;
  return {
    exchange: "CoinEx",
    url: "https://www.coinex.com",
    market: "XEL/USDT",
    last: +t.last,
    bid: null,
    ask: null,
    high24h: +t.high,
    low24h: +t.low,
    changePct24h: open ? ((+t.last - open) / open) * 100 : null,
    baseVolume: +t.volume_buy + +t.volume_sell,
    quoteVolume: +t.value,
    timestamp: Date.now(),
  };
}

// NonKyc: https://nonkyc.io/api/v2/tickers (full list; single-market endpoint returns {})
async function nonkyc(): Promise<Ticker> {
  interface NkTicker {
    base_currency: string; target_currency: string;
    last_price: string; base_volume: string; target_volume: string;
    bid: string; ask: string; high: string; low: string;
  }
  const list = await json<NkTicker[]>("https://nonkyc.io/api/v2/tickers");
  const t = list.find((x) => x.base_currency === "XEL");
  if (!t) throw new Error("NonKyc: XEL market not found");
  return {
    exchange: "NonKyc",
    url: "https://nonkyc.io/",
    market: `${t.base_currency}/${t.target_currency}`,
    last: +t.last_price,
    bid: +t.bid,
    ask: +t.ask,
    high24h: +t.high,
    low24h: +t.low,
    changePct24h: null,
    baseVolume: +t.base_volume,
    quoteVolume: +t.target_volume,
    timestamp: Date.now(),
  };
}

export async function fetchAllTickers(): Promise<Ticker[]> {
  const results = await Promise.allSettled([mexc(), coinex(), nonkyc()]);
  return results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
}

export function aggregate(tickers: Ticker[]): MarketAggregate {
  const live = tickers.filter((t) => t.last > 0);
  const lasts = [...live].map((t) => t.last).sort((a, b) => a - b);
  const price = lasts.length ? lasts[Math.floor(lasts.length / 2)] : 0;
  const bids = live.filter((t) => t.bid !== null && t.bid > 0).sort((a, b) => (b.bid as number) - (a.bid as number));
  const asks = live.filter((t) => t.ask !== null && t.ask > 0).sort((a, b) => (a.ask as number) - (b.ask as number));
  const bestBid = bids.length ? { exchange: bids[0].exchange, price: bids[0].bid as number } : null;
  const bestAsk = asks.length ? { exchange: asks[0].exchange, price: asks[0].ask as number } : null;
  const mid = bestBid && bestAsk ? (bestAsk.price + bestBid.price) / 2 : null;
  const spreadPct = mid ? ((bestAsk!.price - bestBid!.price) / mid) * 100 : null;
  const prices = live.map((t) => t.last);
  const divergencePct = prices.length > 1 ? ((Math.max(...prices) - Math.min(...prices)) / price) * 100 : 0;
  const withChange = live.filter((t) => t.changePct24h !== null && Number.isFinite(t.changePct24h));
  const changePct24h = withChange.length
    ? withChange.reduce((s, t) => s + (t.changePct24h as number) * t.baseVolume, 0) / withChange.reduce((s, t) => s + t.baseVolume, 0)
    : null;
  const highs = live.map((t) => t.high24h).filter((v): v is number => v !== null && Number.isFinite(v));
  const lows = live.map((t) => t.low24h).filter((v): v is number => v !== null && Number.isFinite(v));
  return {
    price,
    changePct24h,
    high24h: highs.length ? Math.max(...highs) : null,
    low24h: lows.length ? Math.min(...lows) : null,
    totalBaseVolume: live.reduce((s, t) => s + t.baseVolume, 0),
    totalQuoteVolume: live.reduce((s, t) => s + t.quoteVolume, 0),
    bestBid,
    bestAsk,
    spreadPct,
    divergencePct,
    tickers: live,
    timestamp: Date.now(),
  };
}
