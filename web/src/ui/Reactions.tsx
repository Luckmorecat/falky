import { type CSSProperties, useEffect, useState } from 'react';
import { emojiOf, onReaction } from '../voice/reactions';
import './Reactions.css';

/** More at once would hide the orb they rise from. */
const MAX_FLYING = 8;

interface Flying {
  key: number;
  emoji: string;
  style: CSSProperties;
}

let nextKey = 0;

/** Reactions rising out of one connection's orb. */
export function Reactions({ id }: { id: string }) {
  const [flying, setFlying] = useState<Flying[]>([]);

  useEffect(() => onReaction((from, reaction) => {
    if (from !== id) return;
    const style = {
      '--x': `${(Math.random() * 2 - 1) * 18}cqw`,
      '--drift': `${(Math.random() * 2 - 1) * 8}cqw`,
      '--tilt': `${(Math.random() * 2 - 1) * 12}deg`,
    } as CSSProperties;
    setFlying((list) => [...list, { key: nextKey++, emoji: emojiOf(reaction), style }].slice(-MAX_FLYING));
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
