import { Hono } from "hono";
import type { Env } from "./app";
import { fetchAllTickers, aggregate, type MarketAggregate } from "./market/sources";

export async function getMarketCached(env: Env): Promise<MarketAggregate | null> {
  const cacheKey = "market:v1";
  const cached = await env.KV.get<MarketAggregate>(cacheKey, "json");
  if (cached) return cached;
  try {
    const tickers = await fetchAllTickers();
    if (!tickers.length) return null;
    const agg = aggregate(tickers);
    await env.KV.put(cacheKey, JSON.stringify(agg), { expirationTtl: 60 });
    return agg;
  } catch {
    return null;
  }
}
