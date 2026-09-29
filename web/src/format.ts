const pad = (n: number) => String(n).padStart(2, '0');

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const weekdayShort = (d: Date) => DOW[d.getDay()];

/** 'Sat 26 Sep' (spelled out by hand: some locales print 'Sept'). */
export function formatDate(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00`);
  return `${DOW[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function formatTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function minutesSince(iso: string | null, now = Date.now()): number {
  if (!iso) return 0;
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
}

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const todayYmd = () => ymd(new Date());

export const clock = (now = Date.now()) => formatTime(new Date(now).toISOString());

/** Minutes until an 'HH:MM' wall-clock time on the given date (negative once it's passed). */
export function minutesUntil(date: string, hhmm: string, now = Date.now()): number {
  return Math.round((new Date(`${date}T${hhmm}:00`).getTime() - now) / 60_000);
}

export const names = (players: { name: string }[], sep = ' & ') => players.map((p) => p.name).join(sep);

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const FORMAT_LABEL = { doubles: 'Doubles', singles: 'Singles', mixed: 'Mixed' } as const;
