// ======================================================
// Eby's Place – Google Apps Script Backend  (Code.gs)
//
// HOW TO DEPLOY / UPDATE:
//   1. Open script.google.com under the owner account, open this project.
//   2. Paste the updated Code.gs content into the editor (or use clasp push).
//   3. Go to Project Settings → Script Properties and confirm these are set:
//        STRIPE_SECRET_KEY   your Stripe secret key
//        SITE_URL            your site URL (e.g. https://ebysplace.com)
//        SPREADSHEET_ID      your Google Sheet ID for bookings/orders
//        ADMIN_PASSWORD      admin dashboard password (default: EbysPlace@2025)
//   4. Deploy → Manage deployments → create a new version so the changes go live.
// ======================================================

// ---- Response helper ----
function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---- Admin auth helper ----
function isAdminValid_(pass) {
  var stored = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD') || 'EbysPlace@2025';
  return (typeof pass === 'string') && pass === stored;
}

// ---- SHA-256 helper (returns lowercase hex string) ----
function computeSha256Hash_(input) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, input, Utilities.Charset.UTF_8);
  return bytes.map(function(b) { return (b < 0 ? b + 256 : b).toString(16).padStart(2, '0'); }).join('');
}

// ======================================================
// GET handler
// ======================================================
function doGet(e) {
  return jsonResponse_({ success: false, error: 'Not found' });
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

  // ---- Public endpoints (no auth) ----
  if (type === 'BOOKING_DEPOSIT')       return handleBookingDeposit_(body);
  if (type === 'DIRECT_SALE')           return handleDirectSale_(body);
  if (type === 'TRACK_VISIT')           return handleTrackVisit_(body);
  if (type === 'GET_AVAILABILITY')      return handleGetAvailability_();
  if (type === 'ADMIN_RESET_PASSWORD')  return adminResetPassword_(body);

  // ---- Admin endpoints (require adminPassword) ----
  if (!isAdminValid_(body.adminPassword || '')) {
    return jsonResponse_({ success: false, error: 'Unauthorized' });
  }

  if (type === 'ADMIN_VERIFY')            return jsonResponse_({ success: true });
  if (type === 'ADMIN_GET_BOOKINGS')      return adminGetBookings_();
  if (type === 'ADMIN_GET_ORDERS')        return adminGetOrders_();
  if (type === 'ADMIN_GET_ANALYTICS')     return adminGetAnalytics_();
  if (type === 'ADMIN_GET_INVENTORY')     return adminGetInventory_();
  if (type === 'ADMIN_GET_AVAILABILITY')  return adminGetAvailability_();
  if (type === 'ADMIN_SET_AVAILABILITY')  return adminSetAvailability_(body);
  if (type === 'ADMIN_UPDATE_INVENTORY')  return adminUpdateInventory_(body);
  if (type === 'ADMIN_SEND_EMAIL')        return adminSendEmail_(body);
  if (type === 'ADMIN_CHANGE_PASSWORD')   return adminChangePassword_(body);
  if (type === 'ADMIN_GET_PROFILE')       return adminGetProfile_();
  if (type === 'ADMIN_UPDATE_PROFILE')    return adminUpdateProfile_(body);

  return jsonResponse_({ success: false, error: 'Unknown type: ' + type });
}

// ======================================================
// Sheet helpers
// ======================================================
function getSheet_(name) {
  var SPREADSHEET_ID = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || '';
  if (!SPREADSHEET_ID) return null;
  return SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(name);
}

function getOrCreateSheet_(name, headers) {
  var SPREADSHEET_ID = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || '';
  if (!SPREADSHEET_ID) return null;
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (headers && headers.length) sheet.appendRow(headers);
  }
  return sheet;
}

function sheetToObjects_(sheet) {
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  var headers = data[0];
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      var val = data[i][j];
      obj[String(headers[j])] = val instanceof Date ? val.toISOString() : val;
    }
    rows.push(obj);
  }
  return rows;
}

// ======================================================
// Payment handlers (BOOKING_DEPOSIT & DIRECT_SALE)
// No session token required – called from public-facing pages.
//
// Set STRIPE_SECRET_KEY in Script Properties to enable
// server-side Stripe PaymentIntent creation.  The key is
// never stored in source code.
// ======================================================

