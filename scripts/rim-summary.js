// Builds The Rim's weekly low/out list (on-hand counts vs par levels in Firebase) for the BEK order
// and posts it to Slack (#rim-inventory, via the existing SLACK_WEBHOOK_URL secret).
// Runs from GitHub Actions early Wednesday morning Central — see .github/workflows/rim-summary.yml.
//
// The pure helpers (date math, order building, message rendering) are exported so they can be
// tested locally without Firebase or Slack: see scripts/rim-summary.test.js.

const https = require('https');
const { URL } = require('url');

const ZACH_SLACK_ID = 'U02KLAS8S';
const TZ = 'America/Chicago';

// --- Key helpers (same key format the weekly-order.html page uses) ---
function unescapeSection(k) {
  return k
    .replace(/__SLASH__/g, '/')
    .replace(/__DOT__/g, '.')
    .replace(/__HASH__/g, '#')
    .replace(/__DOLLAR__/g, '$')
    .replace(/__LBRACK__/g, '[')
    .replace(/__RBRACK__/g, ']');
}

function getItemKey(sectionName, item, idx) {
  const sectionId = sectionName.replace(/[^a-zA-Z0-9]/g, '_');
  const raw = item.itemNumber || item.name || 'item';
  const sanitized = raw.replace(/[.#$/\[\]]/g, '_').replace(/\s+/g, '_').substring(0, 60);
  return 'i_' + sectionId + '_' + sanitized + '_' + idx;
}

function getParInfo(pars, key) {
  const raw = pars[key];
  if (raw == null) return { value: 0, unit: '' };
  if (typeof raw === 'number') return { value: raw, unit: '' };
  if (typeof raw === 'object') return { value: parseFloat(raw.value) || 0, unit: raw.unit || '' };
  return { value: parseFloat(raw) || 0, unit: '' };
}

// --- Date helpers ---
// Returns { ymd: 'YYYY-MM-DD', dow: 0-6 } for the given instant, in America/Chicago time.
function chicagoDate(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { ymd: `${get('year')}-${get('month')}-${get('day')}`, dow };
}

// Adds whole days to a 'YYYY-MM-DD' string (calendar math only, no time zones involved).
function addDays(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

// The count week is keyed by its Tuesday. Use the most recent Tuesday in Chicago time
// (today if it is Tuesday). Running Wednesday morning therefore reads yesterday's counts.
function getCountWeek(now = new Date()) {
  const { ymd, dow } = chicagoDate(now);
  const back = (dow - 2 + 7) % 7; // days since Tuesday
  return addDays(ymd, -back);
}

// 'YYYY-MM-DD' -> 'M/D'
function shortDate(ymd) {
  const [, m, d] = ymd.split('-').map(Number);
  return `${m}/${d}`;
}

// --- Counts ---
// Workaround for a known page bug: weekly-order.html builds its date key with toISOString() (UTC),
// so counts typed in after ~7pm CDT (6pm CST) on Tuesday get saved under WEDNESDAY's date key.
// So we read both the Tuesday and the Wednesday keys and merge them. If an item exists under
// both, the Wednesday value wins because it was entered later.
function mergeCounts(tuesdayCounts, wednesdayCounts) {
  const tue = tuesdayCounts || {};
  const wed = wednesdayCounts || {};
  const merged = { ...tue, ...wed };
  const fromWednesday = Object.keys(wed).length;
  return { merged, fromWednesday };
}

// --- Unit / pack display ---
// Quantities are shown exactly as counted, in the par's unit. No rounding to cases: Colonnade
// (the receiving warehouse) often sends partial cases over, so Zach needs the real shortfall.
function unitLabel(unit) {
  const u = (unit || '').trim();
  if (/^(gal|gallon|gallons)$/i.test(u)) return 'gal';
  return u.toLowerCase();
}

// "2 / 1 GAL" -> "2/1 GAL" (short reference so he can split a case between locations)
function packLabel(pack) {
  return pack ? String(pack).replace(/\s*\/\s*/g, '/').trim() : '';
}

function fmtNum(n) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

// --- Order building ---
const SECTION_ORDER = [
  'Walk-in Cooler', 'Produce', 'Meat', 'Label Printing Table', 'Saute Line', 'Spice Rack',
  'Kitchen Dry Supplies', 'Chemicals/Janitorial Supplies', 'Plating Team Supplies',
  'Front of House Supplies', 'Bathroom Supplies', 'Freezer', 'Labeling Station',
];

function sectionRank(name) {
  const i = SECTION_ORDER.indexOf(name);
  return i === -1 ? SECTION_ORDER.length : i;
}

// BEK items (with an item number) first, then no-BEK items; stable within each (section order).
function bekFirst(rows) {
  return rows.filter((r) => r.itemNumber).concat(rows.filter((r) => !r.itemNumber));
}

// items: raw inventory/rim/items snapshot (section keys may be escaped)
// Returns { out: [...], low: [...], uncounted: [...], counted, tracked }
//   out = counted at 0 on hand; low = counted above 0 but below par.
function buildOrder({ items, pars, hidden, counts }) {
  const out = [];
  const low = [];
  const uncounted = [];
  let tracked = 0;
  let counted = 0;

  const sections = Object.entries(items || {})
    .filter(([, arr]) => Array.isArray(arr))
    .map(([sec, arr]) => [unescapeSection(sec), arr])
    .sort((a, b) => sectionRank(a[0]) - sectionRank(b[0]));

  sections.forEach(([secName, arr]) => {
    arr.forEach((it, idx) => {
      if (!it) return;
      const key = getItemKey(secName, it, idx);
      if (hidden && hidden[key]) return;
      const par = getParInfo(pars || {}, key);
      if (!(par.value > 0)) return; // only items with a par set are part of the weekly order
      tracked++;
      if (!Object.prototype.hasOwnProperty.call(counts, key)) {
        uncounted.push({ section: secName, name: it.name || '(unnamed)' });
        return;
      }
      counted++;
      const onHand = parseFloat(counts[key]) || 0;
      const short = Math.max(0, par.value - onHand);
      if (!(short > 0)) return;
      const row = {
        section: secName,
        name: it.name || '(unnamed)',
        itemNumber: it.itemNumber || '',
        pack: it.pack || '',
        par: par.value,
        unit: par.unit,
        onHand,
        short,
      };
      (onHand <= 0 ? out : low).push(row);
    });
  });

  return { out: bekFirst(out), low: bekFirst(low), uncounted, counted, tracked };
}

// --- Message rendering (Slack mrkdwn) ---
// One line per item, e.g.
//   • Degreaser Inside Out Moprite #885818: 0.5 / 1 gal (short 0.5 gal) · pack 2/1 GAL
//   • Pop Chips - BBQ _(no BEK #)_: 0 / 1 case (short 1 case) · pack 1/30Pk
function renderItem(r) {
  const u = unitLabel(r.unit);
  const us = u ? ' ' + u : '';
  const id = r.itemNumber ? ` #${r.itemNumber}` : ' _(no BEK #)_';
  const pack = r.pack ? ` · pack ${packLabel(r.pack)}` : '';
  return `• ${r.name}${id}: ${fmtNum(r.onHand)} / ${fmtNum(r.par)}${us} (short ${fmtNum(r.short)}${us})${pack}`;
}

function renderMessage({ weekKey, order, fromWednesday }) {
  const mention = `<@${ZACH_SLACK_ID}>`;
  const tue = shortDate(weekKey);
  const wed = shortDate(addDays(weekKey, 1));

  if (order.counted === 0) {
    return (
      `${mention} :warning: *Rim BEK order — no counts found for week of Tue ${tue}* (${weekKey}).\n` +
      `Nothing was entered in the weekly order tool for Tue ${tue} (or Wed ${wed}), so no order list was built. ` +
      `Check the tool or get a count before ordering.`
    );
  }

  const lines = [];
  lines.push(`${mention} *Rim BEK order — counts from Tue ${tue}*`);
  let sub = `${order.counted} of ${order.tracked} par items counted`;
  if (fromWednesday > 0) sub += ` (includes ${fromWednesday} saved under Wed ${wed} — late-evening entries)`;
  lines.push(`_${sub}_`);
  lines.push('');

  if (order.out.length === 0 && order.low.length === 0) {
    lines.push(':white_check_mark: Nothing below par — no reorder needed this week.');
  } else {
    lines.push(`*Out (0 on hand)* (${order.out.length})`);
    if (order.out.length === 0) lines.push('• none');
    order.out.forEach((r) => lines.push(renderItem(r)));
    lines.push('');
    lines.push(`*Low (below par)* (${order.low.length})`);
    if (order.low.length === 0) lines.push('• none');
    order.low.forEach((r) => lines.push(renderItem(r)));
  }
  lines.push('');

  if (order.uncounted.length === 0) {
    lines.push(':white_check_mark: All items counted');
  } else {
    lines.push(`:warning: *Par set but not counted (${order.uncounted.length}):* ` +
      order.uncounted.map((u) => u.name).join(', '));
  }

  return lines.join('\n');
}

// --- Slack post helper ---
function postToSlack(webhookUrl, text) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(webhookUrl);
    const data = JSON.stringify({ text });
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: 443,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode === 200) resolve(body);
          else reject(new Error('Slack returned ' + res.statusCode + ': ' + body));
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// --- Main ---
async function main() {
  // Loaded here (not at the top) so the helpers above can be tested without firebase-admin installed.
  const admin = require('firebase-admin');
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: 'https://zedrics-production-hub-default-rtdb.firebaseio.com',
  });
  const db = admin.database();

  const weekKey = getCountWeek(new Date());
  const wedKey = addDays(weekKey, 1);
  console.log('Building summary for count week:', weekKey, '(also checking', wedKey + ')');

  const [itemsSnap, parsSnap, hiddenSnap, tueSnap, wedSnap] = await Promise.all([
    db.ref('inventory/rim/items').once('value'),
    db.ref('weekly_orders/rim/pars').once('value'),
    db.ref('weekly_orders/rim/hiddenFromWeekly').once('value'),
    db.ref('weekly_orders/rim/' + weekKey).once('value'),
    db.ref('weekly_orders/rim/' + wedKey).once('value'),
  ]);

  const { merged, fromWednesday } = mergeCounts(tueSnap.val(), wedSnap.val());
  const order = buildOrder({
    items: itemsSnap.val() || {},
    pars: parsSnap.val() || {},
    hidden: hiddenSnap.val() || {},
    counts: merged,
  });
  const msg = renderMessage({ weekKey, order, fromWednesday });

  console.log('--- Message ---\n' + msg + '\n---------------');
  await postToSlack(process.env.SLACK_WEBHOOK_URL, msg);
  console.log('Posted to Slack successfully.');
}

module.exports = {
  getCountWeek, chicagoDate, addDays, shortDate, mergeCounts, unitLabel, packLabel,
  buildOrder, renderItem, renderMessage, getItemKey, unescapeSection,
};

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Failed:', err);
      // Try to post the failure to Slack so it's not silent
      if (process.env.SLACK_WEBHOOK_URL) {
        postToSlack(
          process.env.SLACK_WEBHOOK_URL,
          `<@${ZACH_SLACK_ID}> :x: *Rim Order Summary failed:* ${err.message}\nCheck GitHub Actions logs for details.`
        )
          .catch(() => {})
          .finally(() => process.exit(1));
      } else {
        process.exit(1);
      }
    });
}
