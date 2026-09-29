import { ButtonHTMLAttributes, ElementType, ReactNode, useEffect } from 'react';

/** The "+" registration marks every blueprint object wears. */
export function Corners() {
  return (
    <>
      <i className="corner tl" aria-hidden />
      <i className="corner tr" aria-hidden />
      <i className="corner bl" aria-hidden />
      <i className="corner br" aria-hidden />
    </>
  );
}

/** A hairline-framed blueprint object (card, figure). */
export function Frame<T extends ElementType = 'div'>({
  as,
  className = '',
  children,
  ...rest
}: { as?: T; className?: string; children?: ReactNode } & Omit<React.ComponentPropsWithoutRef<T>, 'as' | 'className' | 'children'>) {
  const Tag = (as ?? 'div') as ElementType;
  return (
    <Tag className={`bp ${className}`} {...rest}>
      <Corners />
      {children}
    </Tag>
  );
}

type BtnVariant = 'primary' | 'secondary' | 'ghost';

/** Primary and secondary buttons are framed objects; ghost buttons are plain text actions. */
export function Btn({
  variant = 'secondary',
  size,
  className = '',
  children,
  ...rest
}: { variant?: BtnVariant; size?: 'lg' | 'md' } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const framed = variant !== 'ghost';
  return (
    <button
      type="button"
      className={`btn btn-${variant} ${size ? `btn-${size}` : ''} ${framed ? 'bp' : ''} ${className}`}
      {...rest}
    >
      {framed && <Corners />}
      {children}
    </button>
  );
}

export function ChevronLeft() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

export function XIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

export function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="btn btn-ghost btn-back" onClick={onClick}>
      <ChevronLeft />
      <span className="trunc">{label}</span>
    </button>
  );
}

/** Single-choice segmented control; the selected cell fills with the accent. */
export function Seg<T extends string | number>({
  value,
  options,
  onChange,
  disabled,
  className = '',
  label,
}: {
  value: T | null;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  disabled?: boolean;
  className?: string;
  label?: string;
}) {
  return (
    <div className={`seg ${className}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const DAY_LABEL = (d: string) => d.slice(0, 2);

/** Seven weekday toggles (Mo … Su). */
export function DayPicker<T extends string>({ days, week, onToggle }: { days: T[]; week: T[]; onToggle: (d: T) => void }) {
  return (
    <div className="cells" role="group" aria-label="Usual days">
      {week.map((d) => (
        <button key={d} type="button" aria-pressed={days.includes(d)} aria-label={d} onClick={() => onToggle(d)}>
          {DAY_LABEL(d)}
        </button>
      ))}
    </div>
  );
}

export function Stepper({
  value,
  onChange,
  min,
  max,
  large,
  label,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  large?: boolean;
  label: string;
}) {
  return (
    <div className={`stepper ${large ? 'stepper-lg' : ''}`} role="group" aria-label={label}>
      <button type="button" aria-label={`Lower ${label}`} disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}>
        −
      </button>
      <span aria-live="polite">{value}</span>
      <button type="button" aria-label={`Raise ${label}`} disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))}>
        +
      </button>
    </div>
  );
}

export function Field({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={`field ${className}`}>
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

export function EmptyCard({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <Frame className="empty-card">
      <div className="heading">{title}</div>
      {children && <div className="muted" style={{ fontSize: 14 }}>{children}</div>}
    </Frame>
  );
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="section-title">
      {children}
      {aside && <span className="push small muted" style={{ fontFamily: 'var(--font-body)', fontWeight: 400 }}>{aside}</span>}
    </div>
  );
}

/** Bottom sheet on phones, centred dialog on tablets. Esc / backdrop tap closes. */
export function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={label} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
