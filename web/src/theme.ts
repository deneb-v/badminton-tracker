import { useSyncExternalStore } from 'react';

export type ThemePref = 'light' | 'dark' | 'system';

// Not under the `bt.` prefix, so signing out (which clears app data) keeps the preference.
const KEY = 'courtside.theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

let pref = readPref();

function apply() {
  const dark = pref === 'dark' || (pref === 'system' && media.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#141618' : '#f2f2f3');
}

apply();
media.addEventListener('change', () => pref === 'system' && apply());

export function setTheme(next: ThemePref) {
  pref = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Private mode: the choice lasts for this visit.
  }
  apply();
  listeners.forEach((l) => l());
}

/** Light / dark / follow the phone. index.html applies the saved choice before first paint. */
export function useTheme(): [ThemePref, (p: ThemePref) => void] {
  const current = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pref,
  );
  return [current, setTheme];
}
