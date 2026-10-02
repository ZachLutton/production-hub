// Shared PIN login for the Production Hub (dashboard, production, inventory, weekly order).
//
// The PINs are NOT in this file or any page. Each PIN is the password of a Firebase Auth
// Email/Password account (one "team" account, one "admin" account). Firebase checks the PIN on
// its servers (with its own brute-force throttling), and the database rules only let those two
// signed-in accounts read or write. To change a PIN: Firebase console > Authentication > Users >
// (team@ or admin@ account) > Reset password, and set it to  zph-team-NEWPIN  or  zph-admin-NEWPIN.
//
// Which account a PIN is checked against is chosen ON THE SCREEN, never guessed by trying:
//   - The PIN box starts on "Team": the PIN is checked against the team account only.
//   - Tap "Admin login" under the PIN box (or open the page with #admin at the end of the address,
//     e.g. a bookmark on Zach's devices): the PIN is checked against the admin account only.
// So a correct PIN never causes a failed Firebase sign-in, and a wrong PIN costs one attempt, not two.
// (Before 10/2/2026 the box tried every PIN as the team password first, so each admin login
// counted as a failed team sign-in.) The choice is never saved on the device: shared tablets
// always open on Team, and logging out goes back to Team.
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
  function accountFor(role) {
    for (var i = 0; i < ACCOUNTS.length; i++) if (ACCOUNTS[i].role === role) return ACCOUNTS[i];
    return null;
  }

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
    if (c === 'hub/bad-pin') return err.hubRole === 'admin' ? 'Incorrect admin PIN' : 'Incorrect PIN';
    if (c === 'auth/too-many-requests') return 'Too many tries. Wait a few minutes and try again.';
    if (c === 'auth/network-request-failed') return 'No internet connection. Check Wi-Fi and try again.';
    return 'Login error: ' + ((err && err.message) || c || 'unknown');
  }

  // ---- Team / Admin choice on the PIN screen (added to every page's login box by this file) ----
  var mode = 'team';
  var ui = null; // { input, prompt, promptText, toggle, note }
  function wantsAdminFromAddress() {
    try { return /^#admin$/i.test(location.hash || ''); } catch (e) { return false; }
  }
  function renderMode() {
    if (!ui) return;
    var admin = mode === 'admin';
    if (ui.prompt) ui.prompt.textContent = admin ? 'Enter admin PIN to continue' : ui.promptText;
    ui.toggle.textContent = admin ? 'Team login' : 'Admin login';
    ui.toggle.setAttribute('aria-pressed', admin ? 'true' : 'false');
    ui.note.textContent = admin ? 'Admin login' : '';
    ui.input.style.borderColor = admin ? '#b8860b' : '';
    ui.input.setAttribute('aria-label', admin ? 'Admin PIN' : 'Team PIN');
  }
  function setMode(m) {
    mode = m === 'admin' ? 'admin' : 'team';
    if (ui) {
      if (!ui.input.disabled) ui.input.value = '';
      var errEl = document.getElementById('pin-error');
      if (errEl) errEl.textContent = '';
      renderMode();
    }
    return mode;
  }
  function installModeSwitch() {
    if (ui) return;
    var input = document.getElementById('pin-input');
    if (!input) return;
    var box = input.parentNode;
    var prompt = null;
    for (var el = input.previousElementSibling; el; el = el.previousElementSibling) if (el.tagName === 'P') { prompt = el; break; }
    var note = document.createElement('div');
    note.id = 'hub-login-mode-note';
    note.style.cssText = 'font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#b8860b;min-height:16px;margin:-4px 0 6px;';
    box.insertBefore(note, input);
    var wrap = document.createElement('div');
    wrap.id = 'hub-login-mode';
    wrap.style.cssText = 'margin-top:10px;';
    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.id = 'hub-admin-toggle';
    toggle.style.cssText = 'background:none;border:none;color:#2d5016;text-decoration:underline;font-size:14px;cursor:pointer;padding:8px 12px;';
    toggle.addEventListener('click', function (e) {
      e.preventDefault();
      if (input.disabled) return; // a sign-in is in progress
      setMode(mode === 'admin' ? 'team' : 'admin');
      try { input.focus(); } catch (x) {}
    });
    wrap.appendChild(toggle);
    var errEl = document.getElementById('pin-error');
    box.insertBefore(wrap, errEl && errEl.parentNode === box ? errEl.nextSibling : input.nextSibling);
    ui = { input: input, prompt: prompt, promptText: prompt ? prompt.textContent : '', toggle: toggle, note: note };
    mode = wantsAdminFromAddress() ? 'admin' : 'team';
    renderMode();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installModeSwitch);
  else installModeSwitch();
  window.addEventListener('hashchange', function () { if (wantsAdminFromAddress()) setMode('admin'); });

  // Check the PIN against ONE account: the one chosen on the screen (or `role` if a page passes it).
  // Resolves with 'team' or 'admin'. Exactly one Firebase sign-in attempt per PIN.
  function signInWithPin(pin, role) {
    clearOldLogins();
    installModeSwitch();
    var acct = accountFor(role || mode);
    var auth = firebase.auth();
    return auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).then(function () {
      return auth.signInWithEmailAndPassword(acct.email, pinToPassword(acct.role, pin));
    }).then(function () { saveSession(); return acct.role; }, function (err) {
      if (isWrongPin(err)) { var e = new Error('Incorrect PIN'); e.code = 'hub/bad-pin'; e.hubRole = acct.role; throw e; }
      throw err;
    });
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
    setMode(wantsAdminFromAddress() ? 'admin' : 'team');
    return firebase.auth().signOut().catch(function () {});
  }

  window.HubAuth = { signInWithPin: signInWithPin, restore: restore, signOut: signOut, friendlyError: friendlyError,
                     accounts: ACCOUNTS, setMode: setMode, getMode: function () { return mode; } };
})();
