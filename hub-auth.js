// Shared PIN login for the Production Hub (dashboard, production, inventory, weekly order).
//
// The PINs are NOT in this file or any page. Each PIN is the password of a Firebase Auth
// Email/Password account (one "team" account, one "admin" account). Firebase checks the PIN on
// its servers (with its own brute-force throttling), and the database rules only let those two
// signed-in accounts read or write. To change a PIN: Firebase console > Authentication > Users >
// (team@ or admin@ account) > Reset password, and set it to  zph-team-NEWPIN  or  zph-admin-NEWPIN.
//
// A login lasts 24 hours on a device and is shared by every hub page on that device.
(function () {
  var DOMAIN = 'zedrics-production-hub.firebaseapp.com';
  var ACCOUNTS = [
    { role: 'team', email: 'team@' + DOMAIN },
    { role: 'admin', email: 'admin@' + DOMAIN },
  ];
  var SESSION_KEY = 'zedrics_hub_session';
  var SESSION_MS = 24 * 60 * 60 * 1000;
  var OLD_KEYS = ['zedrics_hub_login', 'zedrics_inv_login', 'zedrics_order_login', 'zedrics_dash_login'];

  // Firebase passwords must be 6+ characters; the 4-digit PIN is the secret part.
  function pinToPassword(role, pin) { return 'zph-' + role + '-' + pin; }

  function roleForUser(user) {
    if (!user || !user.email) return null;
    for (var i = 0; i < ACCOUNTS.length; i++) if (ACCOUNTS[i].email === user.email.toLowerCase()) return ACCOUNTS[i].role;
    return null;
  }
  function clearOldLogins() {
    // Older versions stored the PIN itself in localStorage; remove it.
    try { OLD_KEYS.forEach(function (k) { localStorage.removeItem(k); }); } catch (e) {}
  }
  function saveSession() { try { localStorage.setItem(SESSION_KEY, JSON.stringify({ time: Date.now() })); } catch (e) {} }
  function sessionFresh() {
    try {
      var d = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      return !!d && (Date.now() - d.time) < SESSION_MS;
    } catch (e) { return false; }
  }
  function isWrongPin(err) {
    var c = (err && err.code) || '';
    return c === 'auth/wrong-password' || c === 'auth/invalid-credential' || c === 'auth/invalid-login-credentials' ||
           c === 'auth/user-not-found' || c === 'auth/invalid-password';
  }
  function friendlyError(err) {
    var c = (err && err.code) || '';
    if (c === 'hub/bad-pin') return 'Incorrect PIN';
    if (c === 'auth/too-many-requests') return 'Too many tries. Wait a few minutes and try again.';
    if (c === 'auth/network-request-failed') return 'No internet connection. Check Wi-Fi and try again.';
    return 'Login error: ' + ((err && err.message) || c || 'unknown');
  }

  // Try the PIN as the team password, then as the admin password. Resolves with 'team' or 'admin'.
  function signInWithPin(pin) {
    clearOldLogins();
    var auth = firebase.auth();
    function attempt(i) {
      if (i >= ACCOUNTS.length) { var e = new Error('Incorrect PIN'); e.code = 'hub/bad-pin'; return Promise.reject(e); }
      var acct = ACCOUNTS[i];
      return auth.signInWithEmailAndPassword(acct.email, pinToPassword(acct.role, pin))
        .then(function () { saveSession(); return acct.role; })
        .catch(function (err) { if (isWrongPin(err)) return attempt(i + 1); throw err; });
    }
    return auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).then(function () { return attempt(0); });
  }

  // On page load: resolves with the role if this device is still signed in (within 24h), else null.
  function restore() {
    clearOldLogins();
    var auth = firebase.auth();
    return new Promise(function (resolve) {
      var unsub = auth.onAuthStateChanged(function (user) {
        unsub();
        var role = roleForUser(user);
        if (role && sessionFresh()) return resolve(role);
        if (user) auth.signOut().catch(function () {}); // expired, or an old anonymous session
        resolve(null);
      });
    });
  }

  function signOut() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
    clearOldLogins();
    return firebase.auth().signOut().catch(function () {});
  }

  window.HubAuth = { signInWithPin: signInWithPin, restore: restore, signOut: signOut, friendlyError: friendlyError, accounts: ACCOUNTS };
})();
