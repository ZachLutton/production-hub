// Local tests for rim-summary.js helpers. No Firebase, no Slack.
// Run: node scripts/rim-summary.test.js
const assert = require('assert');
const s = require('./rim-summary.js');

// --- getCountWeek: most recent Tuesday in America/Chicago ---
const cases = [
  ['2026-09-29T20:00:00-05:00', '2026-09-29', 'Tue 8pm CDT (already Wed in UTC)'],
  ['2026-09-30T04:30:00-05:00', '2026-09-29', 'Wed 4:30am CDT (scheduled run)'],
  ['2026-09-30T09:30:00Z', '2026-09-29', 'cron time 09:30 UTC Wed'],
  ['2026-09-29T00:30:00-05:00', '2026-09-29', 'Tue 12:30am CDT'],
  ['2026-09-28T23:30:00-05:00', '2026-09-22', 'Mon 11:30pm CDT -> previous Tue'],
  ['2026-11-11T04:30:00-06:00', '2026-11-10', 'Wed 4:30am CST (November)'],
  ['2026-11-10T19:00:00-06:00', '2026-11-10', 'Tue 7pm CST (Wed in UTC)'],
  ['2026-11-04T10:30:00Z', '2026-11-03', 'post-DST cron time 10:30 UTC Wed'],
];
for (const [iso, want, label] of cases) {
  assert.strictEqual(s.getCountWeek(new Date(iso)), want, label);
}

// --- mergeCounts: Wednesday key fills gaps and wins ties ---
const m = s.mergeCounts({ a: 1, b: 2 }, { b: 5, c: 3 });
assert.deepStrictEqual(m.merged, { a: 1, b: 5, c: 3 });
assert.strictEqual(m.fromWednesday, 2);
assert.deepStrictEqual(s.mergeCounts(null, null), { merged: {}, fromWednesday: 0 });

// --- orderLine rounding ---
assert.strictEqual(s.orderLine(0.5, 'case', '24 / 250 CT').text, 'order 1 case');
assert.strictEqual(s.orderLine(1.5, 'case', '1 / 50 CT').text, 'order 2 cases');
assert.strictEqual(s.orderLine(0.5, 'gallon', '2 / 1 GAL').text, 'short 0.5 gallon (case = 2 / 1 GAL) → order 1 case?');
assert.strictEqual(s.orderLine(3, 'gallon', '2 / 1 GAL').text, 'short 3 gallon (case = 2 / 1 GAL) → order 2 cases?');
assert.strictEqual(s.orderLine(1, 'Rolls', '6 / 800 FT').text, 'short 1 Rolls (case = 6 / 800 FT) → order 1 case?');
assert.strictEqual(s.orderLine(2, 'boxes', '1/EA').text, 'order 2 boxes (pack: 1/EA)');

// --- buildOrder / renderMessage on a small synthetic fixture ---
const items = {
  'Chemicals__SLASH__Janitorial Supplies': [
    { name: 'Degreaser', itemNumber: '885818', pack: '2 / 1 GAL', price: 74.49 },
    { name: 'Bleach', itemNumber: '144183', pack: '6 / 1 GAL', price: 25.26 },
  ],
  'Front of House Supplies': [
    { name: 'Pop Chips - BBQ', brand: 'Pop Chip', pack: '1/30Pk', price: 14.98 },
    { name: 'Hidden Jerky', pack: '1/EA' },
    { name: 'No Par Nuts', pack: '1/EA' },
    { name: 'Smartwater', itemNumber: '116379', pack: '12 / 1 LTR', price: 33.87 },
  ],
};
const k = (sec, i) => s.getItemKey(sec, items[sec.replace('/', '__SLASH__')][i], i);
const CH = 'Chemicals/Janitorial Supplies', FH = 'Front of House Supplies';
const pars = {
  [k(CH, 0)]: { value: 1, unit: 'gallon' },
  [k(CH, 1)]: { value: 1, unit: 'gallon' },
  [k(FH, 0)]: { value: 1, unit: 'case' },
  [k(FH, 1)]: { value: 5, unit: 'case' },
  [k(FH, 3)]: { value: 1, unit: 'case' },
};
const hidden = { [k(FH, 1)]: true };
const tue = { [k(CH, 0)]: 0.5, [k(CH, 1)]: 1, [k(FH, 0)]: 0 };

const order = s.buildOrder({ items, pars, hidden, counts: tue });
assert.deepStrictEqual(order.bek.map((r) => r.name), ['Degreaser']);
assert.deepStrictEqual(order.other.map((r) => r.name), ['Pop Chips - BBQ']);
assert.deepStrictEqual(order.uncounted.map((r) => r.name), ['Smartwater']);
assert.strictEqual(order.tracked, 4);
assert.strictEqual(order.counted, 3);
const msg = s.renderMessage({ weekKey: '2026-09-29', order, fromWednesday: 0 });
assert.ok(msg.startsWith('<@U02KLAS8S> *Rim BEK order — counts from Tue 9/29*'));
assert.ok(msg.includes('• Degreaser — #885818 — short 0.5 gallon (case = 2 / 1 GAL) → order 1 case?'));
assert.ok(msg.includes('• Pop Chips - BBQ (Pop Chip) — order 1 case'));
assert.ok(msg.includes('Par set but not counted (1):* Smartwater'));

// Late entry saved under Wednesday fills the gap
const withWed = s.mergeCounts(tue, { [k(FH, 3)]: 0 });
const order2 = s.buildOrder({ items, pars, hidden, counts: withWed.merged });
assert.strictEqual(order2.uncounted.length, 0);
const msg2 = s.renderMessage({ weekKey: '2026-09-29', order: order2, fromWednesday: withWed.fromWednesday });
assert.ok(msg2.includes('All items counted'));
assert.ok(msg2.includes('includes 1 saved under Wed 9/30'));
assert.ok(msg2.includes('• Smartwater — #116379 — order 1 case'));

// No counts at all -> clear "no counts found", never a full-par list
const empty = s.buildOrder({ items, pars, hidden, counts: {} });
const msg3 = s.renderMessage({ weekKey: '2026-09-29', order: empty, fromWednesday: 0 });
assert.ok(msg3.includes('no counts found for week of Tue 9/29'));
assert.ok(!msg3.includes('Degreaser') && !msg3.includes('order 1'));

console.log('All rim-summary tests passed.');