function chargeStripe_(stripeId, amountPence, description) {
  if (!stripeId || typeof stripeId !== 'string') {
    throw new Error('Payment method is required.');
  }

  var props = PropertiesService.getScriptProperties();
  var stripeKey = props.getProperty('STRIPE_SECRET_KEY');
  if (!stripeKey) {
    throw new Error('Payment system not configured. Add STRIPE_SECRET_KEY to Script Properties.');
  }

  var siteUrl = props.getProperty('SITE_URL');
  if (!siteUrl) {
    throw new Error('SITE_URL is not configured in Script Properties.');
  }

  // Sanitize description: strip control characters and limit length
  var safeDescription = String(description).replace(/[\x00-\x1F\x7F]/g, '').slice(0, 255);

  var response = UrlFetchApp.fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'post',
    headers: { 'Authorization': 'Bearer ' + stripeKey },
    payload: {
      amount: String(amountPence),
      currency: 'gbp',
      payment_method: stripeId,
      description: safeDescription,
      confirm: 'true',
      return_url: siteUrl
    },
    muteHttpExceptions: true
  });

  var data = JSON.parse(response.getContentText());

  if (data.error) {
    throw new Error(data.error.message);
  }
  if (data.status === 'requires_action' || data.status === 'requires_confirmation') {
    throw new Error('Your card requires additional authentication. Please use a different card or contact your bank.');
  }
  if (data.status !== 'succeeded') {
    throw new Error('Payment was not completed (status: ' + data.status + '). Please try again.');
  }

  return data.id; // PaymentIntent ID
}

function handleBookingDeposit_(body) {
  try {
    if (!body.stripeId) {
      return jsonResponse_({ success: false, error: 'Payment method is required.' });
    }
    if (!body.customerName || !body.email) {
      return jsonResponse_({ success: false, error: 'Name and email are required.' });
    }

    var amountPounds = body.amount || 20;
    var safeItem = String(body.item || 'Appointment').replace(/[\x00-\x1F\x7F]/g, '').slice(0, 100);
    var description = 'Eby\'s Place booking deposit – ' + safeItem;
    var piId = chargeStripe_(body.stripeId, amountPounds * 100, description);

    var sheet = getOrCreateSheet_('Bookings', ['Timestamp','Name','Email','Phone','Service','Amount','Address','County','DeliveryNote','StripeId','PaymentIntentId','BookingStart','BookingEnd','Status']);
    if (sheet) {
      sheet.appendRow([
        new Date(),
        body.customerName,
        body.email,
        body.phone || '',
        body.item || '',
        amountPounds,
        body.address || '',
        body.county || '',
        body.deliveryNote || '',
        body.stripeId,
        piId,
        body.bookingStart || '',
        body.bookingEnd   || '',
        'Confirmed'
      ]);
    }

    // Email notification to admin
    try {
      MailApp.sendEmail({
        to: 'ebysplace.uk@gmail.com',
        subject: 'New Booking – ' + safeItem,
        htmlBody: buildEmailHtml_(
          'New Booking Received',
          '<b>Client:</b> ' + escapeHtmlGs_(body.customerName) + '<br>' +
          '<b>Email:</b> ' + escapeHtmlGs_(body.email) + '<br>' +
          '<b>Phone:</b> ' + escapeHtmlGs_(body.phone || 'Not provided') + '<br>' +
          '<b>Service:</b> ' + escapeHtmlGs_(safeItem) + '<br>' +
          '<b>Date/Time:</b> ' + escapeHtmlGs_(body.bookingStart || 'TBC') + '<br>' +
          '<b>Deposit:</b> £' + amountPounds + '<br>' +
          '<b>Delivery Address:</b> ' + escapeHtmlGs_(body.address || 'Not provided') + '<br>' +
          (body.county ? '<b>County:</b> ' + escapeHtmlGs_(body.county) + '<br>' : '') +
          (body.deliveryNote ? '<b>Delivery Note:</b> ' + escapeHtmlGs_(body.deliveryNote) + '<br>' : '') +
          '<b>Payment ID:</b> ' + escapeHtmlGs_(piId)
        )
      });
    } catch (mailErr) {
      Logger.log('Booking email failed: ' + mailErr.message);
    }

    return jsonResponse_({ success: true, paymentIntentId: piId });
  } catch (err) {
    return jsonResponse_({ success: false, error: err.message });
  }
}

