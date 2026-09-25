import { Hono } from "hono";
import type { Env } from "./app";
import { fetchAllTickers, aggregate, type MarketAggregate } from "./market/sources";

// Collapse concurrent cold-cache requests in the same isolate. The dashboard
// hits /api/market and /api/summary together, and /api/summary itself calls
// this; without de-dup a cold KV entry triggers the upstream exchange fan-out
// two or three times in parallel.
let inflight: Promise<MarketAggregate | null> | null = null;

export async function getMarketCached(env: Env): Promise<MarketAggregate | null> {
  const cacheKey = "market:v1";
  const cached = await env.KV.get<MarketAggregate>(cacheKey, "json");
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const tickers = await fetchAllTickers();
      if (!tickers.length) return null;
      const agg = aggregate(tickers);
      await env.KV.put(cacheKey, JSON.stringify(agg), { expirationTtl: 60 });
      return agg;
    } catch {
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
