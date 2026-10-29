import type { Card, ClientCard, Suit } from '@cardplay/shared';
import { isHiddenCard } from '@cardplay/shared';
import { useEffect, useState, type CSSProperties } from 'react';
import { cardSpoken } from './cards';

// the look follows a dark, worn deck: near-black stock, bone-coloured ink, crimson for the red suits
const BONE = '#ece2c8';
const RED = '#d0303a';
const PEWTER = '#8a8576';

const SUIT_COLOR: Record<Suit, string> = {
  spades: BONE,
  clubs: BONE,
  hearts: RED,
  diamonds: RED,
};

// every glyph is drawn in a 20x20 box centred on 0,0 so it can be placed, scaled and flipped freely
function SuitGlyph({
  suit,
  x,
  y,
  scale = 1,
  flip = false,
}: {
  suit: Suit;
  x: number;
  y: number;
  scale?: number;
  flip?: boolean;
}) {
  const fill = SUIT_COLOR[suit];
  const transform = `translate(${x} ${y}) rotate(${flip ? 180 : 0}) scale(${scale})`;
  switch (suit) {
    case 'hearts':
      return (
        <path transform={transform} fill={fill} d="M0 9 C-14 -1 -9 -10 0 -4 C9 -10 14 -1 0 9Z" />
      );
    case 'diamonds':
      return <path transform={transform} fill={fill} d="M0 -10 L7 0 L0 10 L-7 0Z" />;
    case 'spades':
      return (
        <path
          transform={transform}
          fill={fill}
          d="M0 -10 C-14 2 -9 9 -2 5 C-2 8 -3 9 -5 10 H5 C3 9 2 8 2 5 C9 9 14 2 0 -10Z"
        />
      );
    case 'clubs':
      return (
        <g transform={transform} fill={fill}>
          <circle cx="0" cy="-5" r="4.6" />
          <circle cx="-5" cy="2" r="4.6" />
          <circle cx="5" cy="2" r="4.6" />
          <path d="M0 1 L-2.6 10 H2.6Z" />
        </g>
      );
  }
}

// the four-point sparkle that replaces the usual pips on this deck
function Sparkle({
  x,
  y,
  r,
  fill,
  opacity = 1,
}: {
  x: number;
  y: number;
  r: number;
  fill: string;
  opacity?: number;
}) {
  const k = r * 0.16;
  return (
    <path
      fill={fill}
      opacity={opacity}
      d={`M${x} ${y - r} Q${x + k} ${y - k} ${x + r} ${y} Q${x + k} ${y + k} ${x} ${y + r} Q${x - k} ${y + k} ${x - r} ${y} Q${x - k} ${y - k} ${x} ${y - r}Z`}
    />
  );
}

const L = 34;
const C = 50;
const R = 66;
const PIPS: Record<string, [number, number][]> = {
  '2': [
    [C, 34],
    [C, 106],
  ],
  '3': [
    [C, 34],
    [C, 70],
    [C, 106],
  ],
  '4': [
    [L, 34],
    [R, 34],
    [L, 106],
    [R, 106],
  ],
  '5': [
    [L, 34],
    [R, 34],
    [C, 70],
    [L, 106],
    [R, 106],
  ],
  '6': [
    [L, 34],
    [R, 34],
    [L, 70],
    [R, 70],
    [L, 106],
    [R, 106],
  ],
  '7': [
    [L, 34],
    [R, 34],
    [C, 52],
    [L, 70],
    [R, 70],
    [L, 106],
    [R, 106],
  ],
  '8': [
    [L, 34],
    [R, 34],
    [C, 52],
    [L, 70],
    [R, 70],
    [C, 88],
    [L, 106],
    [R, 106],
  ],
  '9': [
    [L, 34],
    [R, 34],
    [L, 56],
    [R, 56],
    [C, 70],
    [L, 84],
    [R, 84],
    [L, 106],
    [R, 106],
  ],
  '10': [
    [L, 34],
    [R, 34],
    [C, 45],
    [L, 56],
    [R, 56],
    [L, 84],
    [R, 84],
    [C, 95],
    [L, 106],
    [R, 106],
  ],
};