function handleDirectSale_(body) {
  try {
    if (!body.stripeId) {
      return jsonResponse_({ success: false, error: 'Payment method is required.' });
    }
    if (!body.customerName || !body.email) {
      return jsonResponse_({ success: false, error: 'Name and email are required.' });
    }

    var amountPounds = body.amount || 0;
    if (amountPounds <= 0) {
      return jsonResponse_({ success: false, error: 'Invalid order amount.' });
    }

    var safeItem = String(body.item || 'Shop Order').replace(/[\x00-\x1F\x7F]/g, '').slice(0, 100);
    var description = 'Eby\'s Place shop order – ' + safeItem;
    var piId = chargeStripe_(body.stripeId, Math.round(amountPounds * 100), description);

    var sheet = getOrCreateSheet_('Orders', ['Timestamp','Name','Email','Phone','Item','Amount','Address','County','DeliveryNote','StripeId','PaymentIntentId','Status']);
    if (sheet) {
      sheet.appendRow([
        new Date(),
        body.customerName,
        body.email,
        body.phone || '',
        body.item    || '',
        amountPounds,
        body.address || '',
        body.county  || '',
        body.deliveryNote || '',
        body.stripeId,
        piId,
        'Processing'
      ]);
    }

    // Email notification to admin
    try {
      MailApp.sendEmail({
        to: 'ebysplace.uk@gmail.com',
        subject: 'New Shop Order – ' + safeItem,
        htmlBody: buildEmailHtml_(
          'New Shop Order',
          '<b>Customer:</b> ' + escapeHtmlGs_(body.customerName) + '<br>' +
          '<b>Email:</b> ' + escapeHtmlGs_(body.email) + '<br>' +
          '<b>Phone:</b> ' + escapeHtmlGs_(body.phone || 'Not provided') + '<br>' +
          '<b>Item:</b> ' + escapeHtmlGs_(safeItem) + '<br>' +
          '<b>Amount:</b> £' + amountPounds + '<br>' +
          '<b>Delivery Address:</b> ' + escapeHtmlGs_(body.address || 'Not provided') + '<br>' +
          (body.county ? '<b>County:</b> ' + escapeHtmlGs_(body.county) + '<br>' : '') +
          (body.deliveryNote ? '<b>Delivery Note:</b> ' + escapeHtmlGs_(body.deliveryNote) + '<br>' : '') +
          '<b>Payment ID:</b> ' + escapeHtmlGs_(piId)
        )
      });
    } catch (mailErr) {
      Logger.log('Order email failed: ' + mailErr.message);
    }

    return jsonResponse_({ success: true, paymentIntentId: piId });
  } catch (err) {
    return jsonResponse_({ success: false, error: err.message });
  }
}

// ======================================================
// Visit tracking (public – no auth)
// ======================================================
function handleTrackVisit_(body) {
  try {
    var sheet = getOrCreateSheet_('Visits', ['Timestamp','Page','Referrer','UserAgent']);
    if (sheet) {
      sheet.appendRow([
        new Date(),
        String(body.page     || '').slice(0, 100),
        String(body.referrer || '').slice(0, 200),
        String(body.userAgent || '').slice(0, 200)
      ]);
    }
  } catch (e) {
    Logger.log('Track visit error: ' + e.message);
  }
  return jsonResponse_({ success: true });
}

// ======================================================
// Public availability fetch (used by booking.html)
// ======================================================
function handleGetAvailability_() {
  var sheet = getSheet_('Availability');
  if (!sheet) {
    // Default: 9–17 Mon–Sat, closed Sunday
    return jsonResponse_({ success: true, availability: {
      '0': [], '1': [9,10,11,12,13,14,15,16,17],
      '2': [9,10,11,12,13,14,15,16,17],
      '3': [9,10,11,12,13,14,15,16,17],
      '4': [9,10,11,12,13,14,15,16,17],
      '5': [9,10,11,12,13,14,15,16,17],
      '6': [10,11,12,13,14,15,16]
    }});
  }
  var data = sheet.getDataRange().getValues();
  var avail = {};
  for (var i = 1; i < data.length; i++) {
    var dayIdx = String(data[i][0]);
    var hoursStr = String(data[i][1] || '');
    avail[dayIdx] = hoursStr
      ? hoursStr.split(',').map(function(h) { return parseInt(h.trim(), 10); }).filter(function(h) { return !isNaN(h); })
      : [];
  }
  return jsonResponse_({ success: true, availability: avail });
}

