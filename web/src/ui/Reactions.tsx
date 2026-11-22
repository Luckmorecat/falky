import { type CSSProperties, useEffect, useState } from 'react';
import { emojiOf, onReaction } from '../voice/reactions';
import './Reactions.css';

/** Enough for a few people mashing at once; the oldest give way. */
const MAX_FLYING = 64;
/** One press throws a handful, so that a reaction reads as a burst rather than a sticker. */
const PER_PRESS = 7;

interface Flying {
  key: number;
  emoji: string;
  style: CSSProperties;
}

let nextKey = 0;

const spread = (range: number) => (Math.random() * 2 - 1) * range;

/** The first of a burst rises straight and large; the rest scatter around it, smaller and later. */
function burst(emoji: string): Flying[] {
  const count = matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : PER_PRESS;
  return Array.from({ length: count }, (_, i) => ({
    key: nextKey++,
    emoji,
    style: {
      '--x': `${i ? spread(30) : spread(4)}cqw`,
      '--drift': `${spread(i ? 16 : 4)}cqw`,
      '--tilt': `${spread(i ? 30 : 10)}deg`,
      '--size': i ? (0.55 + Math.random() * 0.45).toFixed(2) : '1.15',
      '--delay': `${i ? Math.round(Math.random() * 260) : 0}ms`,
      '--rise': `${i ? 1300 + Math.round(Math.random() * 700) : 1800}ms`,
    } as CSSProperties,
  }));
}

/** Reactions bursting out of one connection's orb. */
export function Reactions({ id }: { id: string }) {
  const [flying, setFlying] = useState<Flying[]>([]);

  useEffect(() => onReaction((from, reaction) => {
    if (from !== id) return;
    setFlying((list) => [...list, ...burst(emojiOf(reaction))].slice(-MAX_FLYING));
  }), [id]);

  if (!flying.length) return null;
  return (
    <div className="t-react" aria-hidden="true">
      {flying.map((f) => (
        <span key={f.key} style={f.style} onAnimationEnd={() => setFlying((list) => list.filter((x) => x.key !== f.key))}>{f.emoji}</span>
      ))}
    </div>
  );
}
