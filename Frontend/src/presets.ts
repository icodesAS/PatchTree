export interface PresetDef {
  id: string;
  tier: 'nano' | 'super' | 'ultra';
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
    id: 'discount',
    tier: 'nano',
    title: 'Discount bug',
    desc: 'Volume discount off-by-one boundary check (> vs >=). Fast surgical fix.',
    cost: '$0.007',
    repo: 'https://github.com/noshaeec/checkout-pricing-suite',
    bugDesc:
      'volume_discount_rate() in src/checkout/pricing.py uses > TIER_2_THRESHOLD instead of >= TIER_2_THRESHOLD so subtotal 1000.00 gets 10% instead of 15%',
    testCmd: 'pytest --runxfail tests/test_discounts.py',
    fullSuiteCmd: 'pytest --runxfail tests/test_discounts.py tests/test_items.py',
  },
  {
    id: 'flaky',
    tier: 'super',
    title: 'Flaky test',
    desc: 'A timer race passes sometimes. Five repeat runs isolate the failure.',
    cost: '$0.01',
    repo: 'https://github.com/example/math-service',
    bugDesc: 'compute_average() crashes on empty list with ZeroDivisionError',
    testCmd: 'pytest tests/test_math.py::test_average_empty',
    fullSuiteCmd: '',
  },
  {
    id: 'multifile',
    tier: 'ultra',
    title: 'Hard bug',
    desc: 'Small models fail the first round. The run escalates to Ultra.',
    cost: '$0.05',
    repo: 'https://github.com/example/auth-service',
    bugDesc: 'JWT token verification fails across token validator and session cache under key rotation',
    testCmd: 'pytest tests/test_auth.py::test_key_rotation',
    fullSuiteCmd: 'pytest tests/',
  },
];
