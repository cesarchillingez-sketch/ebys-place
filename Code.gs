// ======================================================
// Eby's Place – Google Apps Script Backend  (Code.gs)
//
// HOW TO DEPLOY / UPDATE:
//   1. Open script.google.com under the owner account, open this project.
//   2. Paste this file content into the editor (or use clasp push).
//   3. Go to Project Settings → Script Properties and set ALL of these:
//        SPREADSHEET_ID        your Google Sheet ID
//        STRIPE_SECRET_KEY     your Stripe secret key
//        SITE_URL              your live site URL (e.g. https://ebysplace.com)
//        ADMIN_PASSWORD        your chosen admin password
//        RECOVERY_CODE_HASH    SHA-256 hex of your recovery code (use emn178.github.io/online-tools/sha256.html)
//        ADMIN_NAME            (optional) display name shown in the dashboard
//        ADMIN_EMAIL           (optional) notification email
//   4. Deploy → Manage deployments → New version so changes go live.
// ======================================================

// ======================================================
// Response helpers
// ======================================================
function jsonOk_(obj) {
  var out = obj || {};
  out.success = true;
  return ContentService
    .createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonErr_(msg) {
  return ContentService
    .createTextOutput(JSON.stringify({ success: false, error: msg }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ======================================================
// Auth helper – returns true only when the provided
// password matches the value in Script Properties.
// Falls back to DEFAULT_ADMIN_PASSWORD if ADMIN_PASSWORD
// has not been set in Script Properties yet.
// ======================================================
var DEFAULT_ADMIN_PASSWORD = 'ebysplace2024';

function checkAdmin_(pass) {
  var stored = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD') || DEFAULT_ADMIN_PASSWORD;
  return (typeof pass === 'string') && pass === stored.trim();
}

// ======================================================
// GET handler
// ======================================================
function doGet(e) {
  return jsonErr_('Not found');
}

// ======================================================
// POST handler
// ======================================================
function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonErr_('Invalid JSON');
  }

  var type = body.type || '';

  // ---- Public endpoints (no auth required) ----
  switch (type) {
    case 'BOOKING_DEPOSIT':      return handleBookingDeposit_(body);
    case 'DIRECT_SALE':          return handleDirectSale_(body);
    case 'TRACK_VISIT':          return handleTrackVisit_(body);
    case 'GET_AVAILABILITY':     return handleGetAvailability_();
  }

  // ---- Admin endpoints (require adminPassword) ----
  if (!checkAdmin_(body.adminPassword || '')) {
    return jsonErr_('Unauthorized');
  }

  switch (type) {
    case 'ADMIN_VERIFY':           return jsonOk_();
    case 'ADMIN_GET_BOOKINGS':     return adminGetBookings_();
    case 'ADMIN_GET_ORDERS':       return adminGetOrders_();
    case 'ADMIN_GET_ANALYTICS':    return adminGetAnalytics_();
    case 'ADMIN_GET_INVENTORY':    return adminGetInventory_();
    case 'ADMIN_GET_AVAILABILITY': return adminGetAvailability_();
    case 'ADMIN_SET_AVAILABILITY': return adminSetAvailability_(body);
    case 'ADMIN_UPDATE_INVENTORY': return adminUpdateInventory_(body);
    case 'ADMIN_SEND_EMAIL':       return adminSendEmail_(body);
    case 'ADMIN_CHANGE_PASSWORD':  return adminChangePassword_(body);
    case 'ADMIN_GET_PROFILE':      return adminGetProfile_();
    case 'ADMIN_UPDATE_PROFILE':   return adminUpdateProfile_(body);
  }

  return jsonErr_('Unknown type: ' + type);
}

// ======================================================
// Sheet helpers
// ======================================================

function ss_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('SPREADSHEET_ID is not set in Script Properties.');
  return SpreadsheetApp.openById(id);
}

function getSheet_(name) {
  try {
    return ss_().getSheetByName(name);
  } catch (e) {
    Logger.log('getSheet_ error: ' + e.message);
    return null;
  }
}

function getOrCreateSheet_(name, headers) {
  var spreadsheet;
  try {
    spreadsheet = ss_();
  } catch (e) {
    Logger.log('getOrCreateSheet_ error: ' + e.message);
    return null;
  }
  var sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(name);
    if (headers && headers.length) sheet.appendRow(headers);
  }
  return sheet;
}

function sheetRows_(sheet) {
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  var headers = data[0];
  return data.slice(1).map(function(row) {
    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      var val = row[j];
      obj[String(headers[j])] = val instanceof Date ? val.toISOString() : val;
    }
    return obj;
  });
}

