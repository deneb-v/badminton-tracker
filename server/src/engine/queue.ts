/**
 * Play-order engine (requirements §4).
 *
 * Pure and deterministic: given the current state of a session it plays the
 * session forward in turns and forms the next matches with the
 * seed → fill → split → relax procedure. No I/O, no clock.
 *
 * One queue for all courts: games aren't tied to a court. Whichever court frees
 * up first takes the next game. The queue is only extended at the end; games
 * already in it are kept, in order.
 *
 * Turns, not times: a court that's free now takes a game at turn 0, a court
 * with a game on it at turn 1, and every game it takes moves it on one turn.
 * Players on court now are free from turn 1. Turns only decide who's free when
 * a game is formed; the output is an order, not a schedule.
 */

export type MatchType = 'singles' | 'doubles';

export interface EnginePlayer {
  id: number;
  level: number;
  /** Matches done + in progress this session. */
  gamesPlayed: number;
  /**
   * Turn the player last came off court: 1 = on court now, 0 = just came off, negative = earlier
   * (lower = rested longer), null = hasn't played.
   */
  lastTurn: number | null;
  /** First turn the player is free: 1 if on court now, else 0. */
  freeTurn: number;
  /** gamesPlayed when they last played two games back-to-back (null = never). */
  lastBackToBackGame?: number | null;
  /** Games since their last level game (defaults to gamesPlayed). See rulesForGame(). */
  sinceLevel?: number;
  /** Games in a row without a rest, up to and including their latest (or current) one. */
  streak?: number;
}

export interface EngineCourt {
  id: number;
  type: MatchType;
  /** A game is on this court now, so its next game is a turn away. */
  busy: boolean;
}

/** Admin game plan: these players take the session's Nth game; open spots are auto-filled. */
export interface PlannedGame {
  gameNo: number;
  ids: number[];
}

/** A game already in the queue, kept as-is and in order ahead of any new ones. */
export interface FixedMatch {
  type: MatchType;
  sideA: number[];
  sideB: number[];
  locked: boolean;
  /** The game-plan slot it was formed from, if any. */
  planNo: number | null;
}

export interface BalanceRules {
  singlesMaxGap: number;
  doublesMaxGap: number;
  intraTeamMaxSpread: number;
  /** How much the limits widen per relaxation round. */
  relaxStep: number;
  /** Every player in a match starts within this many levels of the seed. null = no limit. */
  pairWithin?: number | null;
  /**
   * Level rotation: every Nth game of a player's is a level game (within LEVEL_RANGE), the rest are
   * mixed. null = no rotation, teams are just kept even. See rulesForGame().
   */
  levelEvery?: number | null;
  /** Doubles: strongest partners weakest, the partner spread cap is off, and a wider range is preferred. */
  mixed?: boolean;
}

/** Level games keep everyone within this many levels of the seed. */
export const LEVEL_RANGE = 15;

/** Four players this close in level made a level game (used to count games since one). */
export function isLevelGame(levels: number[]): boolean {
  return Math.max(...levels) - Math.min(...levels) <= LEVEL_RANGE;
}

/** With a level rotation: this player's next game should be a level game. */
export function dueLevelGame(rules: BalanceRules, p: EnginePlayer): boolean {
  return !!rules.levelEvery && (p.sinceLevel ?? p.gamesPlayed) >= rules.levelEvery - 1;
}

/**
 * The rules for one game, decided by its seed (first in the pool). With a level rotation, every
 * `levelEvery`th game of a player's is a level game and the rest are mixed, so strong players help
 * the others along but still get a proper game now and then. A level game needs enough players in
 * the pool near the seed's level; otherwise it's mixed. Singles aren't mixed.
 */
export function rulesForGame(rules: BalanceRules, pool: EnginePlayer[], type: MatchType): BalanceRules {
  if (type === 'singles' || !rules.levelEvery || pool.length === 0) return { ...rules, mixed: false };
  if (wantsLevelGame(rules, pool[0], pool, type)) return { ...rules, pairWithin: LEVEL_RANGE, mixed: false };
  return { ...rules, pairWithin: null, mixed: true };
}

/** Due a level game, and there are enough players in the pool near their level for one. */
function wantsLevelGame(rules: BalanceRules, p: EnginePlayer, pool: EnginePlayer[], type: MatchType): boolean {
  return (
    dueLevelGame(rules, p) &&
    pool.filter((q) => Math.abs(q.level - p.level) <= LEVEL_RANGE).length >= playersNeeded(type)
  );
}

