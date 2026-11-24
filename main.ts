// Pump.fun Bot Sprint — two-leg dip/flow paper bot.
//
// Leg A ("early flow"): buys young coins (<= 60 trades, <= ~16 min old) whose last
// 12 trades are at least 70% buys by SOL volume, while the price sits 1.10x-1.60x
// above its create price. Small set of coins, held for a big move.
// Leg B ("second wind"): buys proven runners that ran >= 2.75x, pulled back >= 12%
// from their peak, then reclaimed >= 97% of it. Cheap breadth filler so the entry
// clears the 20-distinct-mint guardrail; exits fast.
//
// Exits (both legs): take-profit, stop-loss, trailing stop once armed, hard time exit.
// One entry per mint, at most 5 open positions (leg A <= 4, leg B <= 1).
// Deterministic: every decision comes from the harness state and the slot number.
// Paper money only. No network, no clock, no randomness.

import { runBot, LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';
import type { BotState, Batch, Fill } from './vendor/makefun-bot.ts';

// ---- tunables (swept offline on the frozen dev window) ----
const A_SIZE_LAMPORTS = 100_000_000n; // 0.10 SOL
const B_SIZE_LAMPORTS = 20_000_000n; // 0.02 SOL
const MIN_BUY_LAMPORTS = 15_000_000n; // 0.015 SOL: below this the round trip is not worth it
const CASH_RESERVE_LAMPORTS = 500_000_000n; // 0.5 SOL never deployed
const MAX_POSITIONS = 5;
const MAX_A = 4;
const MAX_B = 1;
const SLIPPAGE_BPS = 500;

// Leg A entry
const A_MIN_TRADES = 8;
const A_MAX_TRADES = 60;
const A_MAX_AGE_SLOTS = 2400;
const A_FLOW_WINDOW = 12;
const A_MIN_BUY_SHARE = 0.7; // share of SOL volume that is buys, last 12 trades
const A_MIN_MULT = 1.1; // price vs create price
const A_MAX_MULT = 1.6;
// Leg A exits
const A_TP = 1.5; // +150%
const A_SL = 0.2; // -20%
const A_TRAIL_ARM = 0.5; // trail once +50%
const A_TRAIL_DROP = 0.35; // sell 35% below the post-entry peak
const A_MAX_HOLD_SLOTS = 7200; // ~48 min

// Leg B entry
const B_MIN_TRADES = 8;
const B_RUNUP = 2.75; // peak vs create price
const B_PULLBACK = 0.12; // pulled back >= 12% from the peak
const B_RECLAIM = 0.97; // ...then reclaimed >= 97% of the peak
const B_MIN_MULT = 1.4; // still >= 1.4x create price
// Leg B exits
const B_TP = 0.25; // +25%
const B_SL = 0.08; // -8%
const B_MAX_HOLD_SLOTS = 7200; // ~48 min

interface MintTrack {
  firstPrice: number; // SOL per token at create (or first sight)
  peak: number;
  trades: number;
  lastPrice: number;
  createdSlot: number;
  pulledBack: boolean;
  flow: Array<{ buy: boolean; sol: number }>; // last A_FLOW_WINDOW trades
}

interface OpenTrade {
  mint: string;
  leg: 'A' | 'B';
  entryPrice: number; // SOL per token, cost basis incl. curve fee
  peakPrice: number;
  entrySlot: number;
  tokens: bigint;
}

const tracks = new Map<string, MintTrack>();
const entered = new Set<string>(); // mints already bought once (filled)
const pendingBuys = new Map<string, 'A' | 'B'>(); // client_id -> leg
const pendingBuyMint = new Map<string, string>(); // client_id -> mint
const pendingSells = new Set<string>(); // mints with a sell in flight
const openTrades = new Map<string, OpenTrade>();
let buyCount = 0;
let sellCount = 0;

function priceOf(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualToken === 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

function track(mint: string): MintTrack {
  let t = tracks.get(mint);
  if (t === undefined) {
    t = {
      firstPrice: 0,
      peak: 0,
      trades: 0,
      lastPrice: 0,
      createdSlot: 0,
      pulledBack: false,
      flow: [],
    };
    tracks.set(mint, t);
  }
  return t;
}

function legOpenCount(leg: 'A' | 'B'): number {
  let n = 0;
  for (const t of openTrades.values()) if (t.leg === leg) n++;
  for (const l of pendingBuys.values()) if (l === leg) n++;
  return n;
}

function processFills(fills: Fill[]): void {
  for (const f of fills) {
    if (f.client_id.startsWith('_')) {
      // Harness close (complete / flatten / writeoff): drop our tracking for that mint.
      if (f.side === 'sell') {
        openTrades.delete(f.mint);
        pendingSells.delete(f.mint);
      }
      continue;
    }
    if (f.side === 'buy') {
      const leg = pendingBuys.get(f.client_id);
      pendingBuys.delete(f.client_id);
      pendingBuyMint.delete(f.client_id);
      if (leg === undefined) continue;
      if (f.status !== 'filled') continue; // rejected/failed: mint stays eligible
      const tokens = BigInt(f.token_amount);
      const spent = BigInt(f.quote_lamports);
      if (tokens === 0n || spent === 0n) continue;
      const entryPrice = Number(spent) / Number(tokens);
      openTrades.set(f.mint, {
        mint: f.mint,
        leg,
        entryPrice,
        peakPrice: entryPrice,
        entrySlot: f.slot,
        tokens,
      });
      entered.add(f.mint);
      buyCount++;
    } else {
      // our sell
      pendingSells.delete(f.mint);
      if (f.status === 'filled') openTrades.delete(f.mint);
    }
  }
}

await runBot({
  onBatch(state: BotState, batch: Batch) {
    processFills(batch.fills);

    // Drop tracking for positions the harness closed without a fill we saw.
    for (const mint of [...openTrades.keys()]) {
      if (!state.positions.has(mint)) openTrades.delete(mint);
    }

    // Fold this batch's events into the per-mint tracks.
    for (const e of batch.events) {
      const t = track(e.mint);
      if (e.event === 'CreateEvent') {
        const p = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        if (t.firstPrice === 0) {
          t.firstPrice = p;
          t.createdSlot = e.slot;
        }
        if (p > t.peak) t.peak = p;
        t.lastPrice = p;
      } else if (e.event === 'TradeEvent') {
        const p = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        if (t.firstPrice === 0) {
          t.firstPrice = p;
          t.createdSlot = e.slot;
        }
        if (p > t.peak) t.peak = p;
        t.lastPrice = p;
        t.trades++;
        t.flow.push({ buy: e.is_buy, sol: Number(BigInt(e.sol_amount)) / 1e9 });
        if (t.flow.length > A_FLOW_WINDOW) t.flow.shift();
        if (t.peak > 0 && t.firstPrice > 0 && t.peak / t.firstPrice >= B_RUNUP && p <= t.peak * (1 - B_PULLBACK)) {
          t.pulledBack = true;
        }
      } else {
        // CompleteEvent: the curve is done; nothing to track any more.
      }
    }

    const orders: Array<{ side: 'buy' | 'sell'; client_id?: string; mint: string; quote_lamports?: bigint; token_amount?: bigint; max_slippage_bps: number }> = [];

    // ---- exits first: sell anything that hit TP / SL / trailing / time ----
    for (const [mint, trade] of openTrades) {
      if (pendingSells.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0) continue;
      if (price > trade.peakPrice) trade.peakPrice = price;
      const r = price / trade.entryPrice;
      const tp = trade.leg === 'A' ? A_TP : B_TP;
      const sl = trade.leg === 'A' ? A_SL : B_SL;
      const hold = trade.leg === 'A' ? A_MAX_HOLD_SLOTS : B_MAX_HOLD_SLOTS;
      let sell = false;
      if (r >= 1 + tp) sell = true;
      else if (r <= 1 - sl) sell = true;
      else if (trade.leg === 'A' && trade.peakPrice / trade.entryPrice >= 1 + A_TRAIL_ARM && price <= trade.peakPrice * (1 - A_TRAIL_DROP)) sell = true;
      else if (batch.slot - trade.entrySlot >= hold) sell = true;
      if (!sell) continue;
      const holding = state.positions.get(mint);
      if (holding === undefined || holding.token_amount === 0n) {
        openTrades.delete(mint);
        continue;
      }
      orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: SLIPPAGE_BPS });
      pendingSells.add(mint);
      sellCount++;
    }

    // ---- entries: scan the mints touched by this batch ----
    const openTotal = state.committedPositionCount();
    if (openTotal < MAX_POSITIONS) {
      const seen = new Set<string>();
      for (const e of batch.events) {
        if (openTotal + orders.filter((o) => o.side === 'buy').length >= MAX_POSITIONS) break;
        if (!seen.add(e.mint)) continue;
        const mint = e.mint;
        if (entered.has(mint) || openTrades.has(mint) || pendingBuyMintHas(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const t = tracks.get(mint);
        if (t === undefined || t.firstPrice === 0 || t.trades < A_MIN_TRADES) continue;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (price <= 0) continue;

        let leg: 'A' | 'B' | null = null;
        // Leg A: young coin, buy-dominated flow, price 1.10x-1.60x create.
        if (t.flow.length >= 8 && t.trades <= A_MAX_TRADES && batch.slot - t.createdSlot <= A_MAX_AGE_SLOTS && legOpenCount('A') < MAX_A) {
          let buyVol = 0;
          let totVol = 0;
          for (const f of t.flow) {
            totVol += f.sol;
            if (f.buy) buyVol += f.sol;
          }
          const mult = price / t.firstPrice;
          if (totVol > 0 && buyVol / totVol >= A_MIN_BUY_SHARE && mult >= A_MIN_MULT && mult <= A_MAX_MULT) {
            leg = 'A';
          }
        }
        // Leg B: proven runner, deep pullback, reclaiming its peak.
        if (
          leg === null &&
          t.pulledBack &&
          price >= t.peak * B_RECLAIM &&
          price >= t.firstPrice * B_MIN_MULT &&
          legOpenCount('B') < MAX_B
        ) {
          leg = 'B';
        }
        if (leg === null) continue;

        const want = leg === 'A' ? A_SIZE_LAMPORTS : B_SIZE_LAMPORTS;
        const cap = state.maxBuyLamports(mint);
        const size = want < cap ? want : cap;
        if (size < MIN_BUY_LAMPORTS) continue;
        if (state.freeCashLamports() - size < CASH_RESERVE_LAMPORTS) continue;
        const clientId = state.clientId();
        orders.push({ side: 'buy', client_id: clientId, mint, quote_lamports: size, max_slippage_bps: SLIPPAGE_BPS });
        pendingBuys.set(clientId, leg);
        pendingBuyMint.set(clientId, mint);
      }
    }

    return orders;
  },

  onDone(state: BotState) {
    const cashSol = Number(state.cash) / 1e9;
    console.error(
      `done: buys=${buyCount} sells=${sellCount} open=${openTrades.size} cash=${cashSol.toFixed(4)} SOL`,
    );
  },
});

function pendingBuyMintHas(mint: string): boolean {
  for (const m of pendingBuyMint.values()) if (m === mint) return true;
  return false;
}
