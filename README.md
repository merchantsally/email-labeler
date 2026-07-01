# email-labeler

A dead-simple Google Apps Script that auto-labels incoming Gmail. **Label only** —
it never archives, moves, deletes, or marks anything read. Everything stays in your
inbox; the labels just make the important stuff easy to find.

## The label scheme

| Label | What lands here |
|---|---|
| **Clients** | Permanent clients. **Sticky by sender** — you label a few by hand, and all future mail from those addresses is auto-labeled `Clients` forever. Always wins. |
| **Strata** | Your strata group. Same sticky-by-sender behavior as Clients. Always wins. |
| **Reply-needed** | A real human wrote to you and is waiting. The default for personal mail. |
| **Verification** | Important but no reply needed: login/verification codes, security alerts, terms-of-service updates, access-token notices. |
| **Job-search** | Automated job alerts + "application received / update on your application" confirmations (Ashby, Greenhouse, Lever, BambooHR, LinkedIn jobs, Workday, SmartRecruiters, Wellfound…). |
| **Money-Admin** | Questrade, CRA, banks (Scotiabank, RBC, TD, BMO, CIBC, Tangerine, Wealthsimple), invoices/receipts. |
| **Newsletter** | Newsletters / industry digests (beehiiv, Substack, Polymarket, Google Scholar alerts…). |
| **Noise** | Cold outreach / marketing. |

### Telling an automated ATS blast from a real recruiter

Recruiters sometimes message you *through* the ATS (same domain as the automated mail), so
subject + sender alone can't tell them apart. The tool instead checks the **machine-automation
headers** that systems stamp on automated mail but a person's 1:1 message never carries:
`List-Unsubscribe`, `Auto-Submitted: auto-generated`, `Precedence: bulk`,
`X-Auto-Response-Suppress`.

For mail from an ATS / job-board domain (Greenhouse, Lever, Ashby, Workable, iCIMS, BambooHR,
LinkedIn jobs, Indeed…):
- has a machine-automation marker, **or** an obvious confirmation/rejection subject
  ("thanks for applying", "application received/status") → **Job-search**;
- **no** markers and not a stock confirmation → **Reply-needed** (a recruiter likely typed it).

A recruiter writing from their own company domain isn't on an ATS domain at all, so they always
land in **Reply-needed**. The dry-run log prints the reason for each decision (e.g.
`(human via ATS (no machine markers))`) so you can verify the split on your real mail.

## How classification works

A first-match-wins cascade in [`Code.gs`](Code.gs): Clients → Strata → Money-Admin →
Job-search → Newsletter → Noise → (default) Reply-needed. It uses the sender
address/domain, a `List-Unsubscribe` header check (the tell-tale of bulk mail), and a
few subject keywords. All the sender/domain lists are **plain arrays at the top of
`Code.gs`** — edit them anytime to tune accuracy, no logic changes needed.

## Setup (about 5 minutes)

1. Go to **[script.google.com](https://script.google.com)** → **New project**.
2. Replace the default `Code.gs` contents with this repo's [`Code.gs`](Code.gs).
3. Show the manifest (gear icon ⚙ **Project Settings** → tick *"Show appsscript.json"*),
   then open `appsscript.json` and paste this repo's version.
4. With **`DRY_RUN = true`** (the default), select the **`setup`** function and click
   **Run**. Approve the Gmail permission when prompted. This:
   - creates the 7 labels above,
   - tries to delete the old `Tech`, `Tech/Crypto`, `Stocks`, `Scheduled` labels
     (emails kept). Gmail sometimes refuses programmatic label deletion — if the log
     says it couldn't, just delete those four by hand in **Gmail → Settings → Labels**
     (10 seconds),
   - installs a trigger that runs every 10 minutes.
5. Select **`run`** and click **Run**, then open **View → Logs**. You'll see lines like
   `would label [Job-search] <- no-reply@ashbyhq.com | Thank you for applying…`.
   Sanity-check these against your inbox.
6. **Seed the sticky labels:** in Gmail, hand-label a few emails `Clients` and `Strata`
   (e.g. your `awmalliance.com` / strata contacts). Future mail from those senders is then
   auto-matched.
7. When the dry-run output looks right, set **`DRY_RUN = false`** at the top of `Code.gs`,
   save, and you're live. The trigger does the rest every 10 minutes.

> Want to re-run setup later (e.g. after editing)? Just run `setup()` again — it's safe and
> idempotent (won't duplicate labels or triggers).

## Tuning

Misclassified something during your 30-day trial? Open `Code.gs` and add the sender's
domain (or full address) to the relevant array — `MONEY_DOMAINS`, `JOB_DOMAINS`,
`NEWSLETTER_DOMAINS`, or `NOISE_DOMAINS` — or adjust the `*_SUBJECT` keyword regexes.

## Optional: deploy with clasp (for code-synced updates)

If you'd rather push code from this repo instead of pasting:

```bash
npm install -g @google/clasp
clasp login
clasp create --type standalone --title "email-labeler" --rootDir .
clasp push
```

`.clasp.json` is gitignored so your script ID stays local.

## Roadmap (after the 30-day observation)

- Optional auto-archiving / inbox de-cluttering for non-priority categories.
- Optionally mark `Noise` as read.
