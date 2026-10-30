export interface PresetDef {
  id: string;
  testRunner: string;
  title: string;
  desc: string;
  cost: string;
  repo: string;
  bugDesc: string;
  testCmd: string;
  fullSuiteCmd?: string;
}

export const PRESETS: PresetDef[] = [
  {
    id: 'checkout',
    testRunner: 'pytest',
    title: 'checkout-pricing-suite',
    desc: 'Volume discount threshold boundary check (> vs >=)',
    cost: '$0.007',
    repo: 'https://github.com/noshaeec/checkout-pricing-suite',
    bugDesc:
      'volume_discount_rate() in src/checkout/pricing.py uses > TIER_2_THRESHOLD instead of >= TIER_2_THRESHOLD so subtotal 1000.00 gets 10% instead of 15%',
    testCmd: 'pytest --runxfail tests/test_discounts.py',
    fullSuiteCmd: 'pytest --runxfail tests/test_discounts.py tests/test_items.py',
  },
  {
    id: 'backendtest',
    testRunner: 'pytest',
    title: 'BackendTestRun',
    desc: 'Summary metrics and velocity calculation crash on empty workspace',
    cost: '$0.005',
    repo: 'https://github.com/GHOST4709/BackendTestRun',
    bugDesc:
      'Summary metrics and velocity calculation crashes when workspace has zero tasks',
    testCmd: 'pytest test.py',
    fullSuiteCmd: 'pytest test.py',
  },
  {
    id: 'drivelegal',
    testRunner: 'pytest',
    title: 'drivelegal',
    desc: 'Case-insensitive city query filter in /api/calculate',
    cost: '$0.012',
    repo: 'https://github.com/GHOST4709/drivelegal',
    bugDesc:
      'calculate_fine in Backend/main.py returns 404 when querying /api/calculate with mixed-case city parameters like dHaKa instead of matching records case-insensitively',
    testCmd: 'pytest Backend/test.py',
    fullSuiteCmd: 'pytest Backend/test.py',
  },
];