// ======================================================
// Stripe payment helper
// Set STRIPE_SECRET_KEY in Script Properties — never in source code.
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

  var safeDesc = String(description).replace(/[\x00-\x1F\x7F]/g, '').slice(0, 255);

  var response = UrlFetchApp.fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'post',
    headers: { 'Authorization': 'Bearer ' + stripeKey },
    payload: {
      amount:         String(amountPence),
      currency:       'gbp',
      payment_method: stripeId,
      description:    safeDesc,
      confirm:        'true',
      return_url:     siteUrl
    },
    muteHttpExceptions: true
  });

  var result = JSON.parse(response.getContentText());

  if (result.error) {
    throw new Error(result.error.message);
  }
  if (result.status === 'requires_action' || result.status === 'requires_confirmation') {
    throw new Error('Your card requires additional authentication. Please use a different card or contact your bank.');
  }
  if (result.status !== 'succeeded') {
    throw new Error('Payment was not completed (status: ' + result.status + '). Please try again.');
  }

  return result.id; // PaymentIntent ID
}

// ======================================================
// Public handlers
// ======================================================

function handleBookingDeposit_(body) {
  try {
    if (!body.stripeId)                    return jsonErr_('Payment method is required.');
    if (!body.customerName || !body.email) return jsonErr_('Name and email are required.');

    var amountPounds = body.amount || 20;
    var safeItem = String(body.item || 'Appointment').replace(/[\x00-\x1F\x7F]/g, '').slice(0, 100);
    var piId = chargeStripe_(body.stripeId, amountPounds * 100, 'Eby\'s Place booking deposit – ' + safeItem);

    var sheet = getOrCreateSheet_('Bookings', ['Timestamp','Name','Email','Phone','Service','Amount','Address','County','DeliveryNote','StripeId','PaymentIntentId','BookingStart','BookingEnd','Status']);
    if (sheet) {
      sheet.appendRow([
        new Date(), body.customerName, body.email, body.phone || '',
        body.item || '', amountPounds, body.address || '', body.county || '',
        body.deliveryNote || '', body.stripeId, piId,
        body.bookingStart || '', body.bookingEnd || '', 'Confirmed'
      ]);
    }

    try {
      MailApp.sendEmail({
        to: 'ebysplace.uk@gmail.com',
        subject: 'New Booking – ' + safeItem,
        htmlBody: buildEmailHtml_(
          'New Booking Received',
          '<b>Client:</b> '    + esc_(body.customerName) + '<br>' +
          '<b>Email:</b> '     + esc_(body.email)        + '<br>' +
          '<b>Phone:</b> '     + esc_(body.phone || 'Not provided') + '<br>' +
          '<b>Service:</b> '   + esc_(safeItem)          + '<br>' +
          '<b>Date/Time:</b> ' + esc_(body.bookingStart || 'TBC') + '<br>' +
          '<b>Deposit:</b> £'  + amountPounds            + '<br>' +
          '<b>Address:</b> '   + esc_(body.address || 'Not provided') + '<br>' +
          (body.county       ? '<b>County:</b> '       + esc_(body.county)       + '<br>' : '') +
          (body.deliveryNote ? '<b>Delivery Note:</b> ' + esc_(body.deliveryNote) + '<br>' : '') +
          '<b>Payment ID:</b> ' + esc_(piId)
        )
      });
    } catch (mailErr) {
      Logger.log('Booking email failed: ' + mailErr.message);
    }

    return jsonOk_({ paymentIntentId: piId });
  } catch (err) {
    return jsonErr_(err.message);
  }
}

