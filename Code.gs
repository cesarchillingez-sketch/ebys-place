// ======================================================
// Eby's Place – Google Apps Script Backend  (Code.gs)
//
// WHICH GOOGLE ACCOUNT:
//   This script belongs to the account that originally created it.
//   If you use multiple Google accounts, sign in to each one at
//   script.google.com and look under "My Projects" to find it.
//
// HOW TO DEPLOY / UPDATE:
//   1. Open script.google.com under the owner account, open this project.
//   2. Paste the updated Code.gs content into the editor (or use clasp push).
//   3. Go to Project Settings → Script Properties and confirm these are set:
//        ADMIN_PASSWORD   your admin password
//        ADMIN_EMAIL      the email address that receives password-reset links
//        SPREADSHEET_ID   optional – your Google Sheet ID for bookings/orders
//   4. Deploy → Manage deployments → create a new version so the changes go live.
//      The deployment ID does not change; no edits to the HTML files are needed.
//
// ADMIN_PASSWORD is never stored in source code or sent to the browser.
// See README.md for the full setup guide.
// ======================================================

// ---- Session-token configuration ----
var TOKEN_EXPIRY_MS = 8 * 60 * 60 * 1000; // 8 hours
var TOKENS_KEY = 'SESSION_TOKENS'; // Script Property key – stores JSON map of { token: expiryMs }

// ---- Token helpers ----
function generateToken_() {
  return Utilities.getUuid();
}

function getTokenMap_() {
  var raw = PropertiesService.getScriptProperties().getProperty(TOKENS_KEY);
  try { return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; }
}

function saveTokenMap_(map) {
  PropertiesService.getScriptProperties().setProperty(TOKENS_KEY, JSON.stringify(map));
}

function purgeExpiredTokens_(map) {
  var now = Date.now();
  Object.keys(map).forEach(function(t) { if (map[t] < now) delete map[t]; });
  return map;
}

function storeToken_(token) {
  var map = purgeExpiredTokens_(getTokenMap_());
  map[token] = Date.now() + TOKEN_EXPIRY_MS;
  saveTokenMap_(map);
}

function isValidToken_(token) {
  if (!token) return false;
  var map = getTokenMap_();
  return Object.prototype.hasOwnProperty.call(map, token) && map[token] > Date.now();
}

function clearToken_(token) {
  var map = getTokenMap_();
  delete map[token];
  saveTokenMap_(map);
}

// ---- Response helper ----
function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ======================================================
// GET handler
// ======================================================
function doGet(e) {
  var type = e.parameter.type || '';

  // Token validation endpoint – no existing token needed
  if (type === 'VERIFY_TOKEN') {
    var t = e.parameter.sessionToken || '';
    return jsonResponse_({ success: isValidToken_(t) });
  }

  // GET_AVAILABILITY is also called by public-facing pages (no auth needed)
  if (type === 'GET_AVAILABILITY') {
    return handleGetAvailability_();
  }

  // All other GET endpoints require a valid session token
  var sessionToken = e.parameter.sessionToken || '';
  if (!isValidToken_(sessionToken)) {
    return jsonResponse_({ success: false, error: 'Unauthorized' });
  }

  if (type === 'GET_ORDERS')   return handleGetOrders_();
  if (type === 'GET_BOOKINGS') return handleGetBookings_();
  if (type === 'GET_REVIEWS')  return handleGetReviews_();

  return jsonResponse_({ success: false, error: 'Unknown type: ' + type });
}

