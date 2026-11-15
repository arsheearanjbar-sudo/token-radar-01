// Token launch radar: valuation model, board builder, and farm plans.
//
// Everything here is derived from the sealed snapshot's own figures. No
// protocol name is ever special-cased: one scoring function ranks every row,
// and the category multiple each row uses is calibrated from the live-token
// protocols in the same snapshot (median market-cap-to-TVL per category,
// shrunk toward the global median when a category has few live examples).
//
//   multiple   = category median (mcap_usd / tvl_usd) over live protocols,
//                shrunk toward the global median, clamped to [0.08, 1.25]
//   growth     = clamp(change_7d, -50, 150); growthMult = 1 + growth/100 * 0.6
//   maturity   = 0.55 + 0.45 * min(age_days, 1460) / 1460 (unknown age: 365)
//   breadth    = 1 + 0.04 * min(max(chains - 1, 0), 5)
//   implied    = round(tvl_usd * multiple * growthMult * maturity * breadth)
//
// The board ranks every pre-token protocol that is not a wrapped, staked,
// bridged, or exchange product and not a versioned pool, plus every watchlist
// slug unconditionally. Protocols whose token already trades are kept apart
// in the live set, shown with the market's own capitalisation, never ranked.

/** One protocol entry: exactly the ten fields the sealed snapshot carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, stated in the dashboard and in the board rows. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  chain_step: number;
  chain_cap: number;
  multiple_floor: number;
  multiple_cap: number;
  shrink_prior: number;
  fallback_multiple: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.6,
  growth_floor: -50,
  growth_cap: 150,
  maturity_floor: 0.55,
  maturity_range: 0.45,
  maturity_days: 1460,
  unknown_age_days: 365,
  chain_step: 0.04,
  chain_cap: 5,
  multiple_floor: 0.08,
  multiple_cap: 1.25,
  shrink_prior: 4,
  fallback_multiple: 0.25,
};

export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the dashboard's live view carries, by market cap. */
export const LIVE_ROWS = 32;

/** One row of board.json. Extra keys beyond the gate's required five are allowed. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  on_watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    chain_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's row: the board row plus the farm plan, shown verbatim. */
export interface RadarRow extends BoardRow {}

/** A live-token protocol: the market's value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  mcap_tvl: number | null;
  change_7d: number | null;
}

/** One category's calibration: how its multiple was derived. */
export interface CalibrationRow {
  category: string;
  live_count: number;
  median_ratio: number | null;
  multiple: number;
}

/** Everything the dashboard renders. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  global_multiple: number;
  total_implied_usd: number;
  rows: RadarRow[];
  live: LiveRow[];
  calibration: CalibrationRow[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when unknown or unparseable. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Median of a sorted numeric array; null when empty. */