export interface QueueInput {
  players: EnginePlayer[];
  courts: EngineCourt[];
  /** Games already in the queue, in order. New games are added after them. */
  fixed?: FixedMatch[];
  /** Plan slots not yet used by a game in `fixed`. */
  planned?: PlannedGame[];
  /** Session game number the first game in the queue will get (games started so far + 1). */
  nextGameNo?: number;
  rules: BalanceRules;
  /** Queue length to fill up to, per court. */
  maxPerCourt?: number;
  /** Prior partnerships this session, keyed by pairKey(). */
  partnerCounts?: Map<string, number>;
  /** Prior opponent pairings this session, keyed by pairKey(). */
  opponentCounts?: Map<string, number>;
  /** Seed for deterministic tiebreaks (e.g. the session id). */
  seed?: number;
}

export interface PlannedMatch {
  type: MatchType;
  sideA: number[];
  sideB: number[];
  /** Turn the game is expected to start on (0 = the next free court). */
  turn: number;
  /** Came in as a fixed (already queued) game. */
  kept: boolean;
  locked: boolean;
  /** Formed from the admin game plan: the slot's game number. */
  planNo: number | null;
  /** Session game number, if games start in queue order. */
  gameNo: number;
  /** Balance limits had to be relaxed (or were exceeded by an override). Admin-only. */
  unbalanced: boolean;
  /** Singles: level difference. Doubles: team-average difference. */
  gap: number;
}

export const DEFAULT_RULES: BalanceRules = {
  singlesMaxGap: 10,
  doublesMaxGap: 8,
  intraTeamMaxSpread: 25,
  relaxStep: 5,
};

/**
 * Variety weights, in units of one place in the waiting order. Balance comes first (relaxing the
 * limits costs a lot), then even games, then mixing people up.
 */
export const WEIGHTS = {
  repeatPartner: 1.5,
  repeatOpponent: 1,
  /** Any two players who've already shared a court (as partners or opponents), per time. */
  repeatTogether: 0.75,
  /** A player going straight back on to break up a repeat group. */
  backToBack: 2,
  /**
   * Per game beyond two in a row without a rest (a 3rd straight game costs this, a 4th twice it).
   * More than being a game ahead, so someone gets a rest whenever anyone else can play.
   */
  tired: 15,
  /** Per game a pick is ahead of the longest-waiting player: keeps games-played even. */
  gamesAhead: 10,
  /** Per level the forced next match (the leftover four) would be out of balance. */
  leftoverImbalance: 2,
  /** Relaxing the balance limits one more step, weighed against the variety it buys. */
  relaxRound: 10,
  /** Per relax step a player is brought in from outside the pair-within range (stale groups only). */
  widenRange: 1.5,
  /** Per level a match's team gap or partner spread is beyond the group's limits. */
  imbalance: 1,
  /** The exact same match again: both partnerships and all four opponent pairings have happened. */
  rematch: 10,
  /** A foursome whose every pair has shared a court this many times counts as stale. */
  staleTogether: 1,
  /** Mixed games: per level between the strongest and weakest of the four, up to mixSpanCap. */
  mixSpan: 0.4,
  mixSpanCap: 40,
  /** Offer back-to-back swaps at all. */
  allowBackToBack: true,
};
const MAX_BACK_TO_BACK_PER_MATCH = 2;
/** Variety never justifies forcing a next match more than two relax steps out of balance. */
const LOPSIDED_LEFTOVER = 1000;
/** Games a player must play before they can be sent back-to-back again. */
const BACK_TO_BACK_COOLDOWN = 3;
const MAX_DOUBLES_CANDIDATES = 24;

export function pairKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

export function playersNeeded(type: MatchType): number {
  return type === 'singles' ? 2 : 4;
}

export function matchGap(levels: Map<number, number>, sideA: number[], sideB: number[]): number {
  const avg = (ids: number[]) => ids.reduce((s, id) => s + (levels.get(id) ?? 0), 0) / ids.length;
  return Math.abs(avg(sideA) - avg(sideB));
}

export function isWithinRules(
  levels: Map<number, number>,
  sideA: number[],
  sideB: number[],
  rules: BalanceRules,
): boolean {
  const gap = matchGap(levels, sideA, sideB);
  if (sideA.length === 1) return gap <= rules.singlesMaxGap;
  const spread = (ids: number[]) => Math.abs((levels.get(ids[0]) ?? 0) - (levels.get(ids[1]) ?? 0));
  // With a level rotation, strong-with-weak partnerships are the point of mixed games.
  if (rules.levelEvery) return gap <= rules.doublesMaxGap;
  return gap <= rules.doublesMaxGap && Math.max(spread(sideA), spread(sideB)) <= rules.intraTeamMaxSpread;
}

