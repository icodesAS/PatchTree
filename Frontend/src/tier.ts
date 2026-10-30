export type Tier = 'nano' | 'super' | 'ultra' | 'sandbox';

export function getModelTier(model = ''): {
  tier: Tier;
  shortLabel: string;
  fullLabel: string;
  pips: number;
} {
  if (/ultra|550|253/i.test(model)) {
    return { tier: 'ultra', shortLabel: 'Ultra', fullLabel: 'Ultra 550B', pips: 3 };
  }
  if (/super|120|70/i.test(model)) {
    return { tier: 'super', shortLabel: 'Super', fullLabel: 'Super 120B', pips: 2 };
  }
  if (/nano|30/i.test(model)) {
    return { tier: 'nano', shortLabel: 'Nano', fullLabel: 'Nano 30B', pips: 1 };
  }
  return { tier: 'sandbox', shortLabel: 'pytest', fullLabel: 'pytest', pips: 0 };
}
