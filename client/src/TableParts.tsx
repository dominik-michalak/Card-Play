import type { ReactNode } from 'react';

// the oval table: dark green cloth in a dark leather rail
export function Felt({ children, label }: { children: ReactNode; label: string }) {
  return (
    <section className="felt" aria-label={label}>
      <div className="felt__surface">{children}</div>
    </section>
  );
}

// title on the left, the move clock on the right; the clock turns red in its last seconds
export function Hud({
  title,
  detail,
  secondsLeft,
  status,
}: {
  title: string;
  detail?: string;
  secondsLeft: number | null;
  status: string;
}) {
  return (
    <div className="hud">
      <div>
        <h3 className="hud__title">{title}</h3>
        {detail && <p className="hud__detail">{detail}</p>}
      </div>
      <p
        className={`hud__clock${secondsLeft !== null && secondsLeft <= 5 ? ' is-urgent' : ''}`}
        role="timer"
      >
        {status}
      </p>
    </div>
  );
}

export function Seat({
  name,
  active = false,
  dimmed = false,
  me = false,
  badges = [],
  children,
}: {
  name: string;
  active?: boolean;
  dimmed?: boolean;
  me?: boolean;
  badges?: (string | false | null | undefined)[];
  children?: ReactNode;
}) {
  const tags = badges.filter(Boolean) as string[];
  return (
    <div
      className={`seat${active ? ' is-active' : ''}${dimmed ? ' is-dimmed' : ''}${me ? ' is-me' : ''}`}
    >
      <div className="seat__cards">{children}</div>
      <p className="seat__plate">
        <span className="seat__name">{name}</span>
        {tags.map((t) => (
          <span key={t} className="tag">
            {t}
          </span>
        ))}
      </p>
    </div>
  );
}

export function Chips({ amount, label }: { amount: number; label: string }) {
  if (amount <= 0) return null;
  return (
    <span className="chips" aria-label={`${label}: ${amount}`}>
      <span className="chips__disc" aria-hidden="true" />
      {amount}
    </span>
  );
}

export function Tag({ children }: { children: ReactNode }) {
  return <span className="tag tag--table">{children}</span>;
}