// ======================================================
// Admin data readers
// ======================================================
function adminGetBookings_() {
  var sheet = getOrCreateSheet_('Bookings', ['Timestamp','Name','Email','Phone','Service','Amount','Address','County','DeliveryNote','StripeId','PaymentIntentId','BookingStart','BookingEnd','Status']);
  if (!sheet) return jsonResponse_({ success: true, data: [] });
  return jsonResponse_({ success: true, data: sheetToObjects_(sheet).reverse() });
}

function adminGetOrders_() {
  var sheet = getOrCreateSheet_('Orders', ['Timestamp','Name','Email','Phone','Item','Amount','Address','County','DeliveryNote','StripeId','PaymentIntentId','Status']);
  if (!sheet) return jsonResponse_({ success: true, data: [] });
  return jsonResponse_({ success: true, data: sheetToObjects_(sheet).reverse() });
}

function adminGetAnalytics_() {
  var sheet = getSheet_('Visits');
  if (!sheet) return jsonResponse_({ success: true, data: [], summary: { total: 0, byPage: {} } });
  var rows = sheetToObjects_(sheet);
  var byPage = {};
  rows.forEach(function(r) {
    var p = r['Page'] || 'unknown';
    byPage[p] = (byPage[p] || 0) + 1;
  });
  return jsonResponse_({ success: true, data: rows.slice(-200).reverse(), summary: { total: rows.length, byPage: byPage } });
}

function adminGetInventory_() {
  var sheet = getOrCreateSheet_('Inventory', ['ProductId','Name','Description','Price','Stock','Category','ImageUrl','Active']);
  if (!sheet) return jsonResponse_({ success: true, data: [] });
  return jsonResponse_({ success: true, data: sheetToObjects_(sheet) });
}

function adminGetAvailability_() {
  var sheet = getOrCreateSheet_('Availability', ['DayIndex','Hours','Notes']);
  if (!sheet) return jsonResponse_({ success: true, data: {} });
  var data = sheet.getDataRange().getValues();
  var avail = { '0':[],'1':[],'2':[],'3':[],'4':[],'5':[],'6':[] };
  for (var i = 1; i < data.length; i++) {
    var dayIdx = String(data[i][0]);
    var hoursStr = String(data[i][1] || '');
    avail[dayIdx] = hoursStr
      ? hoursStr.split(',').map(function(h) { return parseInt(h.trim(), 10); }).filter(function(h) { return !isNaN(h); })
      : [];
  }
  return jsonResponse_({ success: true, data: avail });
}

// ======================================================
// Admin data writers
// ======================================================
function adminSetAvailability_(body) {
  var sheet = getOrCreateSheet_('Availability', ['DayIndex','Hours','Notes']);
  if (!sheet) return jsonResponse_({ success: false, error: 'Spreadsheet not configured.' });
  var avail = body.availability || {};
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.deleteRows(2, lastRow - 1);
  for (var d = 0; d <= 6; d++) {
    var hours = avail[String(d)] || avail[d] || [];
    sheet.appendRow([d, hours.join(','), '']);
  }
  return jsonResponse_({ success: true });
}

function adminUpdateInventory_(body) {
  var sheet = getOrCreateSheet_('Inventory', ['ProductId','Name','Description','Price','Stock','Category','ImageUrl','Active']);
  if (!sheet) return jsonResponse_({ success: false, error: 'Spreadsheet not configured.' });

  var action = body.action || '';
  if (action === 'add') {
    var id = Utilities.getUuid();
    sheet.appendRow([id, body.name||'', body.description||'', body.price||0, body.stock||0, body.category||'', body.imageUrl||'', body.active!==false?'TRUE':'FALSE']);
    return jsonResponse_({ success: true, productId: id });
  }

  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(body.productId)) {
      if (action === 'update') {
        if (body.name        !== undefined) sheet.getRange(i+1,2).setValue(body.name);
        if (body.description !== undefined) sheet.getRange(i+1,3).setValue(body.description);
        if (body.price       !== undefined) sheet.getRange(i+1,4).setValue(body.price);
        if (body.stock       !== undefined) sheet.getRange(i+1,5).setValue(body.stock);
        if (body.category    !== undefined) sheet.getRange(i+1,6).setValue(body.category);
        if (body.imageUrl    !== undefined) sheet.getRange(i+1,7).setValue(body.imageUrl);
        if (body.active      !== undefined) sheet.getRange(i+1,8).setValue(body.active?'TRUE':'FALSE');
        return jsonResponse_({ success: true });
      }
      if (action === 'delete') {
        sheet.deleteRow(i+1);
        return jsonResponse_({ success: true });
      }
    }
  }
  return jsonResponse_({ success: false, error: action === 'add' ? 'Add failed.' : 'Product not found.' });
}

