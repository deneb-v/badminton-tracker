import { createContext, ReactNode, useCallback, useContext, useState } from 'react';

type Tone = 'info' | 'error';
const ToastContext = createContext<(message: string, tone?: Tone) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ message: string; tone: Tone; key: number } | null>(null);
  const show = useCallback((message: string, tone: Tone = 'info') => {
    const key = Date.now();
    setToast({ message, tone, key });
    setTimeout(() => setToast((t) => (t?.key === key ? null : t)), 3500);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && (
        <div className={`toast toast-${toast.tone}`} role="status" onClick={() => setToast(null)}>
          {toast.message}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
