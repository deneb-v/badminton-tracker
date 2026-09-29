import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { get, getToken, Me, onAuthChange, setToken } from './api';

interface AuthState {
  token: string | null;
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<void>;
  signOut: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTok] = useState(getToken());
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(!!token);

  useEffect(() => onAuthChange(() => setTok(getToken())), []);

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setMe(null);
      setLoading(false);
      return;
    }
    try {
      setMe((await get<Me>('/me')).data);
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(!!token);
    void refresh();
  }, [token, refresh]);

  return (
    <AuthContext.Provider value={{ token, me, loading, refresh, signOut: () => setToken(null) }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