function CardFaceArt({ rank, suit }: { rank: string; suit: Suit }) {
  const ink = SUIT_COLOR[suit];
  const pips = PIPS[rank];
  return (
    <svg className="pcard__art" viewBox="0 0 100 140" aria-hidden="true" focusable="false">
      <rect
        x="21"
        y="12"
        width="58"
        height="116"
        rx="2"
        fill="none"
        stroke={BONE}
        strokeOpacity=".32"
        strokeWidth=".7"
      />
      {/* a hairline crack in one corner, the deck's signature */}
      <path
        d="M79 12 L66 30 L70 41 M66 30 L55 33 M79 12 L72 24"
        fill="none"
        stroke={BONE}
        strokeOpacity=".28"
        strokeWidth=".5"
      />
      {/* index in both corners */}
      <g fill={ink}>
        <text x="11" y="26" textAnchor="middle" fontSize={rank === '10' ? 15 : 19} fontWeight="600">
          {rank}
        </text>
        <g transform="rotate(180 50 70)">
          <text
            x="11"
            y="26"
            textAnchor="middle"
            fontSize={rank === '10' ? 15 : 19}
            fontWeight="600"
          >
            {rank}
          </text>
        </g>
      </g>
      <SuitGlyph suit={suit} x={11} y={37} scale={0.46} />
      <SuitGlyph suit={suit} x={89} y={103} scale={0.46} flip />

      {pips &&
        pips.map(([x, y], i) => (
          <SuitGlyph key={i} suit={suit} x={x} y={y} scale={0.95} flip={y > 70} />
        ))}

      {rank === 'A' && (
        <>
          <Sparkle x={50} y={70} r={36} fill={BONE} opacity={0.1} />
          <SuitGlyph suit={suit} x={50} y={70} scale={2.5} />
        </>
      )}

      {!pips && rank !== 'A' && (
        <>
          <rect
            x="27"
            y="20"
            width="46"
            height="100"
            rx="1.5"
            fill="none"
            stroke={BONE}
            strokeOpacity=".2"
            strokeWidth=".6"
          />
          <Sparkle x={34} y={27} r={5} fill={RED} />
          <Sparkle x={66} y={113} r={5} fill={RED} />
          <SuitGlyph suit={suit} x={50} y={34} scale={0.95} />
          <SuitGlyph suit={suit} x={50} y={106} scale={0.95} flip />
          <text x="50" y="88" textAnchor="middle" fontSize="44" fontWeight="600" fill={BONE}>
            {rank}
          </text>
        </>
      )}
    </svg>
  );
}

