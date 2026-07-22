// Fetches The Rim's weekly on-hand counts vs par levels from Firebase and posts a
// scannable order summary to Slack #rim-monthly-inventory.
// Runs from GitHub Actions on Tuesday 9pm CDT — see .github/workflows/rim-summary.yml.

const admin = require('firebase-admin');
const https = require('https');
const { URL } = require('url');

// --- Firebase init ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://zedrics-production-hub-default-rtdb.firebaseio.com',
});
const db = admin.database();

// --- Helpers ---
// Same key format the weekly-order.html page uses
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

// Get the current upcoming Tuesday's date in YYYY-MM-DD (matches what the app writes)
function getUpcomingTuesday() {
  const d = new Date();
  const day = d.getDay(); // 0=Sun, 2=Tue
  let diff;
  if (day < 2) diff = 2 - day;
  else if (day === 2) diff = 0;
  else diff = 2 - day + 7;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
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

// --- Section render order (matches the app) ---
const SECTION_ORDER = [
  'Walk-in Cooler',
  'Produce',
  'Meat',
  'Label Printing Table',
  'Saute Line',
  'Spice Rack',
  'Kitchen Dry Supplies',
  'Chemicals/Janitorial Supplies',
  'Plating Team Supplies',
  'Front of House Supplies',
  'Bathroom Supplies',
  'Freezer',
  'Labeling Station',
];

// --- Main ---
async function main() {
  const weekKey = getUpcomingTuesday();
  console.log('Building summary for week:', weekKey);

  const [itemsSnap, parsSnap, hiddenSnap, onHandSnap] = await Promise.all([
    db.ref('inventory/rim/items').once('value'),
    db.ref('weekly_orders/rim/pars').once('value'),
    db.ref('weekly_orders/rim/hiddenFromWeekly').once('value'),
    db.ref('weekly_orders/rim/' + weekKey).once('value'),
  ]);
  const items = itemsSnap.val() || {};
  const pars = parsSnap.val() || {};
  const hidden = hiddenSnap.val() || {};
  const onHand = onHandSnap.val() || {};

  const entryCount = Object.keys(onHand).length;

  // Group needs by section
  const needsBySection = {};
  Object.entries(items).forEach(([sec, arr]) => {
    if (!Array.isArray(arr)) return;
    const secName = unescapeSection(sec);
    arr.forEach((it, idx) => {
      if (!it) return;
      const key = getItemKey(secName, it, idx);
      if (hidden[key]) return;
      const parInfo = getParInfo(pars, key);
      const oh = parseFloat(onHand[key]) || 0;
      const need = Math.max(0, parInfo.value - oh);
      if (need > 0) {
        if (!needsBySection[secName]) needsBySection[secName] = [];
        needsBySection[secName].push({
          name: it.name || '(unnamed)',
          brand: it.brand || '',
          need,
          unit: parInfo.unit,
        });
      }
    });
  });

  const needCount = Object.values(needsBySection).reduce((s, arr) => s + arr.length, 0);

  // Compose message
  let msg;
  if (entryCount === 0) {
    msg = `:warning: *Rim Order — ${weekKey}* — Team hasn't submitted counts! Posting baseline assuming shelves are empty:\n\n`;
    msg += renderNeeds(needsBySection);
  } else if (needCount === 0) {
    msg = `:white_check_mark: *Rim Order — ${weekKey}* — Nothing below par (${entryCount} items counted). No reorder needed this week.`;
  } else {
    msg = `:package: *Rim Order — ${weekKey}* — ${entryCount} items counted. Order this before Wednesday 6am:\n\n`;
    msg += renderNeeds(needsBySection);
  }

  console.log('--- Message ---\n' + msg + '\n---------------');

  await postToSlack(process.env.SLACK_WEBHOOK_URL, msg);
  console.log('Posted to Slack successfully.');
}

function renderNeeds(needsBySection) {
  // Render in SECTION_ORDER first, then any unknown sections after
  const orderedNames = SECTION_ORDER.filter((n) => needsBySection[n]);
  Object.keys(needsBySection).forEach((n) => {
    if (!orderedNames.includes(n)) orderedNames.push(n);
  });
  let out = '';
  orderedNames.forEach((sec) => {
    out += `*${sec}:*\n`;
    needsBySection[sec].forEach((x) => {
      const unitStr = x.unit ? ' ' + x.unit : '';
      const brandStr = x.brand ? ' (' + x.brand + ')' : '';
      out += `• ${x.need}${unitStr} — ${x.name}${brandStr}\n`;
    });
    out += '\n';
  });
  return out;
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Failed:', err);
    // Try to post the failure to Slack so it's not silent
    if (process.env.SLACK_WEBHOOK_URL) {
      postToSlack(
        process.env.SLACK_WEBHOOK_URL,
        `:x: *Rim Order Summary failed:* ${err.message}\nCheck GitHub Actions logs for details.`
      )
        .catch(() => {})
        .finally(() => process.exit(1));
    } else {
      process.exit(1);
    }
  });
