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
//   4. Deploy → Manage deployments → create a new version so the changes go live.
// ======================================================

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

  if (type === 'BOOKING_DEPOSIT') return handleBookingDeposit_(body);
  if (type === 'DIRECT_SALE')     return handleDirectSale_(body);

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

    var sheet = getSheet_('Bookings');
    if (sheet) {
      sheet.appendRow([
        new Date(),
        body.customerName,
        body.email,
        body.item || '',
        amountPounds,
        body.stripeId,
        piId,
        body.bookingStart || '',
        body.bookingEnd   || ''
      ]);
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

    var sheet = getSheet_('Orders');
    if (sheet) {
      sheet.appendRow([
        new Date(),
        body.customerName,
        body.email,
        body.item    || '',
        amountPounds,
        body.address || '',
        body.stripeId,
        piId
      ]);
    }

    return jsonResponse_({ success: true, paymentIntentId: piId });
  } catch (err) {
    return jsonResponse_({ success: false, error: err.message });
  }
}
