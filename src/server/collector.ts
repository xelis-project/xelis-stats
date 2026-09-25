/// <reference types="@cloudflare/workers-types" />

export interface CollectorEnv {
  XELIS_NODE: string;
  DB: D1Database;
  KV: KVNamespace;
}

/**
 * StatsCollector Durable Object:
 * - maintains one outbound WS to the xelis node (reconnect w/ backoff)
 * - tracks live chain state (height, topoheight, mempool)
 * - polls get_info every 30s via alarms as fallback (alarms allow hibernation)
 * - fans out events to browser WS clients via state.getWebSockets(), so
 *   broadcasts survive hibernation and process restarts
 */
const POLL_MS = 30_000;

export class StatsCollector {
  private state: DurableObjectState;
  private env: CollectorEnv;
  private nodeWs: WebSocket | null = null;
  private retry = 0;
  private live = { topoheight: 0, height: 0, stable_topoheight: 0, mempool: 0 };

  constructor(state: DurableObjectState, env: CollectorEnv) {
    this.state = state;
    this.env = env;
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      pair[1].send(JSON.stringify({ type: "hello", ...this.live }));
      this.ensureNodeConnection();
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    // Called by the cron every 2 min so live indexing keeps running even with
    // no browser clients connected: wake the DO, (re)connect the node socket,
    // and run one indexing pass.
    if (url.pathname === "/tick") {
      this.ensureNodeConnection();
      await this.indexNewBlock();
      return new Response("ok");
    }
    return new Response("not found", { status: 404 });
  }

  // Called by the hibernation runtime on client close/error. The client list is
  // read from state at broadcast time, so there is nothing to clean up here.
  async webSocketClose(ws: WebSocket): Promise<void> {
    try { ws.close(1000, "closed"); } catch { /* already closed */ }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try { ws.close(1011, "error"); } catch { /* already closed */ }
  }

  private ensureNodeConnection(): void {
    if (!this.nodeWs || (this.nodeWs.readyState !== 0 && this.nodeWs.readyState !== 1)) {
      this.connectNode();
    }
    this.armPoll();
  }

  private armPoll(): void {
    void this.state.storage.getAlarm().then((at) => {
      if (at == null) return this.state.storage.setAlarm(Date.now() + POLL_MS);
    }).catch(() => { /* best effort */ });
  }

  // Alarm fallback poll; re-arms while there are clients or a node socket.
  async alarm(): Promise<void> {
    await this.pollOnce();
    if (this.state.getWebSockets().length > 0 || this.nodeWs) {
      await this.state.storage.setAlarm(Date.now() + POLL_MS);
    }
  }

  private connectNode(): void {
    const url = new URL(this.env.XELIS_NODE);
    try {
      const ws = new WebSocket(`wss://${url.host}/json_rpc`);
      this.nodeWs = ws;
      ws.addEventListener("open", () => {
        this.retry = 0;
        ws.send(JSON.stringify({
          jsonrpc: "2.0", id: 1,
          method: "subscribe_events",
          params: { events: ["new_block", "new_topoheight", "transaction_added_in_mempool"] },
        }));
      });
      ws.addEventListener("message", (ev) => this.onNodeMessage(String(ev.data)));
      ws.addEventListener("close", () => {
        this.nodeWs = null;
        this.retry = Math.min(this.retry + 1, 6);
        setTimeout(() => this.connectNode(), Math.pow(2, this.retry) * 1000);
      });
      ws.addEventListener("error", () => ws.close());
    } catch {
      this.retry = Math.min(this.retry + 1, 6);
      setTimeout(() => this.connectNode(), Math.pow(2, this.retry) * 1000);
    }
  }