// ======================================================
// POST handler
// ======================================================
function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse_({ success: false, error: 'Invalid JSON' });
  }

  var type = body.type || '';

  // Login – no existing token needed
  if (type === 'VERIFY_LOGIN') return handleVerifyLogin_(body);

  // Forgot password – no existing token needed (sends reset link by email)
  if (type === 'FORGOT_PASSWORD') return handleForgotPassword_();

  // Reset password via a valid reset token
  if (type === 'RESET_PASSWORD')  return handleResetPassword_(body);

  // Logout – clear only the caller's token
  if (type === 'LOGOUT') {
    clearToken_(body.sessionToken || '');
    return jsonResponse_({ success: true });
  }

  // All other POST endpoints require a valid session token
  var sessionToken = body.sessionToken || '';
  if (!isValidToken_(sessionToken)) {
    return jsonResponse_({ success: false, error: 'Unauthorized' });
  }

  if (type === 'SAVE_PRODUCTS')   return handleSaveProducts_(body);
  if (type === 'SAVE_AVAILABILITY') return handleSaveAvailability_(body);
  if (type === 'APPROVE_REVIEW')  return handleApproveReview_(body);
  if (type === 'UNAPPROVE_REVIEW') return handleUnapproveReview_(body);
  if (type === 'DELETE_REVIEW')   return handleDeleteReview_(body);

  return jsonResponse_({ success: false, error: 'Unknown type: ' + type });
}

// ======================================================
// Auth handlers
// ======================================================
function handleVerifyLogin_(body) {
  var props = PropertiesService.getScriptProperties();
  var adminPassword = props.getProperty('ADMIN_PASSWORD');
  if (!adminPassword) {
    return jsonResponse_({ success: false, error: 'Server not configured – add ADMIN_PASSWORD to Script Properties.' });
  }
  if (body.password !== adminPassword) {
    return jsonResponse_({ success: false, error: 'Incorrect password' });
  }
  var token = generateToken_();
  storeToken_(token);
  return jsonResponse_({ success: true, token: token });
}

// ======================================================
// Forgot-password / reset-password handlers
// ======================================================

var RESET_TOKEN_PREFIX  = 'RESET_TOKEN_';
var RESET_EXPIRY_MS     = 60 * 60 * 1000; // 1 hour

function handleForgotPassword_() {
  try {
    var props = PropertiesService.getScriptProperties();
    var adminEmail = props.getProperty('ADMIN_EMAIL');
    if (!adminEmail) {
      return jsonResponse_({ success: false, error: 'Reset email not configured – add ADMIN_EMAIL to Script Properties.' });
    }
    var token   = generateToken_();
    var expiry  = Date.now() + RESET_EXPIRY_MS;
    props.setProperty(RESET_TOKEN_PREFIX + token, String(expiry));
    var siteUrl  = props.getProperty('SITE_URL') || 'https://ebysplace.com';
    var resetUrl = siteUrl + '/admin.html?resetToken=' + encodeURIComponent(token);
    GmailApp.sendEmail(
      adminEmail,
      "Eby's Place – Admin Password Reset",
      "A password reset was requested for the Eby's Place admin portal.\n\n" +
      "Click the link below to set a new password. This link expires in 1 hour.\n\n" +
      resetUrl + "\n\n" +
      "If you did not request this, you can safely ignore this email – your password has not been changed."
    );
    return jsonResponse_({ success: true });
  } catch (err) {
    return jsonResponse_({ success: false, error: err.message });
  }
}

function handleResetPassword_(body) {
  try {
    var token       = body.resetToken   || '';
    var newPassword = body.newPassword  || '';
    if (!token || !newPassword) {
      return jsonResponse_({ success: false, error: 'Missing reset token or new password.' });
    }
    var props = PropertiesService.getScriptProperties();
    var key   = RESET_TOKEN_PREFIX + token;
    var expiryStr = props.getProperty(key);
    if (!expiryStr || Date.now() > parseInt(expiryStr, 10)) {
      if (expiryStr) props.deleteProperty(key); // clean up expired token
      return jsonResponse_({ success: false, error: 'Reset link has expired or is invalid. Please request a new one.' });
    }
    // Save new password, clear the used token, and invalidate all active sessions
    props.setProperty('ADMIN_PASSWORD', newPassword);
    props.deleteProperty(key);
    saveTokenMap_({}); // force re-login everywhere
    return jsonResponse_({ success: true });
  } catch (err) {
    return jsonResponse_({ success: false, error: err.message });
  }
}

// ======================================================
// Data handlers
// Adapt the sheet names / storage approach to match your
// existing script if you are merging this into existing code.
// ======================================================

