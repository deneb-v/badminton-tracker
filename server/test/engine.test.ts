import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RULES,
  EngineCourt,
  EnginePlayer,
  formMatch,
  formPlanned,
  generateQueue,
  playerSetKey,
  rulesForGame,
  sortByPriority,
} from '../src/engine/queue.js';

function player(id: number, level: number, extra: Partial<EnginePlayer> = {}): EnginePlayer {
  return { id, level, gamesPlayed: 0, lastTurn: null, freeTurn: 0, ...extra };
}

function court(id: number, extra: Partial<EngineCourt> = {}): EngineCourt {
  return { id, type: 'doubles', busy: false, ...extra };
}

const levelsOf = (players: EnginePlayer[]) => new Map(players.map((p) => [p.id, p.level]));

describe('sortByPriority', () => {
  it('orders by fewest games, then longest rest, never-played first', () => {
    const sorted = sortByPriority([
      player(1, 50, { gamesPlayed: 2, lastTurn: -2 }),
      player(2, 50, { gamesPlayed: 1, lastTurn: 0 }),
      player(3, 50, { gamesPlayed: 1, lastTurn: -3 }),
      player(4, 50, { gamesPlayed: 1, lastTurn: null }),
    ]);
    expect(sorted.map((p) => p.id)).toEqual([4, 3, 2, 1]);
  });
});

describe('formMatch', () => {
  it('singles: picks the highest-priority opponent within N', () => {
    const pool = [player(1, 50), player(2, 80), player(3, 58), player(4, 55)];
    const m = formMatch(pool, 'singles', DEFAULT_RULES)!;
    expect(m.sideA).toEqual([1]);
    expect(m.sideB).toEqual([3]);
    expect(m.unbalanced).toBe(false);
  });

  it('singles: relaxes and flags when nobody is within N', () => {
    const m = formMatch([player(1, 20), player(2, 45), player(3, 90)], 'singles', DEFAULT_RULES)!;
    expect(m.sideB).toEqual([2]);
    expect(m.unbalanced).toBe(true);
  });

  it('doubles: seed always plays, averages within M, intra-team spread capped', () => {
    const pool = [player(1, 90), player(2, 10), player(3, 50), player(4, 85), player(5, 80), player(6, 88)];
    const m = formMatch(pool, 'doubles', DEFAULT_RULES)!;
    const ids = [...m.sideA, ...m.sideB];
    expect(ids).toContain(1);
    expect(m.unbalanced).toBe(false);
    const lv = levelsOf(pool);
    for (const side of [m.sideA, m.sideB]) {
      expect(Math.abs(lv.get(side[0])! - lv.get(side[1])!)).toBeLessThanOrEqual(25);
    }
    expect(m.gap).toBeLessThanOrEqual(8);
  });

  it('doubles: rejects 90+10 vs 50+50 even though averages match', () => {
    const pool = [player(1, 90), player(2, 10), player(3, 50), player(4, 50)];
    const m = formMatch(pool, 'doubles', DEFAULT_RULES)!;
    // Only 4 players, so it must relax — and it flags it.
    expect(m.unbalanced).toBe(true);
    expect(m.sideA).toContain(1);
  });

  it('doubles: avoids repeating a partnership when an equal alternative exists', () => {
    const pool = [player(1, 50), player(2, 50), player(3, 50), player(4, 50)];
    const first = formMatch(pool, 'doubles', DEFAULT_RULES)!;
    const counts = new Map([[`${Math.min(...first.sideA)}-${Math.max(...first.sideA)}`, 1]]);
    const second = formMatch(pool, 'doubles', DEFAULT_RULES, { partnerCounts: counts })!;
    expect(second.sideA.sort()).not.toEqual(first.sideA.sort());
  });

  it('returns null when there are not enough players', () => {
    expect(formMatch([player(1, 50), player(2, 50), player(3, 50)], 'doubles', DEFAULT_RULES)).toBeNull();
  });
});

