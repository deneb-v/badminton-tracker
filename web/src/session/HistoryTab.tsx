import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, HistoryRow } from '../api';
import { Seg } from '../components/ui';
import { useSessionCtx } from './context';

type Sort = 'played' | 'wins' | 'name';
const SORTS: Record<Sort, (a: HistoryRow, b: HistoryRow) => number> = {
  played: (a, b) => b.played - a.played || a.name.localeCompare(b.name),
  wins: (a, b) => b.wins - a.wins || a.name.localeCompare(b.name),
  name: (a, b) => a.name.localeCompare(b.name),
};

/** Admin-only: everyone's record across all the group's sessions. */
export function HistoryTab() {
  const { gid, state } = useSessionCtx();
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>('played');

  // Refetch as results come in (version bumps on every write).
  const version = state.session.version;
  useEffect(() => {
    get<HistoryRow[]>(`/groups/${gid}/history`)
      .then((r) => setRows(r.data))
      .catch((e) => setError((e as Error).message));
  }, [gid, version]);

  if (error && !rows) return <div className="col"><p className="err">{error}</p></div>;
  return (
    <div className="col col-tight">
      <Seg
        label="Sort"
        value={sort}
        onChange={setSort}
        options={[
          { value: 'played', label: 'Most played' },
          { value: 'wins', label: 'Most wins' },
          { value: 'name', label: 'A–Z' },
        ]}
      />
      {!rows ? (
        <p className="muted">Loading…</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Member</th>
              <th className="num">Sess.</th>
              <th className="num">Played</th>
              <th className="num">W–L</th>
              <th className="num">Win</th>
            </tr>
          </thead>
          <tbody>
            {[...rows].sort(SORTS[sort]).map((h) => {
              const decided = h.wins + h.losses;
              return (
                <tr key={h.memberId}>
                  <td>
                    <Link to={`/g/${gid}/members/${h.memberId}`} style={{ color: 'inherit', textDecoration: 'none' }}>
                      {h.name}
                    </Link>
                  </td>
                  <td className="num">{h.sessions}</td>
                  <td className="num">{h.played}</td>
                  <td className="num">
                    {h.wins}–{h.losses}
                  </td>
                  <td className="num big">{decided ? `${Math.round((h.wins / decided) * 100)}%` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="faint" style={{ fontSize: 11 }}>
        Admin only. Win rates are never shown to members.
      </p>
    </div>
  );
}