function medianOf(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Calibrate valuation multiples from the snapshot's live-token protocols.
 * For each category, the median market-cap-to-TVL ratio; categories with few
 * live examples are shrunk toward the global median so one outlier cannot
 * set a whole category's price. Returns the global multiple and a lookup.
 */
export function calibrateMultiples(
  snapshot: Snapshot,
  model: ModelConstants,
): { globalMultiple: number; forCategory: (category: string | null) => number; table: CalibrationRow[] } {
  const live = snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
  const globalMedian =
    medianOf(live.map((p) => p.mcap_usd! / p.tvl_usd).sort((a, b) => a - b)) ?? model.fallback_multiple;
  const globalMultiple = clamp(globalMedian, model.multiple_floor, model.multiple_cap);

  const byCategory = new Map<string, number[]>();
  for (const p of live) {
    const key = p.category ?? 'Uncategorised';
    const list = byCategory.get(key) ?? [];
    list.push(p.mcap_usd! / p.tvl_usd);
    byCategory.set(key, list);
  }
  const table: CalibrationRow[] = [];
  const lookup = new Map<string, number>();
  for (const [key, ratios] of [...byCategory.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const med = medianOf([...ratios].sort((a, b) => a - b))!;
    const shrunk = (ratios.length * med + model.shrink_prior * globalMultiple) / (ratios.length + model.shrink_prior);
    const multiple = clamp(shrunk, model.multiple_floor, model.multiple_cap);
    lookup.set(key, multiple);
    table.push({ category: key, live_count: ratios.length, median_ratio: round4(med), multiple: round4(multiple) });
  }
  return {
    globalMultiple,
    forCategory: (category: string | null) => lookup.get(category ?? 'Uncategorised') ?? globalMultiple,
    table,
  };
}

/** The full scoring of one protocol: implied value plus every multiplier. */
export function scoreProtocol(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  categoryMultiple: number,
): { implied: number; growthPct: number; growthMult: number; maturityMult: number; chainMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = typeof protocol.change_7d === 'number' && Number.isFinite(protocol.change_7d) ? protocol.change_7d : 0;
  const growthPct = clamp(rawGrowth, model.growth_floor, model.growth_cap);
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult =
    model.maturity_floor + (clamp(ageForModel, 0, model.maturity_days) / model.maturity_days) * model.maturity_range;
  const extraChains = Math.max(0, protocol.chains.length - 1);
  const chainMult = 1 + model.chain_step * Math.min(extraChains, model.chain_cap);
  const implied = Math.max(
    1,
    Math.min(100_000_000_000_000, Math.round(protocol.tvl_usd * categoryMultiple * growthMult * maturityMult * chainMult)),
  );
  return { implied, growthPct, growthMult, maturityMult, chainMult, age };
}

/** Whether DefiLlama's record shows no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Whether a pre-token protocol may be ranked as an early find: not a wrapped, staked, bridged, or exchange product, and not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

/** The board: every watchlist slug, then every other rankable pre-token protocol, ranked by implied value. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const { forCategory } = calibrateMultiples(snapshot, model);
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }
  const scored = [...chosen.values()].map((p) => {
    const s = scoreProtocol(p, snapshot.as_of, model, forCategory(p.category));
    return { p, ...s, multiple: forCategory(p.category) };
  });
  scored.sort(
    (a, b) => b.implied - a.implied || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0),
  );
  const watchlist = new Set(snapshot.watchlist);
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    on_watchlist: watchlist.has(s.p.slug),
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      // Full precision, deliberately unrounded: the dashboard recomputes
      // this row from the snapshot figures plus this multiple, and the
      // recompute must equal the board's implied value to the dollar.
      category_multiple: s.multiple,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      chain_multiplier: round4(s.chainMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age),
  }));
}

// ---------------------------------------------------------------- farm plans

/** First chain named, or a neutral phrase when the record names none. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** Gas for one ordinary transaction on a chain, in dollars, by chain family. */
function gasUsd(chain: string): number {
  const c = chain.toLowerCase();
  if (c === 'solana' || c === 'sui' || c === 'aptos') return 0.05;
  if (c === 'ethereum') return 8;
  if (['base', 'arbitrum', 'optimism', 'zksync', 'polygon', 'bsc', 'avalanche', 'blast', 'mode', 'linea', 'scroll', 'mantle'].includes(c)) return 0.5;
  return 2;
}

/** Working capital for one farm position, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 200;
  if (p.tvl_usd >= 100_000_000) return 120;
  return 60;
}

/** Minimum hold in days: younger protocols need a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 75;
  if (age < 365) return 60;
  return 45;
}

/** The category's main farming action, in words a reader can follow. */
function mainAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateralised') || c.includes('collateralized')) {
    return `Lend $${capital} of USDC into ${name} on ${chain} and leave the deposit earning; borrow a small amount against it once so both sides of the market record activity.`;
  }
  if (c.includes('dex')) {
    return `Add $${capital} of liquidity to the deepest ${name} pool on ${chain} and keep the LP position open; route one swap a week through the same pool.`;
  }
  if (c.includes('yield aggregator') || c.includes('yield')) {
    return `Deposit $${capital} into the highest-TVL ${name} vault on ${chain} and hold the vault shares; harvest or compound the yield once a week.`;
  }
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('options')) {
    return `Deposit $${capital} of USDC as margin on ${name} on ${chain} and open one small hedged position; close and reopen it weekly rather than leaving it untouched.`;
  }
  if (c.includes('rwa') || c.includes('real world')) {
    return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} through its official mint flow and hold it in the farming wallet.`;
  }
  if (c.includes('risk curator') || c.includes('capital allocator') || c.includes('curator') || c.includes('allocator')) {
    return `Allocate $${capital} to a ${name} curated vault on ${chain} and hold the vault tokens; re-check the curator's allocation note each month.`;
  }
  if (c.includes('basis')) {
    return `Deposit $${capital} into ${name}'s basis vault on ${chain} and hold the position through at least one funding cycle each week.`;
  }
  if (c.includes('staking') || c.includes('restak') || c.includes('liquid')) {
    return `Stake $${capital} through ${name} on ${chain} and keep the liquid staking receipt in the farming wallet; restake or redeposit the rewards weekly.`;
  }
  if (c.includes('bridge')) {
    return `Bridge $${capital} of USDC through ${name} to ${chain} and deploy the bridged funds in the protocol's own app the same day.`;
  }
  if (c.includes('prediction')) {
    return `Fund the farming wallet with $${capital} on ${name} and take one small position in an active market each week.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital} of cover from ${name} on ${chain} for a pool you actually use and keep the policy for the full hold period.`;
  }
  if (c.includes('stable')) {
    return `Mint or buy $${capital} of the ${name} stable asset on ${chain} and hold it in the farming wallet; use it in one of the protocol's own pools.`;
  }
  if (c.includes('privacy') || c.includes('mixer')) {
    return `Run $${capital} through ${name}'s shielded flow on ${chain} in two separate transactions a week apart and keep the receipts.`;
  }
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open; use one more feature of the app, such as a swap, a vote, or a second pool, in the same week.`;
}

/** One farm step as a single string carrying its action, cost, and time. */
function stepText(text: string, cost: string, time: string): string {
  let s = `${text} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 597)}...`;
  if (s.length < 20) s = `${s} Keep the position open and re-check the protocol's own page.`;
  return s;
}