function adminSendEmail_(body) {
  var to      = String(body.to      || 'ebysplace.uk@gmail.com').slice(0, 200);
  var subject = String(body.subject || 'Message from Eby\'s Place Admin').slice(0, 200);
  var message = String(body.message || '');
  if (!message) return jsonResponse_({ success: false, error: 'Message is required.' });
  try {
    MailApp.sendEmail({ to: to, subject: subject, htmlBody: buildEmailHtml_(subject, message.replace(/\n/g, '<br>')) });
    return jsonResponse_({ success: true });
  } catch (err) {
    return jsonResponse_({ success: false, error: err.message });
  }
}

function adminChangePassword_(body) {
  var newPass = String(body.newPassword || '');
  if (newPass.length < 8) return jsonResponse_({ success: false, error: 'Password must be at least 8 characters.' });
  PropertiesService.getScriptProperties().setProperty('ADMIN_PASSWORD', newPass);
  return jsonResponse_({ success: true });
}

// ======================================================
// Admin profile (display name + notification email)
// ======================================================
function adminGetProfile_() {
  var props = PropertiesService.getScriptProperties();
  return jsonResponse_({
    success: true,
    name:  props.getProperty('ADMIN_NAME')  || '',
    email: props.getProperty('ADMIN_EMAIL') || ''
  });
}

function adminUpdateProfile_(body) {
  var props = PropertiesService.getScriptProperties();
  var name  = String(body.name  || '').trim().slice(0, 100);
  var email = String(body.email || '').trim().slice(0, 200);
  if (name)  props.setProperty('ADMIN_NAME',  name);
  if (email) props.setProperty('ADMIN_EMAIL', email);
  return jsonResponse_({ success: true });
}

// SHA-256 hash of the default recovery code (set RECOVERY_CODE_HASH in Script Properties to override).
var DEFAULT_RECOV_HASH_ = '8d8bb5f5659031afb506d3f3287d2d3bc8f99cb03e3c3cf8952c84d2efce0279';

function adminResetPassword_(body) {
  var code    = String(body.recoveryCode || '');
  var newPass = String(body.newPassword  || '');
  if (!code)              return jsonResponse_({ success: false, error: 'Recovery code is required.' });
  if (newPass.length < 8) return jsonResponse_({ success: false, error: 'Password must be at least 8 characters.' });

  // Compute SHA-256 of the supplied recovery code and compare to the stored hash.
  var hex        = computeSha256Hash_(code);
  var storedHash = PropertiesService.getScriptProperties().getProperty('RECOVERY_CODE_HASH') || DEFAULT_RECOV_HASH_;
  if (hex !== storedHash) return jsonResponse_({ success: false, error: 'Invalid recovery code.' });

  PropertiesService.getScriptProperties().setProperty('ADMIN_PASSWORD', newPass);
  return jsonResponse_({ success: true });
}

// ======================================================
// Email template helper
// ======================================================
function buildEmailHtml_(title, bodyHtml) {
  return '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#FCFBF8;font-family:Georgia,serif;">' +
    '<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 20px;">' +
    '<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E5DDD3;">' +
    '<tr><td style="background:#2A1A12;padding:32px 40px;">' +
    '<h1 style="margin:0;color:#C2A378;font-size:28px;letter-spacing:2px;">Eby\'s Place</h1></td></tr>' +
    '<tr><td style="padding:40px;">' +
    '<h2 style="margin:0 0 20px;color:#2A1A12;font-size:20px;">' + title + '</h2>' +
    '<div style="color:#6B5749;line-height:1.8;font-size:15px;">' + bodyHtml + '</div></td></tr>' +
    '<tr><td style="padding:24px 40px;background:#F4EFE6;border-top:1px solid #E5DDD3;">' +
    '<p style="margin:0;color:#C2A378;font-size:12px;text-align:center;">Sent from Eby\'s Place Admin Dashboard</p></td></tr>' +
    '</table></td></tr></table></body></html>';
}

function escapeHtmlGs_(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
