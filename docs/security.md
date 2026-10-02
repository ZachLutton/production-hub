# Production Hub security (Oct 2026)

## How login works
- Staff type a 4-digit PIN. The PIN is the password of one of two Firebase Auth accounts:
  `team@zedrics-production-hub.firebaseapp.com` (team PIN) and `admin@zedrics-production-hub.firebaseapp.com` (admin PIN).
  Firebase checks it on its servers; the PINs are NOT in any page or in this repo.
- The account password is `zph-team-` + team PIN, and `zph-admin-` + admin PIN (Firebase needs 6+ characters).
- The PIN box starts on **Team**: the PIN is checked against the team account only. For the admin PIN, tap
  **Admin login** under the box first (or open a page with `#admin` at the end of the address, e.g. a bookmark
  like `.../production-hub/index.html#admin` on Zach's devices). The box never tries a PIN on both accounts, so a
  correct PIN never counts as a failed sign-in, and a wrong PIN costs one attempt instead of two. The choice is
  not saved: every page load and every Log out goes back to Team. (An admin PIN typed on Team is refused as
  "Incorrect PIN" and counts as one failed team attempt, same as any wrong PIN.)
- A login lasts 24 hours on a device and covers every hub page (dashboard, production, inventory, weekly order).
- Database rules (`database.rules.json`) only allow those two accounts to read/write. Everyone else, including
  anonymous sign-ins and direct REST requests, is denied.

## Change a PIN
Firebase console > Authentication > Users > the team@ or admin@ account > ⋮ > Reset password.
Set it to `zph-team-NEWPIN` or `zph-admin-NEWPIN`. Devices stay logged in until their 24 hours run out (or they log out).
Never post PINs in Slack or put them in code.

## Deploy / roll back rules (Firebase CLI, logged in as the project owner)
- Deploy locked rules:  `firebase deploy --only database --project zedrics-production-hub`
- Roll back (old rules: any signed-in user, including anonymous): `firebase deploy --only database --project zedrics-production-hub --config firebase.rollback.json`
The current pages work under both rule sets, so a rules rollback alone restores the old access.

## Backups
`.github/workflows/db-backup.yml` exports the whole database + rules nightly (08:15 UTC) with the
FIREBASE_SERVICE_ACCOUNT secret, encrypts it with `scripts/backup-public-cert.pem`, and keeps it as a
30-day Actions artifact. Only the private key (kept off GitHub) can decrypt it.