// a deterministic pseudo-random sequence, so every back looks the same on every render
function sequence(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// shattered glass: rays from one impact point, broken rings between them
const CRACKS = (() => {
  const rnd = sequence(11);
  const cx = 54;
  const cy = 66;
  const angles = [0, 22, 43, 66, 90, 114, 135, 160, 181, 203, 225, 249, 270, 295, 318, 340].map(
    (a) => a + (rnd() - 0.5) * 8,
  );
  const reach = (deg: number) => {
    const rad = (deg * Math.PI) / 180;
    const dx = Math.cos(rad);
    const dy = Math.sin(rad);
    const tx = dx > 0 ? (88 - cx) / dx : dx < 0 ? (12 - cx) / dx : Infinity;
    const ty = dy > 0 ? (128 - cy) / dy : dy < 0 ? (12 - cy) / dy : Infinity;
    return Math.min(tx, ty);
  };
  const point = (deg: number, dist: number): [number, number] => {
    const rad = (deg * Math.PI) / 180;
    return [cx + Math.cos(rad) * dist, cy + Math.sin(rad) * dist];
  };
  const rays = angles.map((a) => {
    const end = point(a, reach(a) * (0.82 + rnd() * 0.18));
    return `M${cx} ${cy} L${end[0].toFixed(1)} ${end[1].toFixed(1)}`;
  });
  const rings = [7, 16, 28, 44].map((radius) => {
    const pts = angles.map((a) => point(a, radius * (0.85 + rnd() * 0.3)));
    return pts
      .map((p, i) => {
        if ((i + Math.round(radius)) % 4 === 0) return '';
        const q = pts[(i + 1) % pts.length]!;
        return `M${p[0].toFixed(1)} ${p[1].toFixed(1)} L${q[0].toFixed(1)} ${q[1].toFixed(1)}`;
      })
      .join(' ');
  });
  const shards = angles.map((a, i) => {
    const b = angles[(i + 1) % angles.length]!;
    const p1 = point(a, 16);
    const p2 = point(a, 44);
    const p3 = point(b, 44);
    const p4 = point(b, 16);
    return {
      d: `M${p1[0].toFixed(1)} ${p1[1].toFixed(1)} L${p2[0].toFixed(1)} ${p2[1].toFixed(1)} L${p3[0].toFixed(1)} ${p3[1].toFixed(1)} L${p4[0].toFixed(1)} ${p4[1].toFixed(1)}Z`,
      alpha: 0.015 + rnd() * 0.09,
    };
  });
  return { rays: rays.join(' '), rings: rings.join(' '), shards };
})();

function CardBackArt() {
  return (
    <svg className="pcard__art" viewBox="0 0 100 140" aria-hidden="true" focusable="false">
      <rect
        x="4"
        y="4"
        width="92"
        height="132"
        rx="4"
        fill="none"
        stroke={PEWTER}
        strokeOpacity=".75"
        strokeWidth="2.4"
      />
      <rect
        x="8"
        y="8"
        width="84"
        height="124"
        rx="2"
        fill="none"
        stroke={PEWTER}
        strokeOpacity=".6"
        strokeWidth=".8"
        strokeDasharray="0.8 2.2"
        strokeLinecap="round"
      />
      {[
        [8, 8],
        [92, 8],
        [8, 132],
        [92, 132],
      ].map(([x, y]) => (
        <circle
          key={`${x}${y}`}
          cx={x}
          cy={y}
          r="2.4"
          fill="#0d0c0b"
          stroke={PEWTER}
          strokeOpacity=".8"
          strokeWidth=".8"
        />
      ))}
      <rect
        x="12"
        y="12"
        width="76"
        height="116"
        fill="none"
        stroke={BONE}
        strokeOpacity=".55"
        strokeWidth=".7"
      />
      {CRACKS.shards.map((s, i) => (
        <path key={i} d={s.d} fill={BONE} fillOpacity={s.alpha} />
      ))}
      <path
        d={CRACKS.rays}
        fill="none"
        stroke={BONE}
        strokeOpacity=".72"
        strokeWidth=".55"
        strokeLinecap="round"
      />
      <path
        d={CRACKS.rings}
        fill="none"
        stroke={BONE}
        strokeOpacity=".6"
        strokeWidth=".45"
        strokeLinecap="round"
      />
      <Sparkle x={54} y={66} r={5.5} fill={RED} />
    </svg>
  );
}

export type CardSize = 'xs' | 'sm' | 'md' | 'lg';
export type CardOrigin = 'top' | 'bottom' | 'left' | 'right';

const ORIGINS: Record<CardOrigin, [string, string]> = {
  top: ['0px', '-9rem'],
  bottom: ['0px', '9rem'],
  left: ['-9rem', '0px'],
  right: ['9rem', '0px'],
};

type CardProps = {
  card?: ClientCard | null;
  faceDown?: boolean;
  size?: CardSize;
  // slides the card in from `from` when it first appears on the table
  deal?: boolean;
  from?: CardOrigin;
  delay?: number;
  rotate?: number;
  className?: string;
  style?: CSSProperties;
};

export function PlayingCard({
  card,
  faceDown,
  size = 'md',
  deal = false,
  from = 'top',
  delay = 0,
  rotate = 0,
  className = '',
  style,
}: CardProps) {
  const visible = card && !isHiddenCard(card) ? card : null;
  const down = faceDown || !visible;
  const [fromX, fromY] = ORIGINS[from];
  const css = {
    '--from-x': fromX,
    '--from-y': fromY,
    '--delay': `${delay}ms`,
    '--rot': `${rotate}deg`,
    ...style,
  } as CSSProperties;

  return (
    <div
      role="img"
      aria-label={down ? 'karta zakryta' : cardSpoken(visible)}
      className={`pcard pcard--${size}${deal ? ' pcard--deal' : ''}${down ? ' is-down' : ''} ${className}`}
      style={css}
    >
      <div className="pcard__inner">
        <div className="pcard__face">
          {visible && <CardFaceArt rank={visible.rank} suit={visible.suit} />}
        </div>
        <div className="pcard__back">
          <CardBackArt />
        </div>
      </div>
    </div>
  );
}

// a draw pile; riffles itself whenever `shuffleKey` changes (and once when it appears)
export function Deck({
  count,
  shuffleKey,
  size = 'md',
  label,
}: {
  count: number;
  shuffleKey?: string | number;
  size?: CardSize;
  label?: string;
}) {
  const [shuffling, setShuffling] = useState(shuffleKey !== undefined);
  useEffect(() => {
    if (shuffleKey === undefined) return;
    setShuffling(true);
    const timer = setTimeout(() => setShuffling(false), 1500);
    return () => clearTimeout(timer);
  }, [shuffleKey]);

  const layers = Math.min(6, Math.max(count, 0));
  return (
    <div className={`deck deck--${size}${shuffling ? ' is-shuffling' : ''}`}>
      {layers === 0 ? (
        <div className={`pcard pcard--${size} pcard--empty`} />
      ) : (
        Array.from({ length: layers }, (_, i) => (
          <PlayingCard
            key={i}
            size={size}
            faceDown
            className="deck__layer"
            style={{ '--i': i } as CSSProperties}
          />
        ))
      )}
      <span className="deck__count" aria-label={label ? `${label}: ${count}` : String(count)}>
        {count}
      </span>
    </div>
  );
}

// the hidden hand of an opponent: overlapping backs, newly drawn ones slide in
export function BackFan({ count, size = 'sm' }: { count: number; size?: CardSize }) {
  const shown = Math.min(count, 9);
  return (
    <div className={`backfan backfan--${size}`} role="img" aria-label={`karty w ręce: ${count}`}>
      {Array.from({ length: shown }, (_, i) => (
        <PlayingCard
          key={i}
          size={size}
          faceDown
          deal
          from="top"
          rotate={(i - (shown - 1) / 2) * 5}
          style={{ '--i': i } as CSSProperties}
        />
      ))}
      {count > shown && <span className="backfan__more">+{count - shown}</span>}
    </div>
  );
}

// your own hidden card: a lifted corner on hover or focus, one click keeps it open
export function PeekCard({
  card,
  size = 'lg',
  delay = 0,
}: {
  card: ClientCard;
  size?: CardSize;
  delay?: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      className="peek"
      aria-pressed={open}
      aria-label={open ? `${cardSpoken(card as Card)}, zakryj kartę` : 'karta zakryta, podejrzyj'}
      onClick={() => setOpen((o) => !o)}
    >
      <PlayingCard
        card={card}
        faceDown={!open}
        size={size}
        deal
        from="top"
        delay={delay}
        className="peek__card"
      />
    </button>
  );
}
