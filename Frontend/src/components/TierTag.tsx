import type { Tier } from '../tier';

interface TierTagProps {
  tier: Tier;
  title?: string;
}


export default function TierTag({ tier, title }: TierTagProps) {
  const info =
    tier === 'ultra'
      ? { shortLabel: 'Ultra', fullLabel: 'Ultra 550B', pips: 3 }
      : tier === 'super'
      ? { shortLabel: 'Super', fullLabel: 'Super 120B', pips: 2 }
      : tier === 'nano'
      ? { shortLabel: 'Nano', fullLabel: 'Nano 30B', pips: 1 }
      : { shortLabel: 'pytest', fullLabel: 'pytest', pips: 0 };

  return (
    <span className="tier-tag" title={title ?? info.fullLabel}>
      <span className="tier-tag__label">{info.shortLabel}</span>
      {info.pips > 0 && (
        <span className="tier-tag__pips" aria-hidden="true">
          {[1, 2, 3].map((idx) => (
            <span
              key={idx}
              className={`tier-tag__pip ${idx <= info.pips ? 'is-filled' : ''}`}
            />
          ))}
        </span>
      )}
    </span>
  );
}