describe('generateQueue', () => {
  const base = { rules: DEFAULT_RULES };

  it('spreads games evenly across a session', () => {
    const players = Array.from({ length: 10 }, (_, i) => player(i + 1, 40 + i * 3));
    const q = generateQueue({ ...base, players, courts: [court(1), court(2)], maxPerCourt: 5 });
    expect(q).toHaveLength(10);
    const games = new Map<number, number>();
    for (const m of q) for (const id of [...m.sideA, ...m.sideB]) games.set(id, (games.get(id) ?? 0) + 1);
    const counts = [...games.values()];
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    expect(games.size).toBe(10);
  });

  it('never double-books a player in the same turn', () => {
    const players = Array.from({ length: 9 }, (_, i) => player(i + 1, 50));
    const q = generateQueue({ ...base, players, courts: [court(1), court(2)] });
    for (const a of q) {
      for (const b of q) {
        if (a === b || a.turn !== b.turn) continue;
        const overlap = [...a.sideA, ...a.sideB].filter((id) => [...b.sideA, ...b.sideB].includes(id));
        expect(overlap).toEqual([]);
      }
    }
  });

  it('does not put anyone back-to-back while others are waiting (FR-26)', () => {
    const players = Array.from({ length: 6 }, (_, i) => player(i + 1, 50));
    const q = generateQueue({ ...base, players, courts: [court(1, { type: 'singles' })], maxPerCourt: 3 });
    for (let i = 1; i < q.length; i++) {
      const prev = [...q[i - 1].sideA, ...q[i - 1].sideB];
      const cur = [...q[i].sideA, ...q[i].sideB];
      expect(cur.filter((id) => prev.includes(id))).toEqual([]);
    }
  });

  it('the first game is for the free court and keeps players on court out of it', () => {
    const onCourt = { freeTurn: 1, lastTurn: 1, gamesPlayed: 1 };
    const players = [
      ...[1, 2, 3, 4].map((id) => player(id, 50, onCourt)),
      ...[5, 6, 7, 8, 9, 10, 11, 12].map((id) => player(id, 50)),
    ];
    const q = generateQueue({ ...base, players, courts: [court(1, { busy: true }), court(2)], maxPerCourt: 2 });
    expect(q[0].turn).toBe(0);
    expect([...q[0].sideA, ...q[0].sideB].some((id) => id <= 4)).toBe(false);
    expect(q[1].turn).toBe(1);
  });

  it('rests someone who has played two in a row, even ahead of fairness on games', () => {
    // 1–4 just came off their 2nd game in a row but are a game behind; 5 and 6 are rested.
    const players = [
      ...[1, 2, 3, 4].map((id) => player(id, 50, { gamesPlayed: 1, lastTurn: 0, streak: 2 })),
      player(5, 50, { gamesPlayed: 2, lastTurn: -1, streak: 1 }),
      player(6, 50, { gamesPlayed: 2, lastTurn: -1, streak: 1 }),
    ];
    const q = generateQueue({ ...base, players, courts: [court(1)], maxPerCourt: 1 });
    expect([...q[0].sideA, ...q[0].sideB]).toEqual(expect.arrayContaining([5, 6]));
  });

  it('prioritises a late arrival for the next slot (FR-12)', () => {
    const players = [
      ...Array.from({ length: 8 }, (_, i) =>
        player(i + 1, 50, { gamesPlayed: 2, lastTurn: -1 }),
      ),
      player(99, 50),
    ];
    const q = generateQueue({ ...base, players, courts: [court(1)] });
    expect([...q[0].sideA, ...q[0].sideB]).toContain(99);
  });

  it('keeps queued games first and in order, flagging one out of balance, and adds new games after', () => {
    const players = Array.from({ length: 12 }, (_, i) => player(i + 1, 50));
    players[0] = player(1, 90);
    players[1] = player(2, 10);
    const fixed = [
      { type: 'doubles' as const, sideA: [5, 6], sideB: [7, 8], locked: false, planNo: null },
      { type: 'doubles' as const, sideA: [1, 2], sideB: [3, 4], locked: true, planNo: null },
    ];
    const q = generateQueue({ ...base, players, courts: [court(1), court(2)], fixed, maxPerCourt: 2 });
    expect(q).toHaveLength(4);
    expect(q[0]).toMatchObject({ kept: true, locked: false, sideA: [5, 6], sideB: [7, 8], unbalanced: false });
    expect(q[1]).toMatchObject({ kept: true, locked: true, sideA: [1, 2], sideB: [3, 4], unbalanced: true });
    expect(q.slice(2).every((m) => !m.kept)).toBe(true);
    // The two kept games run first, so 9–12 are next.
    expect([...q[2].sideA, ...q[2].sideB].sort((a, b) => a - b)).toEqual([9, 10, 11, 12]);
  });

  it('waits for players on another court rather than giving up', () => {
    const players = [
      ...Array.from({ length: 4 }, (_, i) => player(i + 1, 50, { freeTurn: 1, gamesPlayed: 1, lastTurn: 1 })),
      player(5, 50),
      player(6, 50),
    ];
    const q = generateQueue({
      ...base,
      players,
      courts: [court(1, { busy: true }), court(2)],
      maxPerCourt: 1,
    });
    expect(q).toHaveLength(2);
    // Only 5 and 6 are free now, so even the free court's game waits for players to come off.
    expect(q[0].turn).toBeGreaterThanOrEqual(1);
  });

  it('forms singles and doubles games for a mixed session', () => {
    const players = Array.from({ length: 12 }, (_, i) => player(i + 1, 50));
    const q = generateQueue({
      ...base,
      players,
      courts: [court(1, { type: 'doubles' }), court(2, { type: 'singles' })],
      maxPerCourt: 1,
    });
    expect(q.find((m) => m.type === 'doubles')!.sideA).toHaveLength(2);
    expect(q.find((m) => m.type === 'singles')!.sideA).toHaveLength(1);
  });

  it('is fast for a full session', () => {
    const players = Array.from({ length: 30 }, (_, i) => player(i + 1, (i * 37) % 100));
    const t0 = performance.now();
    generateQueue({ ...base, players, courts: [court(1), court(2), court(3)], maxPerCourt: 4 });
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe('pair within (session range)', () => {
  it('keeps everyone within range of the seed, widening only when the pool runs short', () => {
    const pool = [player(1, 50), player(2, 90), player(3, 85), player(4, 55), player(5, 58), player(6, 47)];
    const loose = formMatch(pool, 'doubles', { ...DEFAULT_RULES, doublesMaxGap: 100, intraTeamMaxSpread: 100 })!;
    expect([...loose.sideA, ...loose.sideB]).toContain(2); // no range: 90 is the next in line
    const tight = formMatch(pool, 'doubles', { ...DEFAULT_RULES, pairWithin: 10 })!;
    expect([...tight.sideA, ...tight.sideB].sort()).toEqual([1, 4, 5, 6]);
    expect(tight.unbalanced).toBe(false);

    const short = formMatch([player(1, 50), player(2, 90), player(3, 85), player(4, 55)], 'doubles', {
      ...DEFAULT_RULES,
      pairWithin: 10,
    })!;
    expect(short.unbalanced).toBe(true);
  });
});

describe('level rotation', () => {
  const rules = { ...DEFAULT_RULES, levelEvery: 3 };
  // Session 8's levels: three strong, one upper-middle, the rest weaker.
  const levels = [80, 80, 80, 65, 50, 50, 50, 40, 35, 35, 30, 10];
  const group = () => levels.map((level, i) => player(i + 1, level));

  it('every 3rd game of a player is a level game, the rest are mixed; singles never mix', () => {
    const pool = (seed: EnginePlayer) => [seed, ...group().slice(1)];
    expect(rulesForGame(rules, pool(player(1, 80, { gamesPlayed: 2 })), 'doubles')).toMatchObject({ mixed: false, pairWithin: 15 });
    expect(rulesForGame(rules, pool(player(1, 80, { gamesPlayed: 5, sinceLevel: 2 })), 'doubles').mixed).toBe(false);
    expect(rulesForGame(rules, pool(player(1, 80, { gamesPlayed: 5, sinceLevel: 1 })), 'doubles')).toMatchObject({ mixed: true, pairWithin: null });
    expect(rulesForGame(rules, pool(player(1, 80)), 'singles').mixed).toBe(false);
    expect(rulesForGame(DEFAULT_RULES, pool(player(1, 80)), 'doubles').mixed).toBe(false);
  });

  it('a level game that nobody is near enough for is played mixed instead', () => {
    const pool = [player(12, 10, { gamesPlayed: 2 }), ...group().slice(0, 11)];
    expect(rulesForGame(rules, pool, 'doubles').mixed).toBe(true);
  });

  it('a level game waits for level-mates still on court, instead of falling back to mixed', () => {
    // Tony (due a level game) is free; Jason, the other 80, comes off court next turn.
    const players = group().map((p) => ({ ...p, gamesPlayed: 2, sinceLevel: 1, lastTurn: -1 }));
    players[0] = { ...players[0], sinceLevel: 2, lastTurn: -2 }; // Tony, next in line
    players[2] = { ...players[2], freeTurn: 1, lastTurn: 1 }; // Jason, on court
    for (const i of [4, 5, 6]) players[i] = { ...players[i], freeTurn: 1, lastTurn: 1 };
    const q = generateQueue({ rules, players, courts: [court(1), court(2, { busy: true })], maxPerCourt: 2 });
    const level = q.find((m) => [...m.sideA, ...m.sideB].includes(1))!;
    expect([...level.sideA, ...level.sideB].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(level.turn).toBe(1);
  });

  it('a mixed game partners the strongest with the weakest, teams still even', () => {
    const pool = group();
    const m = formMatch(pool, 'doubles', rulesForGame(rules, pool, 'doubles'))!;
    const lv = levelsOf(pool);
    const all = [...m.sideA, ...m.sideB].map((id) => lv.get(id)!);
    const pairsTopWithBottom = [m.sideA, m.sideB].some((s) => {
      const l = s.map((id) => lv.get(id)!);
      return Math.max(...l) === Math.max(...all) && Math.min(...l) === Math.min(...all);
    });
    expect(pairsTopWithBottom).toBe(true);
    expect(Math.max(...all) - Math.min(...all)).toBeGreaterThan(15);
    expect(m.gap).toBeLessThanOrEqual(DEFAULT_RULES.doublesMaxGap);
  });

  it('over a session, strong players mostly play mixed games but still get level games, all balanced', () => {
    const q = generateQueue({ rules, players: group(), courts: [court(1), court(2)], maxPerCourt: 9 });
    const lv = new Map(levels.map((l, i) => [i + 1, l]));
    for (const strong of [1, 2, 3]) {
      const games = q.filter((m) => [...m.sideA, ...m.sideB].includes(strong));
      const level = games.filter((m) => [...m.sideA, ...m.sideB].every((id) => lv.get(id)! >= 65));
      expect(level.length).toBeGreaterThanOrEqual(1);
      expect(games.length - level.length).toBeGreaterThan(level.length);
    }
    for (const m of q) expect(m.gap).toBeLessThanOrEqual(DEFAULT_RULES.doublesMaxGap + DEFAULT_RULES.relaxStep);
  });
});

describe('re-draw exclusion', () => {
  it('skips the excluded lineup and returns the next best', () => {
    const pool = sortByPriority([player(1, 50), player(2, 52), player(3, 48), player(4, 51), player(5, 49)]);
    const first = formMatch(pool, 'doubles', DEFAULT_RULES)!;
    const again = formMatch(pool, 'doubles', DEFAULT_RULES, { exclude: new Set([playerSetKey([...first.sideA, ...first.sideB])]) })!;
    expect(playerSetKey([...again.sideA, ...again.sideB])).not.toBe(playerSetKey([...first.sideA, ...first.sideB]));
  });
});

describe('game plan', () => {
  it('fills open spots nearest the planned players and picks the fairest split', () => {
    const formed = formPlanned([player(1, 80), player(2, 70)], [player(3, 30), player(4, 76), player(5, 74), player(6, 20)], 'doubles', DEFAULT_RULES)!;
    expect(formed.complete).toBe(true);
    expect([...formed.sideA, ...formed.sideB].sort()).toEqual([1, 2, 4, 5]);
    expect(formed.gap).toBeLessThanOrEqual(2);
  });

  it('takes the planned game number, waiting for planned players to come off', () => {
    const players = [1, 2, 3, 4, 5, 6, 7, 8].map((id) => player(id, 50 + id));
    players[7] = player(8, 58, { freeTurn: 1, lastTurn: 1 }); // on another court
    const plan = generateQueue({
      players,
      courts: [court(1)],
      nextGameNo: 4,
      planned: [{ gameNo: 5, ids: [8] }],
      rules: DEFAULT_RULES,
    });
    expect(plan.map((m) => [m.gameNo, m.planNo])).toEqual([
      [4, null],
      [5, 5],
      [6, null],
    ]);
    expect([...plan[1].sideA, ...plan[1].sideB]).toContain(8);
  });

  it('a planned game the queue has already passed is played at the next chance', () => {
    const players = [1, 2, 3, 4, 5, 6, 7, 8].map((id) => player(id, 50));
    const fixed = [{ type: 'doubles' as const, sideA: [1, 2], sideB: [3, 4], locked: true, planNo: null }];
    // Game 4 was planned, but a manual game already holds that spot.
    const plan = generateQueue({ players, courts: [court(1)], fixed, nextGameNo: 4, planned: [{ gameNo: 4, ids: [7] }], rules: DEFAULT_RULES });
    expect(plan[1]).toMatchObject({ gameNo: 5, planNo: 4 });
    expect([...plan[1].sideA, ...plan[1].sideB]).toContain(7);
  });
});

describe('variety', () => {
  const base = { rules: DEFAULT_RULES };
  const eight = [72, 45, 88, 60, 38, 66, 52, 81].map((level, i) => player(i + 1, level));

  it('8 players on one court: groups mix instead of two foursomes alternating', () => {
    const q = generateQueue({ ...base, players: eight, courts: [court(1)], maxPerCourt: 12 });
    const fours = new Set(q.map((m) => [...m.sideA, ...m.sideB].sort().join()));
    expect(fours.size).toBeGreaterThanOrEqual(5);
    // Everyone still plays the same number of games…
    const games = new Map<number, number>();
    for (const m of q) for (const id of [...m.sideA, ...m.sideB]) games.set(id, (games.get(id) ?? 0) + 1);
    expect(new Set(games.values()).size).toBe(1);
    // …at most two go straight back on in any game, and nobody twice within three of their games.
    const last = new Map<number, number>();
    q.forEach((m, i) => {
      const ids = [...m.sideA, ...m.sideB];
      const prev = i > 0 ? [...q[i - 1].sideA, ...q[i - 1].sideB] : [];
      const b2b = ids.filter((id) => prev.includes(id));
      expect(b2b.length).toBeLessThanOrEqual(2);
      for (const id of b2b) {
        const n = q.slice(0, i).filter((x) => [...x.sideA, ...x.sideB].includes(id)).length;
        if (last.has(id)) expect(n - last.get(id)!).toBeGreaterThanOrEqual(3);
        last.set(id, n);
      }
    });
  });

  it('mixing never forces a lopsided next match', () => {
    const q = generateQueue({ ...base, players: eight, courts: [court(1), court(2)], maxPerCourt: 6 });
    for (const m of q) expect(m.gap).toBeLessThanOrEqual(DEFAULT_RULES.doublesMaxGap + 2 * DEFAULT_RULES.relaxStep);
  });

  it('prefers new opponents when the balance is equally good', () => {
    const pool = [player(1, 50), player(2, 50), player(3, 50), player(4, 50), player(5, 50), player(6, 50)];
    const opponentCounts = new Map([['1-3', 2], ['1-4', 2], ['2-3', 2], ['2-4', 2]]);
    const m = formMatch(pool, 'doubles', DEFAULT_RULES, { opponentCounts, partnerCounts: new Map([['1-2', 2], ['3-4', 2]]) })!;
    const ids = [...m.sideA, ...m.sideB].sort();
    expect(ids).not.toEqual([1, 2, 3, 4]);
  });
});