function getSheet_(name) {
  // Replace SPREADSHEET_ID with your Google Sheets file ID,
  // or use SpreadsheetApp.getActiveSpreadsheet() if the script
  // is bound to a spreadsheet.
  var SPREADSHEET_ID = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || '';
  if (!SPREADSHEET_ID) return null;
  return SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(name);
}

function sheetToObjects_(sheet) {
  var rows = sheet.getDataRange().getValues();
  if (rows.length < 2) return [];
  var headers = rows[0];
  return rows.slice(1).map(function(row) {
    var obj = {};
    headers.forEach(function(h, i) { obj[h] = row[i]; });
    return obj;
  });
}

function handleGetOrders_() {
  try {
    var sheet = getSheet_('Orders');
    if (!sheet) return jsonResponse_({ success: false, error: 'Orders sheet not found' });
    return jsonResponse_({ success: true, orders: sheetToObjects_(sheet) });
  } catch (err) {
    return jsonResponse_({ success: false, error: err.message });
  }
}

function handleGetBookings_() {
  try {
    var sheet = getSheet_('Bookings');
    if (!sheet) return jsonResponse_({ success: false, error: 'Bookings sheet not found' });
    return jsonResponse_({ success: true, bookings: sheetToObjects_(sheet) });
  } catch (err) {
    return jsonResponse_({ success: false, error: err.message });
  }
}

function handleGetAvailability_() {
  try {
    var props = PropertiesService.getScriptProperties();
    var raw = props.getProperty('AVAILABILITY');
    return jsonResponse_({ success: true, availability: raw ? JSON.parse(raw) : {} });
  } catch (err) {
    return jsonResponse_({ success: false, error: err.message });
  }
}

function handleGetReviews_() {
  try {
    var props = PropertiesService.getScriptProperties();
    var raw = props.getProperty('REVIEWS');
    return jsonResponse_({ success: true, reviews: raw ? JSON.parse(raw) : [] });
  } catch (err) {
    return jsonResponse_({ success: false, error: err.message });
  }
}

function handleSaveProducts_(body) {
  try {
    PropertiesService.getScriptProperties().setProperty('PRODUCTS', JSON.stringify(body.products || []));
    return jsonResponse_({ success: true });
  } catch (err) {
    return jsonResponse_({ success: false, error: err.message });
  }
}

function handleSaveAvailability_(body) {
  try {
    PropertiesService.getScriptProperties().setProperty('AVAILABILITY', JSON.stringify(body.availability || {}));
    return jsonResponse_({ success: true });
  } catch (err) {
    return jsonResponse_({ success: false, error: err.message });
  }
}

function handleApproveReview_(body) {
  try {
    var props = PropertiesService.getScriptProperties();
    var reviews = JSON.parse(props.getProperty('REVIEWS') || '[]');
    var idx = reviews.findIndex(function(r) { return r.id === body.id; });
    if (idx !== -1) reviews[idx].approved = true;
    props.setProperty('REVIEWS', JSON.stringify(reviews));
    return jsonResponse_({ success: true });
  } catch (err) {
    return jsonResponse_({ success: false, error: err.message });
  }
}

function handleUnapproveReview_(body) {
  try {
    var props = PropertiesService.getScriptProperties();
    var reviews = JSON.parse(props.getProperty('REVIEWS') || '[]');
    var idx = reviews.findIndex(function(r) { return r.id === body.id; });
    if (idx !== -1) reviews[idx].approved = false;
    props.setProperty('REVIEWS', JSON.stringify(reviews));
    return jsonResponse_({ success: true });
  } catch (err) {
    return jsonResponse_({ success: false, error: err.message });
  }
}

function handleDeleteReview_(body) {
  try {
    var props = PropertiesService.getScriptProperties();
    var reviews = JSON.parse(props.getProperty('REVIEWS') || '[]');
    reviews = reviews.filter(function(r) { return r.id !== body.id; });
    props.setProperty('REVIEWS', JSON.stringify(reviews));
    return jsonResponse_({ success: true });
  } catch (err) {
    return jsonResponse_({ success: false, error: err.message });
  }
}