/**
 * A protocol's farm plan: six steps derived from its own record (category,
 * chains, TVL, age). Every step states what it costs and how long it takes.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = chainOf(p);
  const gas = gasUsd(chain);
  const gasText = gas < 1 ? `$${gas.toFixed(2)}` : `$${Math.round(gas)}`;
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const chainsNote = p.chains.length > 1 ? ` Start on ${chain}; the record also counts ${p.chains.length - 1} more chain${p.chains.length - 1 === 1 ? '' : 's'} if gas there is cheaper.` : '';
  return [
    stepText(
      `Open a fresh wallet that holds only farm funds, write its seed phrase on paper and store it offline, then fund it with $${capital} plus gas for ${chain}.${chainsNote}`,
      `about ${gasText} of gas to fund and set up`,
      '10 minutes',
    ),
    stepText(
      mainAction(p, capital, chain),
      `$${capital} of capital plus about ${gasText} of gas`,
      '20 minutes to set up',
    ),
    stepText(
      `Open ${p.name}'s own points, quests, or rewards page from the link the protocol itself publishes and finish one listed quest or task.`,
      `about ${gasText} of gas for the quest transaction`,
      '15 minutes',
    ),
    stepText(
      `Do one real on-chain action every week: a deposit, a swap, a harvest, or a vote, spaced days apart instead of all in one session.`,
      `about ${gasText} of gas a week`,
      '10 minutes a week',
    ),
    stepText(
      `Hold the position for at least ${hold} days so the activity lands in several snapshots; do not withdraw and redeposit the same funds in one day.`,
      `the $${capital} stays locked in the position`,
      `${hold} days`,
    ),
    stepText(
      `Before withdrawing, check the rewards page again and claim only through the protocol's own published link; never pay anyone to claim for you. Log the wallet, dates, and every transaction hash.`,
      `about ${gasText} of gas to claim; never pay a claim fee`,
      '15 minutes',
    ),
  ];
}

// ---------------------------------------------------------------- live set + radar

/** Live-token protocols by market cap, for the dashboard's separate live view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      mcap_tvl: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
      change_7d: p.change_7d,
    }));
}

/** Everything the dashboard needs, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const { globalMultiple, table } = calibrateMultiples(snapshot, model);
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !r.on_watchlist).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    global_multiple: round4(globalMultiple),
    total_implied_usd: board.reduce((n, r) => n + r.implied_value_usd, 0),
    rows: board,
    live,
    calibration: table,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it has the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json protocol ${i} lacks a slug, a name, or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const seen = new Set<string>();
  for (const r of board) {
    if (seen.has(r.slug)) return `slug ${r.slug} appears twice`;
    seen.add(r.slug);
  }
  const missing = snapshot.watchlist.filter((s) => !seen.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug(s): ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2 && board.every((r) => r.implied_value_usd === board[0]!.implied_value_usd)) {
    return 'every row shares one implied value: not a ranking';
  }
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) {
    if (!known.has(r.slug)) return `${r.slug} is not a snapshot protocol`;
    if (typeof r.name !== 'string' || r.name.length === 0) return `${r.slug} has no name`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  return null;
}

/** The dashboard's dataset as one script: no fetch, no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