function handleDirectSale_(body) {
  try {
    if (!body.stripeId)                    return jsonErr_('Payment method is required.');
    if (!body.customerName || !body.email) return jsonErr_('Name and email are required.');

    var amountPounds = body.amount || 0;
    if (amountPounds <= 0) return jsonErr_('Invalid order amount.');

    var safeItem = String(body.item || 'Shop Order').replace(/[\x00-\x1F\x7F]/g, '').slice(0, 100);
    var piId = chargeStripe_(body.stripeId, Math.round(amountPounds * 100), 'Eby\'s Place shop order – ' + safeItem);

    var sheet = getOrCreateSheet_('Orders', ['Timestamp','Name','Email','Phone','Item','Amount','Address','County','DeliveryNote','StripeId','PaymentIntentId','Status']);
    if (sheet) {
      sheet.appendRow([
        new Date(), body.customerName, body.email, body.phone || '',
        body.item || '', amountPounds, body.address || '', body.county || '',
        body.deliveryNote || '', body.stripeId, piId, 'Processing'
      ]);
    }

    try {
      MailApp.sendEmail({
        to: 'ebysplace.uk@gmail.com',
        subject: 'New Shop Order – ' + safeItem,
        htmlBody: buildEmailHtml_(
          'New Shop Order',
          '<b>Customer:</b> ' + esc_(body.customerName) + '<br>' +
          '<b>Email:</b> '    + esc_(body.email)        + '<br>' +
          '<b>Phone:</b> '    + esc_(body.phone || 'Not provided') + '<br>' +
          '<b>Item:</b> '     + esc_(safeItem)          + '<br>' +
          '<b>Amount:</b> £'  + amountPounds            + '<br>' +
          '<b>Address:</b> '  + esc_(body.address || 'Not provided') + '<br>' +
          (body.county       ? '<b>County:</b> '        + esc_(body.county)       + '<br>' : '') +
          (body.deliveryNote ? '<b>Delivery Note:</b> ' + esc_(body.deliveryNote) + '<br>' : '') +
          '<b>Payment ID:</b> ' + esc_(piId)
        )
      });
    } catch (mailErr) {
      Logger.log('Order email failed: ' + mailErr.message);
    }

    return jsonOk_({ paymentIntentId: piId });
  } catch (err) {
    return jsonErr_(err.message);
  }
}

function handleTrackVisit_(body) {
  try {
    var sheet = getOrCreateSheet_('Visits', ['Timestamp','Page','Referrer','UserAgent']);
    if (sheet) {
      sheet.appendRow([
        new Date(),
        String(body.page      || '').slice(0, 100),
        String(body.referrer  || '').slice(0, 200),
        String(body.userAgent || '').slice(0, 200)
      ]);
    }
  } catch (e) {
    Logger.log('Track visit error: ' + e.message);
  }
  return jsonOk_();
}

function handleGetAvailability_() {
  var sheet = getSheet_('Availability');
  if (!sheet) {
    return jsonOk_({ availability: {
      '0': [],
      '1': [9,10,11,12,13,14,15,16,17],
      '2': [9,10,11,12,13,14,15,16,17],
      '3': [9,10,11,12,13,14,15,16,17],
      '4': [9,10,11,12,13,14,15,16,17],
      '5': [9,10,11,12,13,14,15,16,17],
      '6': [10,11,12,13,14,15,16]
    }});
  }
  var rows = sheet.getDataRange().getValues();
  var avail = {};
  for (var i = 1; i < rows.length; i++) {
    var dayIdx   = String(rows[i][0]);
    var hoursStr = String(rows[i][1] || '');
    avail[dayIdx] = hoursStr
      ? hoursStr.split(',').map(function(h) { return parseInt(h.trim(), 10); }).filter(function(h) { return !isNaN(h); })
      : [];
  }
  return jsonOk_({ availability: avail });
}

// ======================================================
// Admin readers
// ======================================================

function adminGetBookings_() {
  var sheet = getOrCreateSheet_('Bookings', ['Timestamp','Name','Email','Phone','Service','Amount','Address','County','DeliveryNote','StripeId','PaymentIntentId','BookingStart','BookingEnd','Status']);
  if (!sheet) return jsonOk_({ data: [] });
  return jsonOk_({ data: sheetRows_(sheet).reverse() });
}

function adminGetOrders_() {
  var sheet = getOrCreateSheet_('Orders', ['Timestamp','Name','Email','Phone','Item','Amount','Address','County','DeliveryNote','StripeId','PaymentIntentId','Status']);
  if (!sheet) return jsonOk_({ data: [] });
  return jsonOk_({ data: sheetRows_(sheet).reverse() });
}

function adminGetAnalytics_() {
  var sheet = getSheet_('Visits');
  if (!sheet) return jsonOk_({ data: [], summary: { total: 0, byPage: {} } });
  var rows   = sheetRows_(sheet);
  var byPage = {};
  rows.forEach(function(r) {
    var p = r['Page'] || 'unknown';
    byPage[p] = (byPage[p] || 0) + 1;
  });
  return jsonOk_({ data: rows.slice(-200).reverse(), summary: { total: rows.length, byPage: byPage } });
}

function adminGetInventory_() {
  var sheet = getOrCreateSheet_('Inventory', ['ProductId','Name','Description','Price','Stock','Category','ImageUrl','Active']);
  if (!sheet) return jsonOk_({ data: [] });
  return jsonOk_({ data: sheetRows_(sheet) });
}

