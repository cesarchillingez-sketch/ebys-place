# Eby's Place – Setup Guide

This site is a static front-end (HTML/CSS/JS) deployed via **GitHub Pages**, backed by a **Google Apps Script** web app that handles bookings, orders, reviews, and admin authentication.

---

## 1 – Which Google account to use

The Apps Script project is tied to the Google account that **originally created it**.  
Because you use multiple Google accounts, here is how to identify the right one:

1. Open [script.google.com](https://script.google.com) while signed into each of your Google accounts in turn.
2. Under **My Projects**, look for the project that contains `Code.gs` (the file in this repository).
3. The account where the project appears is the one that owns the deployment.

> **Note:** For security, the deployment ID is not published in this repository. You can find it in the Apps Script editor under **Deploy → Manage deployments**, or in the source of any HTML page in this repo (search for `GAS_URL`).

---

## 2 – First-time setup (Script Properties)

Once you have identified the correct account and opened the project:

1. In the Apps Script editor, click ⚙️ **Project Settings** (gear icon on the left).
2. Scroll to **Script Properties** and click **Add script property** for each row below:

| Property key        | Value / Notes                                      |
|---------------------|----------------------------------------------------|
| `ADMIN_PASSWORD`    | Your admin password (**keep secret – never commit to GitHub**) |
| `ADMIN_EMAIL`       | The email address that receives password-reset links (e.g. your Yahoo address) |
| `SITE_URL`          | Your site's root URL, e.g. `https://ebysplace.com` (used in reset-link emails and as the Stripe `return_url`) |
| `STRIPE_SECRET_KEY` | Your Stripe **secret** key (starts with `sk_live_` or `sk_test_`). **Never commit to GitHub.** Found in the Stripe Dashboard → Developers → API keys. |
| `SPREADSHEET_ID`    | Optional – your Google Sheet ID for bookings/orders. Found in the Sheet URL: `https://docs.google.com/spreadsheets/d/<ID>/edit` |

> **Important:** `ADMIN_PASSWORD` and `STRIPE_SECRET_KEY` live only in Script Properties. They are **never** stored in source code or sent to the browser.

---

## 3 – Deploying / updating the script

Whenever you update `Code.gs`:

1. Copy the new `Code.gs` content into the Apps Script editor (or use `clasp push` if you have the CLI set up).
2. Click **Deploy → Manage deployments**.
3. Edit the existing deployment → set **Version** to *"New version"* → click **Deploy**.
4. The deployment ID stays the same; no changes are needed in the HTML files.

---

## 4 – Changing the admin password

**Via Script Properties (no reset flow):**
1. Go to the Apps Script project → ⚙️ **Project Settings → Script Properties**.
2. Edit the value of `ADMIN_PASSWORD`.
3. No redeployment is needed.

**Via the "Forgot password?" link (security breach / forgotten password):**
1. On the admin login page, click **Forgot password?**
2. The script emails a one-hour reset link to the address stored in `ADMIN_EMAIL`.
3. Click the link in the email, enter and confirm a new password.
4. All existing login sessions are invalidated automatically.

---

## 5 – GitHub Pages deployment

The HTML files are served automatically by GitHub Pages from the `main` branch.  
The workflow is defined in `.github/workflows/static.yml`.  
No build step is required – push to `main` and the site updates within a minute or two.

