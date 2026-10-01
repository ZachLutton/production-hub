// Nightly Production Hub database backup (run by .github/workflows/db-backup.yml).
// Reads the WHOLE Realtime Database plus its security rules with the existing service account
// (FIREBASE_SERVICE_ACCOUNT secret) and writes backup.json. The workflow encrypts that file with
// scripts/backup-public-cert.pem before uploading, so nothing readable leaves the runner.
// Only record COUNTS are printed to the log (this repo is public) — never data.
const fs = require('fs');

function countLeaves(v) {
  if (v === null || typeof v !== 'object') return 1;
  return Object.values(v).reduce((n, c) => n + countLeaves(c), 0);
}

async function main() {
  const admin = require('firebase-admin');
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const databaseURL = 'https://zedrics-production-hub-default-rtdb.firebaseio.com';
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount), databaseURL });
  const db = admin.database();

  const data = (await db.ref('/').once('value')).val() || {};
  let rules = null;
  try { rules = await db.getRules(); } catch (e) { console.log('Could not read rules:', e.message); }

  const counts = {};
  Object.keys(data).sort().forEach((k) => {
    const v = data[k];
    counts[k] = { children: v && typeof v === 'object' ? Object.keys(v).length : 0, leaves: countLeaves(v) };
  });
  const out = {
    exportedAt: new Date().toISOString(),
    databaseURL,
    counts,
    totalLeaves: countLeaves(data),
    rules,
    data,
  };
  fs.writeFileSync('backup.json', JSON.stringify(out));
  console.log('Exported at', out.exportedAt);
  console.log('Top-level nodes:', JSON.stringify(counts));
  console.log('Total values:', out.totalLeaves, '| rules saved:', rules !== null, '| bytes:', fs.statSync('backup.json').size);
}

main().then(() => process.exit(0)).catch((err) => { console.error('Backup failed:', err.message); process.exit(1); });