function adminGetAvailability_() {
  var sheet = getOrCreateSheet_('Availability', ['DayIndex','Hours','Notes']);
  if (!sheet) return jsonOk_({ data: {} });
  var rows  = sheet.getDataRange().getValues();
  var avail = { '0':[],'1':[],'2':[],'3':[],'4':[],'5':[],'6':[] };
  for (var i = 1; i < rows.length; i++) {
    var dayIdx   = String(rows[i][0]);
    var hoursStr = String(rows[i][1] || '');
    avail[dayIdx] = hoursStr
      ? hoursStr.split(',').map(function(h) { return parseInt(h.trim(), 10); }).filter(function(h) { return !isNaN(h); })
      : [];
  }
  return jsonOk_({ data: avail });
}

// ======================================================
// Admin writers
// ======================================================

function adminSetAvailability_(body) {
  var sheet = getOrCreateSheet_('Availability', ['DayIndex','Hours','Notes']);
  if (!sheet) return jsonErr_('Spreadsheet not configured.');
  var avail   = body.availability || {};
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.deleteRows(2, lastRow - 1);
  for (var d = 0; d <= 6; d++) {
    var hours = avail[String(d)] || avail[d] || [];
    sheet.appendRow([d, hours.join(','), '']);
  }
  return jsonOk_();
}

function adminUpdateInventory_(body) {
  var sheet = getOrCreateSheet_('Inventory', ['ProductId','Name','Description','Price','Stock','Category','ImageUrl','Active']);
  if (!sheet) return jsonErr_('Spreadsheet not configured.');

  var action = body.action || '';

  if (action === 'add') {
    var id = Utilities.getUuid();
    sheet.appendRow([
      id, body.name || '', body.description || '', body.price || 0,
      body.stock || 0, body.category || '', body.imageUrl || '',
      body.active !== false ? 'TRUE' : 'FALSE'
    ]);
    return jsonOk_({ productId: id });
  }

  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(body.productId)) {
      if (action === 'update') {
        if (body.name        !== undefined) sheet.getRange(i+1,2).setValue(body.name);
        if (body.description !== undefined) sheet.getRange(i+1,3).setValue(body.description);
        if (body.price       !== undefined) sheet.getRange(i+1,4).setValue(body.price);
        if (body.stock       !== undefined) sheet.getRange(i+1,5).setValue(body.stock);
        if (body.category    !== undefined) sheet.getRange(i+1,6).setValue(body.category);
        if (body.imageUrl    !== undefined) sheet.getRange(i+1,7).setValue(body.imageUrl);
        if (body.active      !== undefined) sheet.getRange(i+1,8).setValue(body.active ? 'TRUE' : 'FALSE');
        return jsonOk_();
      }
      if (action === 'delete') {
        sheet.deleteRow(i+1);
        return jsonOk_();
      }
    }
  }
  return jsonErr_('Product not found.');
}

function adminSendEmail_(body) {
  var to      = String(body.to      || 'ebysplace.uk@gmail.com').slice(0, 200);
  var subject = String(body.subject || 'Message from Eby\'s Place').slice(0, 200);
  var message = String(body.message || '');
  if (!message) return jsonErr_('Message is required.');
  try {
    MailApp.sendEmail({ to: to, subject: subject, htmlBody: buildEmailHtml_(subject, message.replace(/\n/g, '<br>')) });
    return jsonOk_();
  } catch (err) {
    return jsonErr_(err.message);
  }
}

function adminChangePassword_(body) {
  var newPass = String(body.newPassword || '');
  if (newPass.length < 8) return jsonErr_('Password must be at least 8 characters.');
  PropertiesService.getScriptProperties().setProperty('ADMIN_PASSWORD', newPass);
  return jsonOk_();
}

function adminGetProfile_() {
  var props = PropertiesService.getScriptProperties();
  return jsonOk_({
    name:  props.getProperty('ADMIN_NAME')  || '',
    email: props.getProperty('ADMIN_EMAIL') || ''
  });
}

function adminUpdateProfile_(body) {
  var props = PropertiesService.getScriptProperties();
  props.setProperty('ADMIN_NAME',  String(body.name  || '').trim().slice(0, 100));
  props.setProperty('ADMIN_EMAIL', String(body.email || '').trim().slice(0, 200));
  return jsonOk_();
}

// ======================================================
// Email helpers
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
    '<p style="margin:0;color:#C2A378;font-size:12px;text-align:center;">© Eby\'s Place</p></td></tr>' +
    '</table></td></tr></table></body></html>';
}

function esc_(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