/** Stable pseudo-random tiebreak so the queue doesn't reshuffle on every regeneration. */
function tiebreak(id: number, seed: number): number {
  let h = (id * 2654435761) ^ (seed * 40503);
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Deterministic noise in [0, 0.5) so equally good lineups don't always resolve the same way. */
function jitter(ids: number[], salt: number): number {
  let h = salt >>> 0;
  for (const id of [...ids].sort((a, b) => a - b)) h = tiebreak(id, h);
  return (h % 1000) / 2000;
}

/** Fewest games first, then longest rest (never played = most rested), then tiebreak. */
export function sortByPriority(players: EnginePlayer[], seed = 0): EnginePlayer[] {
  return [...players].sort(
    (a, b) =>
      a.gamesPlayed - b.gamesPlayed ||
      (a.lastTurn ?? -Infinity) - (b.lastTurn ?? -Infinity) ||
      tiebreak(a.id, seed) - tiebreak(b.id, seed),
  );
}

interface Formed {
  sideA: number[];
  sideB: number[];
  gap: number;
  unbalanced: boolean;
}

/** Order-independent key for a set of players, used to exclude a lineup on re-draw. */
export function playerSetKey(ids: number[]): string {
  return [...ids].sort((a, b) => a - b).join(',');
}

export interface VarietyInput {
  partnerCounts?: Map<string, number>;
  opponentCounts?: Map<string, number>;
  /** Players who just came off court, offered only to break up repeats (costed, max 2 a match). */
  justPlayed?: Set<number>;
  /** Players who'd be on their 3rd+ game in a row: games beyond two. */
  tired?: Map<number, number>;
  /** Player sets (playerSetKey) not to form, e.g. the lineup being re-drawn. */
  exclude?: Set<string>;
  /** Varies tie-breaks from one game to the next. */
  salt?: number;
  /**
   * Everyone free now, when exactly two matches' worth are: whoever isn't picked must play each
   * other next (one court with eight players, or two courts starting together).
   */
  forcedNext?: EnginePlayer[];
}

/**
 * Steps 3–6: seed, fill, split, relax. `pool` must already be priority-sorted. Among lineups that
 * fit the balance rules, the cheapest wins: each place skipped in the waiting order costs 1, and
 * repeat partners, repeat opponents, players who've already shared a court and back-to-back games
 * add to it. So the queue keeps mixing people up without letting anyone wait longer than needed.
 */
export function formMatch(
  pool: EnginePlayer[],
  type: MatchType,
  rules: BalanceRules,
  v: VarietyInput = {},
): Formed | null {
  if (pool.length < playersNeeded(type)) return null;
  const partners = v.partnerCounts ?? new Map<string, number>();
  const opponents = v.opponentCounts ?? new Map<string, number>();
  const justPlayed = v.justPlayed ?? new Set<number>();
  const exclude = v.exclude ?? new Set<string>();
  const salt = v.salt ?? 0;
  const [seed, ...rest] = pool;
  const inRange = (p: EnginePlayer, round: number) =>
    rules.pairWithin == null || Math.abs(p.level - seed.level) <= rules.pairWithin + round * rules.relaxStep;
  const pc = (a: number, b: number) => partners.get(pairKey(a, b)) ?? 0;
  const oc = (a: number, b: number) => opponents.get(pairKey(a, b)) ?? 0;
  const b2b = (ids: number[]) => ids.filter((id) => justPlayed.has(id)).length;
  const tired = (ids: number[]) => ids.reduce((n, id) => n + (v.tired?.get(id) ?? 0), 0);
  const ahead = (ps: EnginePlayer[]) => ps.reduce((n, p) => n + Math.max(0, p.gamesPlayed - seed.gamesPlayed), 0);

  /** Cost of the best split of four players: repeats, plus how far it is out of balance. */
  const bestSplit = (f: EnginePlayer[]): number => {
    let best = Infinity;
    for (const [x, y] of [
      [
        [0, 1],
        [2, 3],
      ],
      [
        [0, 2],
        [1, 3],
      ],
      [
        [0, 3],
        [1, 2],
      ],
    ] as const) {
      const [a1, a2, b1, b2] = [f[x[0]], f[x[1]], f[y[0]], f[y[1]]];
      const gap = Math.abs((a1.level + a2.level) / 2 - (b1.level + b2.level) / 2);
      // With a level rotation, wide partnerships are fine; only the team averages count.
      const spread = rules.levelEvery ? 0 : Math.max(Math.abs(a1.level - a2.level), Math.abs(b1.level - b2.level));
      const excess = Math.max(0, gap - rules.doublesMaxGap) + Math.max(0, spread - rules.intraTeamMaxSpread);
      const lopsided =
        gap > rules.doublesMaxGap + 2 * rules.relaxStep || spread > rules.intraTeamMaxSpread + 2 * rules.relaxStep;
      const c =
        WEIGHTS.leftoverImbalance * excess +
        (lopsided ? LOPSIDED_LEFTOVER : 0) +
        WEIGHTS.repeatPartner * (pc(a1.id, a2.id) + pc(b1.id, b2.id)) +
        WEIGHTS.repeatOpponent * (oc(a1.id, b1.id) + oc(a1.id, b2.id) + oc(a2.id, b1.id) + oc(a2.id, b2.id));
      if (c < best) best = c;
    }
    return best;
  };
  /**
   * When exactly four players would be left, they're the next match whatever happens (one court
   * with eight players, or two courts starting together), so their match is scored too.
   */
  const leftoverCost = (four: Set<number>): number => {
    if (type !== 'doubles' || v.forcedNext?.length !== 8) return 0;
    const left = v.forcedNext.filter((p) => !four.has(p.id));
    if (left.length !== 4) return 0;
    let together = 0;
    for (let x = 0; x < 4; x++)
      for (let y = x + 1; y < 4; y++) together += pc(left[x].id, left[y].id) + oc(left[x].id, left[y].id);
    return WEIGHTS.repeatTogether * together + bestSplit(left);
  };

  if (type === 'singles') {
    for (let round = 0; ; round++) {
      const limit = Math.min(rules.singlesMaxGap, rules.pairWithin ?? Infinity) + round * rules.relaxStep;
      let best: (Formed & { cost: number }) | null = null;
      rest.forEach((p, rank) => {
        const gap = Math.abs(p.level - seed.level);
        if (gap > limit || exclude.has(playerSetKey([seed.id, p.id]))) return;
        const met = oc(seed.id, p.id) + pc(seed.id, p.id);
        const cost =
          rank +
          WEIGHTS.gamesAhead * ahead([p]) +
          (WEIGHTS.repeatOpponent + WEIGHTS.repeatTogether) * met +
          WEIGHTS.backToBack * b2b([p.id]) +
          WEIGHTS.tired * tired([p.id]) +
          jitter([seed.id, p.id], salt);
        if (!best || cost < best.cost)
          best = {
            sideA: [seed.id],
            sideB: [p.id],
            gap,
            unbalanced: round > 0,
            cost,
          };
      });
      if (best) {
        const { cost: _cost, ...formed } = best as Formed & { cost: number };
        return formed;
      }
      if (limit >= 100) return null;
    }
  }

  /** Relax steps a player sits beyond the pair-within range at this round (0 = inside it). */
  const outOfRange = (p: EnginePlayer, round: number) =>
    rules.pairWithin == null
      ? 0
      : Math.max(
          0,
          Math.ceil((Math.abs(p.level - seed.level) - rules.pairWithin - round * rules.relaxStep) / rules.relaxStep),
        );

  // The first round that works is weighed against one step looser, so that a slightly less even
  // match can win when the tighter options would mean a repeat group or a lopsided next match.
  // `widen` lets players that many steps outside the pair-within range in, at a cost per step.
  const search = (widen: number) => {
    let found: (Formed & { cost: number }) | null = null;
    let foundRound = -1;
    for (let round = 0; ; round++) {
      const gapLimit = rules.doublesMaxGap + round * rules.relaxStep;
      const spreadLimit = rules.intraTeamMaxSpread + round * rules.relaxStep;
      const cands = rest.filter((p) => inRange(p, round + widen)).slice(0, MAX_DOUBLES_CANDIDATES);
      let best: (Formed & { cost: number }) | null = null;
      const roundCost = WEIGHTS.relaxRound * (foundRound >= 0 ? round - foundRound : 0);

      for (let i = 0; i < cands.length; i++) {
        for (let j = i + 1; j < cands.length; j++) {
          for (let k = j + 1; k < cands.length; k++) {
            const trio = [cands[i], cands[j], cands[k]];
            const four = [seed.id, ...trio.map((p) => p.id)];
            if (exclude.has(playerSetKey(four))) continue;
            const backToBack = b2b(four);
            if (backToBack > MAX_BACK_TO_BACK_PER_MATCH) continue;
            let together = 0;
            for (let x = 0; x < 4; x++)
              for (let y = x + 1; y < 4; y++) together += pc(four[x], four[y]) + oc(four[x], four[y]);
            const base =
              i +
              j +
              k +
              WEIGHTS.gamesAhead * ahead(trio) +
              WEIGHTS.repeatTogether * together +
              WEIGHTS.backToBack * backToBack +
              WEIGHTS.tired * tired(trio.map((p) => p.id)) +
              WEIGHTS.widenRange * trio.reduce((n, p) => n + outOfRange(p, round), 0) +
              leftoverCost(new Set(four)) +
              jitter(four, salt);
            const levels4 = [seed, ...trio].map((p) => p.level);
            const top = Math.max(...levels4);
            const bottom = Math.min(...levels4);
            // The seed partners each of the three in turn.
            for (let p = 0; p < 3; p++) {
              const partner = trio[p];
              const [o1, o2] = trio.filter((_, idx) => idx !== p);
              const gap = Math.abs((seed.level + partner.level) / 2 - (o1.level + o2.level) / 2);
              const spread = Math.max(Math.abs(seed.level - partner.level), Math.abs(o1.level - o2.level));
              if (gap > gapLimit) continue;
              if (rules.mixed) {
                // Strongest partners weakest, against the middle two.
                const pairs = (a: number, b: number) => Math.max(a, b) === top && Math.min(a, b) === bottom;
                if (!pairs(seed.level, partner.level) && !pairs(o1.level, o2.level)) continue;
              } else if (spread > spreadLimit) continue;
              const rematch =
                pc(seed.id, partner.id) > 0 &&
                pc(o1.id, o2.id) > 0 &&
                oc(seed.id, o1.id) > 0 &&
                oc(seed.id, o2.id) > 0 &&
                oc(partner.id, o1.id) > 0 &&
                oc(partner.id, o2.id) > 0;
              const cost =
                base +
                roundCost +
                (rematch ? WEIGHTS.rematch : 0) +
                WEIGHTS.imbalance *
                  (Math.max(0, gap - rules.doublesMaxGap) +
                    (rules.mixed ? 0 : Math.max(0, spread - rules.intraTeamMaxSpread))) +
                WEIGHTS.repeatPartner * (pc(seed.id, partner.id) + pc(o1.id, o2.id)) +
                WEIGHTS.repeatOpponent *
                  (oc(seed.id, o1.id) + oc(seed.id, o2.id) + oc(partner.id, o1.id) + oc(partner.id, o2.id)) +
                gap * 0.01 +
                spread * 0.001 -
                (rules.mixed ? WEIGHTS.mixSpan * Math.min(top - bottom, WEIGHTS.mixSpanCap) : 0);
              if (!best || cost < best.cost) {
                best = {
                  sideA: [seed.id, partner.id],
                  sideB: [o1.id, o2.id],
                  gap,
                  unbalanced: rules.levelEvery ? gap > rules.doublesMaxGap : round > 0,
                  cost,
                };
              }
            }
          }
        }
      }
      if (best && (!found || best.cost < found.cost)) found = best;
      const exhausted =
        gapLimit >= 100 &&
        spreadLimit >= 100 &&
        (rules.pairWithin == null || rules.pairWithin + round * rules.relaxStep >= 100);
      // One looser step is always weighed; more only while every option so far forces a lopsided next match.
      if ((foundRound >= 0 && found!.cost < LOPSIDED_LEFTOVER) || exhausted) break;
      if (found && foundRound < 0) foundRound = round;
    }
    return found;
  };

  let found = search(0);
  // A group that keeps landing together (every pair has already shared a court twice) counts as the
  // pool running short: players up to three steps outside the pair-within range may be brought in.
  if (found && rules.pairWithin != null) {
    const four = [...found.sideA, ...found.sideB];
    let stale = true;
    for (let x = 0; x < 4 && stale; x++)
      for (let y = x + 1; y < 4; y++)
        if (pc(four[x], four[y]) + oc(four[x], four[y]) < WEIGHTS.staleTogether) stale = false;
    if (stale) {
      const wide = search(3);
      if (wide && wide.cost < found.cost) found = wide;
    }
  }
  if (!found) return null;
  const { cost: _cost, ...formed } = found;
  return formed;
}

/**
 * A planned game: `fixed` players are pencilled in; the open spots go to the highest-priority free
 * players closest in level to them (widening in relax steps), then the best-balanced split is taken.
 */
export function formPlanned(
  fixed: EnginePlayer[],
  pool: EnginePlayer[],
  type: MatchType,
  rules: BalanceRules,
): (Formed & { complete: boolean }) | null {
  const need = playersNeeded(type);
  const chosen = fixed.slice(0, need);
  if (chosen.length === 0) return null;
  const target = chosen.reduce((s, p) => s + p.level, 0) / chosen.length;
  const fixedIds = new Set(chosen.map((p) => p.id));
  const free = pool.filter((p) => !fixedIds.has(p.id));
  let relaxed = false;
  if (chosen.length < need) {
    const base = rules.pairWithin ?? rules.intraTeamMaxSpread;
    for (let round = 0; ; round++) {
      const limit = base + round * rules.relaxStep;
      const near = free.filter((p) => Math.abs(p.level - target) <= limit);
      if (near.length >= need - chosen.length || limit >= 100) {
        chosen.push(...near.slice(0, need - chosen.length));
        relaxed = round > 0;
        break;
      }
    }
  }
  if (chosen.length < need) return { sideA: [], sideB: [], gap: 0, unbalanced: false, complete: false };

  const levels = new Map(chosen.map((p) => [p.id, p.level]));
  const ids = chosen.map((p) => p.id);
  const splits: [number[], number[]][] =
    need === 2
      ? [[[ids[0]], [ids[1]]]]
      : [
          [
            [ids[0], ids[1]],
            [ids[2], ids[3]],
          ],
          [
            [ids[0], ids[2]],
            [ids[1], ids[3]],
          ],
          [
            [ids[0], ids[3]],
            [ids[1], ids[2]],
          ],
        ];
  const spread = (s: number[]) => (s.length === 2 ? Math.abs(levels.get(s[0])! - levels.get(s[1])!) : 0);
  const [sideA, sideB] = splits
    .map((sp) => ({
      sp,
      score: matchGap(levels, sp[0], sp[1]) + 0.3 * Math.max(spread(sp[0]), spread(sp[1])),
    }))
    .sort((a, b) => a.score - b.score)[0].sp;
  return {
    sideA,
    sideB,
    gap: matchGap(levels, sideA, sideB),
    unbalanced: relaxed || !isWithinRules(levels, sideA, sideB, rules),
    complete: true,
  };
}

interface SimCourt extends EngineCourt {
  order: number;
  turn: number;
  stuck: boolean;
}

/**
 * Steps 1–6, turn by turn: the queue in play order. Games in `fixed` come first, unchanged; new
 * games are formed after them until the queue holds `maxPerCourt` games per court.
 */
export function generateQueue(input: QueueInput): PlannedMatch[] {
  const { rules, maxPerCourt = 3, seed = 0 } = input;
  const partnerCounts = new Map(input.partnerCounts ?? []);
  const opponentCounts = new Map(input.opponentCounts ?? []);
  const levels = new Map(input.players.map((p) => [p.id, p.level]));
  const players = new Map(input.players.map((p) => [p.id, { ...p }]));
  const courts: SimCourt[] = input.courts.map((c, order) => ({ ...c, order, turn: c.busy ? 1 : 0, stuck: false }));
  const plan = new Map(
    (input.planned ?? [])
      .map((g) => [g.gameNo, g.ids.filter((id) => players.has(id))] as const)
      .filter(([, ids]) => ids.length > 0),
  );
  const target = maxPerCourt * courts.length;
  // Kept games stay first in the queue, in their order; new games go after them.
  const fixed = (input.fixed ?? []).filter((f) => courts.some((c) => c.type === f.type));
  const kept: (PlannedMatch | undefined)[] = fixed.map(() => undefined);
  const pending = fixed.map((f, i) => ({ f, i }));
  const out: PlannedMatch[] = [];
  const nextNo = () => (input.nextGameNo ?? 1) + fixed.length + out.length;

  const assign = (
    court: SimCourt,
    t: number,
    sideA: number[],
    sideB: number[],
    extra: Pick<PlannedMatch, 'gap' | 'unbalanced'> & Partial<Pick<PlannedMatch, 'kept' | 'locked' | 'planNo'>>,
    keptAt?: number,
  ) => {
    for (const id of [...sideA, ...sideB]) {
      const p = players.get(id);
      if (!p) continue;
      if (p.lastTurn === t) p.lastBackToBackGame = p.gamesPlayed;
      p.streak = p.lastTurn === t ? (p.streak ?? 1) + 1 : 1;
      p.gamesPlayed += 1;
      p.freeTurn = Math.max(t + 1, p.freeTurn);
      p.lastTurn = p.freeTurn;
    }
    const level = isLevelGame([...sideA, ...sideB].map((id) => levels.get(id) ?? 0));
    for (const id of [...sideA, ...sideB]) {
      const p = players.get(id);
      if (p) p.sinceLevel = level ? 0 : (p.sinceLevel ?? p.gamesPlayed - 1) + 1;
    }
    for (const side of [sideA, sideB]) {
      if (side.length === 2) {
        const key = pairKey(side[0], side[1]);
        partnerCounts.set(key, (partnerCounts.get(key) ?? 0) + 1);
      }
    }
    for (const a of sideA) {
      for (const b of sideB) opponentCounts.set(pairKey(a, b), (opponentCounts.get(pairKey(a, b)) ?? 0) + 1);
    }
    const m: PlannedMatch = {
      type: court.type,
      sideA,
      sideB,
      turn: t,
      gameNo: keptAt === undefined ? nextNo() : (input.nextGameNo ?? 1) + keptAt,
      kept: false,
      locked: false,
      planNo: null,
      ...extra,
    };
    if (keptAt === undefined) out.push(m);
    else kept[keptAt] = m;
    court.turn = t + 1;
  };


  /** Waits for the next player to come off court; stuck if nobody ever will. */
  const waitForPlayer = (court: SimCourt, t: number) => {
    const next = Math.min(...[...players.values()].map((p) => p.freeTurn).filter((f) => f > t));
    if (Number.isFinite(next)) court.turn = next;
    else court.stuck = true;
  };

  /** Would be on their 3rd game in a row if they played at `t` (or straight off court at t + 1). */
  const wouldBeTired = (p: EnginePlayer, t: number) => p.lastTurn !== null && p.lastTurn >= t && (p.streak ?? 1) >= 2;

  /**
   * A level game for the first of `next` who's due one but can't have it from `pool` (the players
   * free and rested now): them plus the three closest in line within LEVEL_RANGE, including players
   * coming off court next turn. Nobody more than a game ahead of them is pulled in, nor anyone who
   * has had a level game too recently (so level games stay about one in `levelEvery`).
   */
  const holdLevelGame = (next: EnginePlayer[], pool: EnginePlayer[], t: number): EnginePlayer[] | null => {
    for (const p of next) {
      if (!dueLevelGame(rules, p) || wantsLevelGame(rules, p, pool, 'doubles') || wouldBeTired(p, t)) continue;
      const near = [...players.values()].filter(
        (q) =>
          q.id !== p.id &&
          Math.abs(q.level - p.level) <= LEVEL_RANGE &&
          q.freeTurn <= t + 1 &&
          q.gamesPlayed <= p.gamesPlayed + 1 &&
          (q.sinceLevel ?? q.gamesPlayed) >= rules.levelEvery! - 2 &&
          !wouldBeTired(q, t),
      );
      if (near.length < 3) continue;
      // Players due a level game themselves first, then whoever's waited longest.
      const due = (q: EnginePlayer) => (dueLevelGame(rules, q) ? 0 : 1);
      const order = sortByPriority(near, seed);
      order.sort((a, b) => due(a) - due(b));
      return [p, ...order.slice(0, 3)];
    }
    return null;
  };

  const wanted = () => target - fixed.length - out.length;
  // Play the session forward the way the courts do: a free court calls the first kept game whose
  // players are all off court, else the next new game. (Planning kept games as if a court waited
  // for them would book their free players and leave the same few to cycle on the other court.)
  for (let guard = 0; guard < 2000 && (pending.length > 0 || wanted() > 0); guard++) {
    const open = courts.filter((c) => !c.stuck || pending.some(({ f }) => f.type === c.type));
    if (open.length === 0) break;
    open.sort((a, b) => a.turn - b.turn || a.order - b.order);
    const court = open[0];
    const t = court.turn;
    const need = playersNeeded(court.type);

    const k = pending.findIndex(({ f }) => f.type === court.type && [...f.sideA, ...f.sideB].every((id) => (players.get(id)?.freeTurn ?? 0) <= t));
    if (k >= 0) {
      const [{ f, i }] = pending.splice(k, 1);
      assign(
        court,
        t,
        f.sideA,
        f.sideB,
        {
          kept: true,
          locked: f.locked,
          planNo: f.planNo,
          gap: matchGap(levels, f.sideA, f.sideB),
          unbalanced: !isWithinRules(levels, f.sideA, f.sideB, rules),
        },
        i,
      );
      continue;
    }
    if (wanted() <= 0 || court.stuck) {
      // Only blocked kept games are left for this court: wait for their players.
      const before = court.turn;
      waitForPlayer(court, t);
      if (court.turn === before) court.stuck = true;
      if (court.stuck && !open.some((c) => c !== court && !c.stuck)) break;
      continue;
    }

    // The game plan owns this game number (or an earlier one the queue has already passed): wait
    // for the pencilled-in players, then fill around them.
    const due = [...plan.keys()].filter((n) => n <= nextNo()).sort((a, b) => a - b)[0];
    const planIds = due === undefined ? undefined : plan.get(due);
    if (due !== undefined && planIds) {
      const fixedPlayers = planIds.map((id) => players.get(id)!).slice(0, need);
      const readyAt = Math.max(...fixedPlayers.map((p) => p.freeTurn));
      if (readyAt > t) {
        court.turn = readyAt;
        continue;
      }
      const fixedIds = new Set(fixedPlayers.map((p) => p.id));
      const free = [...players.values()].filter((p) => p.freeTurn <= t && !fixedIds.has(p.id));
      const formed = formPlanned(fixedPlayers, sortByPriority(free, seed), court.type, rules);
      if (formed?.complete) {
        plan.delete(due);
        assign(court, t, formed.sideA, formed.sideB, { planNo: due, gap: formed.gap, unbalanced: formed.unbalanced });
      } else {
        waitForPlayer(court, t);
      }
      continue;
    }

    const free = [...players.values()].filter((p) => p.freeTurn <= t);
    if (free.length < need) {
      // Wait for the next player to come off another court.
      waitForPlayer(court, t);
      continue;
    }

    // FR-26: someone who just came off court sits out while others are waiting — except that, to
    // stop the same group cycling (e.g. 8 players on one court), up to two of them may be offered
    // at a cost if they aren't ahead on games and haven't gone back-to-back recently.
    const salt = seed * 7919 + nextNo();
    const isRested = (p: EnginePlayer) => p.lastTurn === null || p.lastTurn < t;
    const rested = free.filter(isRested);
    let pool: EnginePlayer[];
    let justPlayed = new Set<number>();
    if (rested.length >= need && WEIGHTS.allowBackToBack) {
      // With a level rotation, anyone not ahead of the waiting players may be offered, so a rested
      // group of only weaker (or only stronger) players can still be mixed up.
      const cap = rules.levelEvery
        ? Math.max(...rested.map((p) => p.gamesPlayed))
        : Math.min(...rested.map((p) => p.gamesPlayed));
      const eligible = free.filter(
        (p) =>
          !isRested(p) &&
          p.gamesPlayed <= cap &&
          (p.lastBackToBackGame == null || p.gamesPlayed - p.lastBackToBackGame >= BACK_TO_BACK_COOLDOWN),
      );
      justPlayed = new Set(eligible.map((p) => p.id));
      pool = [...sortByPriority(rested, salt), ...sortByPriority(eligible, salt)];
    } else {
      pool = sortByPriority(rested.length >= need ? rested : free, salt);
    }
    // Nobody plays a 3rd game in a row if someone else can: those who would go to the back of the
    // line (so they don't seed), and each game beyond two in a row is costed.
    const tiredBy = new Map<number, number>();
    for (const p of free) if (!isRested(p) && (p.streak ?? 1) >= 2) tiredBy.set(p.id, (p.streak ?? 1) - 1);
    pool = [...pool.filter((p) => !tiredBy.has(p.id)), ...pool.filter((p) => tiredBy.has(p.id))];
    // Someone among the next in line who's due a level game, but whose level-mates are still on
    // court, gets it anyway: the game waits for them to come off (a free court calls a later game
    // meanwhile). Otherwise the strong players, spread across mixed games, would never be free
    // together.
    if (court.type === 'doubles' && rules.levelEvery) {
      const held = holdLevelGame(pool.slice(0, need), pool, t);
      if (held) {
        const ready = Math.max(...held.map((p) => p.freeTurn));
        const formed = formPlanned(held, [], court.type, { ...rules, pairWithin: LEVEL_RANGE })!;
        assign(court, ready, formed.sideA, formed.sideB, { gap: formed.gap, unbalanced: formed.unbalanced });
        continue;
      }
    }
    // Someone among the next in line who's due a level game (and can have one) seeds it.
    if (court.type === 'doubles') {
      const dueIdx = pool.slice(0, need).findIndex((p) => wantsLevelGame(rules, p, pool, court.type));
      if (dueIdx > 0) pool = [pool[dueIdx], ...pool.filter((_, i) => i !== dueIdx)];
    }
    const formed = formMatch(pool, court.type, rulesForGame(rules, pool, court.type), {
      partnerCounts,
      opponentCounts,
      justPlayed,
      tired: tiredBy,
      salt,
      forcedNext: free.length === need * 2 ? free : undefined,
    });
    if (!formed) {
      court.stuck = true;
      continue;
    }
    assign(court, t, formed.sideA, formed.sideB, { gap: formed.gap, unbalanced: formed.unbalanced });
  }

  // Every kept game comes back, in order, even one the simulation couldn't place.
  const keptOut = fixed.map(
    (f, i): PlannedMatch =>
      kept[i] ?? {
        type: f.type,
        sideA: f.sideA,
        sideB: f.sideB,
        turn: -1,
        gameNo: (input.nextGameNo ?? 1) + i,
        kept: true,
        locked: f.locked,
        planNo: f.planNo,
        gap: matchGap(levels, f.sideA, f.sideB),
        unbalanced: !isWithinRules(levels, f.sideA, f.sideB, rules),
      },
  );
  return [...keptOut, ...out];
}
