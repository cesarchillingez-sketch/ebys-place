# Eby's Place – Setup Guide

This site is a static front-end (HTML/CSS/JS) deployed via **GitHub Pages**, backed by a **Google Apps Script** web app that handles bookings, orders, reviews, and admin authentication.

---

## 1 – Which Google account to use

The Apps Script project is tied to the Google account that **originally created it**.  
Because you use multiple Google accounts, here is how to identify the right one:

1. Open [script.google.com](https://script.google.com) while signed into each of your Google accounts in turn.
2. Under **My Projects**, look for the project that contains `Code.gs` (the file in this repository).
3. The account where the project appears is the one that owns the deployment.

**Current deployment ID** (hardcoded in every HTML page in this repo):

```
AKfycbyMRtBwJEeSJpzkuASeHzorBE3Zqb4PzW41rZmnrn2lT5KjbHgP-KweFDJg3yxin7aCUg
```

Full web-app URL:
```
https://script.google.com/macros/s/AKfycbyMRtBwJEeSJpzkuASeHzorBE3Zqb4PzW41rZmnrn2lT5KjbHgP-KweFDJg3yxin7aCUg/exec
```

You can paste that URL into any browser – if you are signed into the **owner** account you will see the raw JSON response from the script. If you are signed into the wrong account the request will still work (the script is deployed to run as the owner, accessible to anyone), but only the owner account will see the project in **My Projects** on script.google.com.

---

## 2 – First-time setup (Script Properties)

Once you have identified the correct account and opened the project:

1. In the Apps Script editor, click ⚙️ **Project Settings** (gear icon on the left).
2. Scroll to **Script Properties** and click **Add script property** for each row below:

| Property key       | Value                                      |
|--------------------|--------------------------------------------|
| `ADMIN_PASSWORD`   | Your chosen admin password (keep it secret)|
| `SPREADSHEET_ID`   | The ID of your Google Sheet (optional – only needed if you want bookings/orders stored in Sheets). The ID is the long string in the Sheet URL: `https://docs.google.com/spreadsheets/d/<ID>/edit` |

> **Important:** `ADMIN_PASSWORD` is the *only* place the password lives. It is never stored in source code or sent to the browser.

---

## 3 – Deploying / updating the script

Whenever you update `Code.gs`:

1. Copy the new `Code.gs` content into the Apps Script editor (or use `clasp push` if you have the CLI set up).
2. Click **Deploy → Manage deployments**.
3. Edit the existing deployment → set **Version** to *"New version"* → click **Deploy**.
4. The deployment ID stays the same; no changes are needed in the HTML files.

---

## 4 – Changing the admin password

1. Go to the Apps Script project → ⚙️ **Project Settings → Script Properties**.
2. Edit the value of `ADMIN_PASSWORD`.
3. No redeployment is needed – the script reads the property on every login request.

---

## 5 – GitHub Pages deployment

The HTML files are served automatically by GitHub Pages from the `main` branch.  
The workflow is defined in `.github/workflows/static.yml`.  
No build step is required – push to `main` and the site updates within a minute or two.