  private onNodeMessage(raw: string): void {
    let msg: {
      method?: string;
      params?: { event?: string; data?: Record<string, unknown> };
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const event = msg.params?.event;
    const data = msg.params?.data ?? {};
    if (event === "new_block" || event === "new_topoheight") {
      if (typeof data.topoheight === "number") this.live.topoheight = data.topoheight;
      if (typeof data.height === "number") this.live.height = data.height;
      this.broadcast({ type: "new_block", ...this.live });
      // incremental indexing: fetch + persist blocks below stable topoheight
      void this.indexNewBlock();
    } else if (event === "transaction_added_in_mempool") {
      this.live.mempool += 1;
    }
  }

  // Persist newly stable blocks into D1 (idempotent). Debounced: at most one
  // fetch in flight; each run indexes up to stable topoheight.
  private indexing = false;
  private async indexNewBlock(): Promise<void> {
    if (this.indexing) return;
    this.indexing = true;
    try {
      const stable = await this.rpc<{ stable_topoheight: number }>("get_info").then((r) => r.stable_topoheight);
      // legacy burn rows predate per-tx burn storage; top them up first so
      // /tx pages show public burn amounts even for old transactions
      await this.backfillBurnAmounts();
      if (!stable) return;
      // find cursor (per-stage checkpoint)
      const row = await this.env.DB.prepare("SELECT cursor FROM sync_state WHERE stage = 'live_blocks'").first<{ cursor: number }>();
      const cursor = row?.cursor ?? 0;
      if (stable <= cursor) return;
      // fetch missing range (capped per tick)
      const from = cursor + 1;
      const to = Math.min(stable, from + 100);
      const res = await this.rpcFetch(`${this.env.XELIS_NODE}/json_rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "get_blocks_range_by_topoheight", params: { start_topoheight: from, end_topoheight: to } }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json = await (res as Response).json() as any;
      const blocks = json?.result as any[] | undefined;
      if (Array.isArray(blocks) && blocks.length) {
        const inserts = blocks.map((b) =>
          this.env.DB.prepare(`INSERT OR REPLACE INTO blocks (topoheight,height,hash,ts,version,nonce,difficulty,size,tx_count,block_type,miner_address,miner_reward,dev_reward,burned,fee_total,cum_difficulty,tips,txs_hashes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .bind(Number(b.topoheight), Number(b.height ?? 0), String(b.hash ?? ""), Number(b.timestamp ?? 0), Number(b.version ?? 0), Number(b.nonce ?? 0), Number(b.difficulty ?? 0), Number(b.total_size_in_bytes ?? 0), (b.txs_hashes ?? []).length, String(b.block_type ?? "normal"), String(b.miner ?? ""), Number(b.miner_reward ?? 0), Number(b.dev_reward ?? 0), Number(b.total_fees_burned ?? 0), Number(b.total_fees ?? 0), String(b.cumulative_difficulty ?? ""), JSON.stringify(b.tips ?? []), JSON.stringify(b.txs_hashes ?? []))
        );
        // hash -> topo routes for point lookups across shard databases
        for (const b of blocks) {
          if (b.hash) inserts.push(this.env.DB.prepare("INSERT OR REPLACE INTO block_route (hash, topoheight) VALUES (?, ?)").bind(String(b.hash), Number(b.topoheight)));
        }
        // also daily aggregates for live continuation
        for (const b of blocks) {
          const day = new Date(Number(b.timestamp)).toISOString().slice(0, 10);
          inserts.push(this.env.DB.prepare(
            `INSERT INTO daily_block_types (date, block_type, count) VALUES (?, ?, 1)
             ON CONFLICT(date, block_type) DO UPDATE SET count = count + 1`).bind(day, String(b.block_type ?? "normal")));
          if (b.miner) {
            const reward = Number(b.miner_reward ?? 0);
            // blocks_found counts every type; side/sync break out the non-normal
            // share for the miners leaderboard columns.
            const bt = String(b.block_type ?? "normal").toLowerCase();
            const side = bt === "side" ? 1 : 0;
            const sync = bt === "sync" ? 1 : 0;
            inserts.push(this.env.DB.prepare(
              `INSERT INTO daily_miners (date, address, blocks_found, rewards_earned, side_count, sync_count) VALUES (?, ?, 1, ?, ?, ?)
               ON CONFLICT(date, address) DO UPDATE SET blocks_found = blocks_found + 1, rewards_earned = rewards_earned + ?, side_count = side_count + ?, sync_count = sync_count + ?`)
              .bind(day, String(b.miner), reward, side, sync, reward, side, sync));
          }
        }
        await this.env.DB.batch(inserts);
        // advance only over data actually written; an empty/failed range must
        // not move the checkpoint (that would create a permanent gap)
        const lastTopo = Number(blocks[blocks.length - 1].topoheight);
        if (Number.isFinite(lastTopo) && lastTopo > cursor) {
          await this.env.DB.prepare(`INSERT INTO sync_state (stage, cursor, updated_at) VALUES ('live_blocks', ?, ?)
            ON CONFLICT(stage) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`)
            .bind(lastTopo, Date.now()).run();
        }
      } else if (stable > cursor) {
        console.error(`indexNewBlock: empty block range ${from}..${to} (stable ${stable}); checkpoint left at ${cursor}`);
      }
      await this.enrichPendingTxs(stable);
    } catch (err) {
      console.error("indexNewBlock:", (err as Error).message);
    } finally {
      this.indexing = false;
    }
  }

  // Transaction enrichment has its own checkpoint ('live_txs') so a blocked or
  // partial detail pass never blocks or corrupts block ingestion.
  private async enrichPendingTxs(upto: number): Promise<void> {
    const cursorRow = await this.env.DB.prepare("SELECT cursor FROM sync_state WHERE stage = 'live_txs'").first<{ cursor: number }>();
    let txCursor = cursorRow?.cursor ?? 0;
    const blocksRes = await this.env.DB.prepare(
      "SELECT topoheight, ts, txs_hashes FROM blocks WHERE tx_count > 0 AND topoheight > ? AND topoheight <= ? ORDER BY topoheight LIMIT 10"
    ).bind(txCursor, upto).all<{ topoheight: number; ts: number; txs_hashes: string }>();
    const blocks = blocksRes.results ?? [];
    if (!blocks.length) return;

    const jobs: Promise<D1PreparedStatement[]>[] = [];
    for (const b of blocks) {
      let hashes: string[] = [];
      try { hashes = JSON.parse(b.txs_hashes ?? "[]") as string[]; } catch { hashes = []; }
      jobs.push(...hashes.map((h) => this.fetchTxRow(h, Number(b.ts), b.topoheight)));
    }
    const results = await Promise.all(jobs.map((p) => p.catch(() => [])));
    const stmts = results.flat();
    if (stmts.length) await this.env.DB.batch(stmts);
    txCursor = blocks[blocks.length - 1].topoheight;
    await this.env.DB.prepare(`INSERT INTO sync_state (stage, cursor, updated_at) VALUES ('live_txs', ?, ?)
      ON CONFLICT(stage) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`)
      .bind(txCursor, Date.now()).run();
  }

  private async fetchTxRow(hash: string, ts: number, blockTopo: number): Promise<D1PreparedStatement[]> {
    const t = await this.rpc<Record<string, unknown>>("get_transaction", { hash });
    const data = (t.data ?? {}) as Record<string, unknown>;
    const known = await this.env.DB.prepare("SELECT 1 FROM tx_index WHERE hash = ?").bind(hash).first();
    if (known) return [];
    let txType = "other";
    let contractId: string | null = null;
    if (data.burn) txType = "burn";
    else if (data.invoke_contract) { txType = "invoke_contract"; contractId = String((data.invoke_contract as Record<string, unknown>).contract ?? "") || null; }
    // contract ids are the TXIDs of their deploy transactions
    else if (data.deploy_contract) { txType = "deploy_contract"; contractId = hash; }
    else if (t.multisig) txType = "multisig";
    else if (data.transfers) txType = "transfer";
    const transfers = Array.isArray(data.transfers) ? (data.transfers as Array<{ asset?: string }>) : [];
    const burn = data.burn as Record<string, unknown> | undefined;
    const burnAmount = burn ? Number(burn.amount ?? 0) : 0;
    const burnAsset = burn && typeof burn.asset === "string" ? burn.asset : (burn ? "" : null);
    const stmts: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `INSERT OR REPLACE INTO tx_index (hash, block_topo, ts, fee, size, tx_type, sender, transfer_count, version, multisig, contract_id, gas, executed, encrypted, burn_amount, burn_asset)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        hash, blockTopo, ts,
        Number(t.fee_paid ?? t.fee ?? 0), Number(t.size ?? 0), txType,
        String(t.source ?? ""), transfers.length, Number(t.version ?? 0),
        t.multisig ? 1 : 0, contractId,
        Number((data.invoke_contract as Record<string, unknown> | undefined)?.max_gas ?? 0),
        t.executed_in_block ? 1 : 0, transfers.length > 0 ? 1 : 0,
        burnAmount, burnAsset
      ),
    ];
    if (blockTopo > 0) {
      stmts.push(this.env.DB.prepare("INSERT OR REPLACE INTO tx_route (hash, block_topo) VALUES (?, ?)").bind(hash, blockTopo));
    }
    for (const tr of transfers) {
      if (tr && typeof tr.asset === "string") {
        stmts.push(this.env.DB.prepare("INSERT OR IGNORE INTO tx_assets (tx_hash, asset) VALUES (?, ?)").bind(hash, tr.asset));
        // register unknown assets (metadata is best-effort)
        if (!(await this.env.DB.prepare("SELECT 1 FROM assets WHERE asset_id = ?").bind(tr.asset).first())) {
          const meta = await this.getAssetMeta(tr.asset);
          stmts.push(this.env.DB.prepare("INSERT OR IGNORE INTO assets (asset_id, name, symbol, decimals, first_seen_topo) VALUES (?, ?, ?, ?, ?)")
            .bind(tr.asset, meta.name, meta.symbol, meta.decimals, blockTopo));
        }
        stmts.push(this.env.DB.prepare(
          `INSERT INTO daily_assets (date, asset_id, tx_count, transfer_count) VALUES (?, ?, 1, 1)
           ON CONFLICT(date, asset_id) DO UPDATE SET tx_count = tx_count + 1, transfer_count = transfer_count + 1`)
          .bind(new Date(ts).toISOString().slice(0, 10), tr.asset));
      }
    }
    // contracts: deploys register the contract; invokes bump stats
    if (txType === "deploy_contract" && contractId) {
      stmts.push(this.env.DB.prepare("INSERT OR IGNORE INTO contracts (contract_id, deployer, deploy_topo, invoke_count, gas_total, events_count) VALUES (?, ?, ?, 0, 0, 0)")
        .bind(contractId, String(t.source ?? ""), blockTopo));
      stmts.push(this.env.DB.prepare(
        `INSERT INTO daily_contracts (date, contract_id, invoke_count, gas_burned, deploys) VALUES (?, ?, 0, 0, 1)
         ON CONFLICT(date, contract_id) DO UPDATE SET deploys = deploys + 1`)
        .bind(new Date(ts).toISOString().slice(0, 10), contractId));
    } else if (txType === "invoke_contract" && contractId) {
      const gas = Number((data.invoke_contract as Record<string, unknown>).max_gas ?? 0);
      stmts.push(this.env.DB.prepare("INSERT OR IGNORE INTO tx_contracts (tx_hash, contract_id, max_gas) VALUES (?, ?, ?)").bind(hash, contractId, gas));
      stmts.push(this.env.DB.prepare(
        `INSERT INTO contracts (contract_id, deployer, deploy_topo, invoke_count, gas_total, events_count) VALUES (?, '', 0, 1, ?, 0)
         ON CONFLICT(contract_id) DO UPDATE SET invoke_count = invoke_count + 1, gas_total = gas_total + ?`)
        .bind(contractId, gas, gas));
      stmts.push(this.env.DB.prepare(
        `INSERT INTO daily_contracts (date, contract_id, invoke_count, gas_burned, deploys) VALUES (?, ?, 1, ?, 0)
         ON CONFLICT(date, contract_id) DO UPDATE SET invoke_count = invoke_count + 1, gas_burned = gas_burned + ?`)
        .bind(new Date(ts).toISOString().slice(0, 10), contractId, gas, gas));
    }
    // burn payload is public: register the burned asset (ids only) so /tx and
    // /account pages can show it alongside the public burn amount
    if (burn && typeof burn.asset === "string" && burn.asset) {
      stmts.push(this.env.DB.prepare("INSERT OR IGNORE INTO tx_assets (tx_hash, asset) VALUES (?, ?)").bind(hash, burn.asset));
      if (!(await this.env.DB.prepare("SELECT 1 FROM assets WHERE asset_id = ?").bind(burn.asset).first())) {
        const meta = await this.getAssetMeta(burn.asset);
        stmts.push(this.env.DB.prepare("INSERT OR IGNORE INTO assets (asset_id, name, symbol, decimals, first_seen_topo) VALUES (?, ?, ?, ?, ?)")
          .bind(burn.asset, meta.name, meta.symbol, meta.decimals, blockTopo));
      }
    }
    if (t.source) {
      const sender = String(t.source);
      stmts.push(this.env.DB.prepare(
        `INSERT INTO accounts (address, first_seen, last_active, tx_count) VALUES (?, ?, ?, 1)
         ON CONFLICT(address) DO UPDATE SET last_active = MAX(last_active, excluded.last_active), tx_count = tx_count + 1`
      ).bind(sender, ts, ts));
      // daily sender rollup: counts + public burn amounts
      stmts.push(this.env.DB.prepare(
        `INSERT INTO daily_address_stats (date, address, tx_count, transfer_outputs, burned) VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(date, address) DO UPDATE SET tx_count = tx_count + 1, transfer_outputs = transfer_outputs + excluded.transfer_outputs, burned = burned + excluded.burned`
      ).bind(new Date(ts).toISOString().slice(0, 10), sender, transfers.length, burnAmount));
    }
    return stmts;
  }

  private async getAssetMeta(assetId: string): Promise<{ name: string; symbol: string; decimals: number }> {
    try {
      const a = await this.rpc<{ name?: string; ticker?: string; decimals?: number }>("get_asset", { asset: assetId });
      return { name: String(a.name ?? ""), symbol: String(a.ticker ?? ""), decimals: Number(a.decimals ?? 8) };
    } catch {
      return { name: "", symbol: "", decimals: 8 };
    }
  }

  // One-time style top-up: legacy burn rows stored no amount (burn payloads are
  // public, but pre-0003 ingest only kept daily rollups). Capped per tick;
  // burns are rare so the queue drains within a few blocks.
  private burnBackfill = false;
  private async backfillBurnAmounts(): Promise<void> {
    if (this.burnBackfill) return;
    this.burnBackfill = true;
    try {
      const rows = await this.env.DB.prepare(
        "SELECT hash FROM tx_index WHERE tx_type = 'burn' AND burn_asset IS NULL LIMIT 10"
      ).all<{ hash: string }>();
      for (const r of rows.results ?? []) {
        try {
          const t = await this.rpc<Record<string, unknown>>("get_transaction", { hash: r.hash });
          const data = (t.data ?? {}) as Record<string, unknown>;
          const burn = data.burn as Record<string, unknown> | undefined;
          if (!burn) continue;
          const amount = Number(burn.amount ?? 0);
          const asset = typeof burn.asset === "string" ? burn.asset : "";
          const stmts: D1PreparedStatement[] = [
            this.env.DB.prepare("UPDATE tx_index SET burn_amount = ?, burn_asset = ? WHERE hash = ?").bind(amount, asset, r.hash),
            this.env.DB.prepare("INSERT OR IGNORE INTO tx_assets (tx_hash, asset) VALUES (?, ?)").bind(r.hash, asset),
          ];
          if (asset && !(await this.env.DB.prepare("SELECT 1 FROM assets WHERE asset_id = ?").bind(asset).first())) {
            const meta = await this.getAssetMeta(asset);
            stmts.push(this.env.DB.prepare("INSERT OR IGNORE INTO assets (asset_id, name, symbol, decimals) VALUES (?, ?, ?, ?)")
              .bind(asset, meta.name, meta.symbol, meta.decimals));
          }
          await this.env.DB.batch(stmts);
        } catch { /* skip this tx; retried on next tick */ }
      }
    } catch (err) {
      console.error("backfillBurnAmounts:", (err as Error).message);
    } finally {
      this.burnBackfill = false;
    }
  }

  private async rpcFetch(url: string, init: RequestInit): Promise<Response> {
    return fetch(url, init);
  }

  private async rpc<T>(method: string, params?: unknown): Promise<T> {
    const res = await this.rpcFetch(`${this.env.XELIS_NODE}/json_rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params !== undefined ? { params } : {}) }),
    });
    const json = (await res.json()) as { result?: T; error?: { message: string } };
    if (json.error) throw new Error(json.error.message);
    return json.result as T;
  }

  private async pollOnce(): Promise<void> {
    try {
      const res = await fetch(`${this.env.XELIS_NODE}/json_rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "get_info" }),
      });
      const json = (await res.json()) as {
        result?: { topoheight: number; height: number; stable_topoheight: number; mempool_size: number };
      };
      if (json.result) {
        this.live.topoheight = json.result.topoheight;
        this.live.height = json.result.height;
        this.live.stable_topoheight = json.result.stable_topoheight;
        this.live.mempool = json.result.mempool_size;
        this.broadcast({ type: "tick", ...this.live });
      }
    } catch {
      // node unreachable; next poll retries
    }
  }

  private broadcast(msg: unknown): void {
    const data = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(data); } catch { /* client gone; runtime cleans up */ }
    }
  }
}
