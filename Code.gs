/**
 * Gmail auto-labeler
 * -----------------------------------------------------------------------------
 * Tags incoming inbox mail into a fixed scheme. It never archives, moves, or
 * deletes. It marks Job-search / Newsletter / Noise as read (see MARK_READ_LABELS).
 *
 * Categories:
 *   Clients       - permanent clients (sticky by sender, you seed by hand)
 *   Strata        - your strata group (sticky by sender, you seed by hand)
 *   Reply-needed  - a real human is waiting (the default for personal mail)
 *   Job-search    - automated job alerts + "application received" confirmations
 *   Money-Admin   - Questrade, CRA, banking, invoices
 *   Newsletter    - newsletters / industry digests
 *   Noise         - cold outreach / marketing
 *
 * FIRST RUN: keep DRY_RUN = true, run setup() once (creates labels, deletes old
 * ones, installs the 10-min trigger), then run run() and read View > Logs to see
 * how mail WOULD be classified. When happy, set DRY_RUN = false.
 * -----------------------------------------------------------------------------
 */

// ====== SETTINGS YOU CAN EDIT =================================================

// When true, nothing is labeled - decisions are only written to the log.
var DRY_RUN = true;

// How far back to scan each run. Threads already carrying a managed label are
// excluded automatically (see scanQuery), so each run only touches NEW mail -
// this is what keeps Gmail API usage under the daily quota.
var SCAN_QUERY = 'in:inbox newer_than:3d';

// The sticky Clients/Strata sender lists are cached (in Script Properties) and
// only rebuilt this often. Rebuilding scans every labeled thread, so doing it on
// every 10-min run burns through the Gmail daily quota. A newly hand-labeled
// Client/Strata sender takes effect on the next rebuild (or run refreshSticky()).
var STICKY_REFRESH_MINUTES = 360; // 6 hours

// Mail in these categories is marked as read (still stays in the inbox with its
// label - nothing is archived). Remove a label from this list to keep it unread.
var MARK_READ_LABELS = ['Job-search', 'Newsletter', 'Noise'];

// Optional OpenAI fallback for the ONE genuinely ambiguous case: an ATS / job-
// board email with no automation markers and no confirmation subject, where only
// the body reveals whether a real recruiter wrote it (-> Reply-needed) or it's an
// automated nudge (-> Job-search). Everything else uses the fast rules and never
// calls OpenAI. Set USE_LLM_FALLBACK = true AFTER adding your API key in
// Project Settings > Script Properties as OPENAI_API_KEY (needs a real
// platform.openai.com API key with credit - a ChatGPT login won't work). The key
// is read from Script Properties, never hardcoded (this file is public on GitHub).
var USE_LLM_FALLBACK = false;
var OPENAI_MODEL = 'gpt-4o-mini';

// Old labels to remove during setup() (emails are kept; only the label is gone).
var LABELS_TO_DELETE = ['Tech', 'Tech/Crypto', 'Stocks', 'Scheduled'];

// Money / Admin: banks, brokerages, tax, invoicing. Domain entries match the
// domain and any subdomain; entries containing "@" match the full address.
var MONEY_DOMAINS = [
  'questrade.com', 'scotiabank.com', 'rbc.com', 'royalbank.com', 'td.com',
  'bmo.com', 'cibc.com', 'tangerine.ca', 'wealthsimple.com',
  'cra-arc.gc.ca', 'canada.ca', 'intuit.com', 'quickbooks.com',
  'stripe.com', 'paypal.com'
];
var MONEY_SUBJECT = /invoice|receipt|statement|payment (received|due)|tax|CRA/i;

// Job-search: ATS / job-board platform senders. Mail from these is essentially
// always automated, so it always goes to Job-search. Real recruiters who write
// you personally use their own company domain (not listed here), so they fall
// through to Reply-needed. Mix of full addresses and domains.
var JOB_DOMAINS = [
  'greenhouse-mail.io', 'greenhouse.io', 'hire.lever.co', 'lever.co',
  'ashbyhq.com', 'app.bamboohr.com', 'jobs-noreply@linkedin.com',
  'messages-noreply@linkedin.com', 'smartrecruiters.com', 'applytojob.com',
  'myworkdayjobs.com', 'workday.com', 'hi.wellfound.com', 'jobleads.com',
  'housesigma.com', 'getgarner.com', 'icims.com', 'workablemail.com',
  'workable.com', 'hireology.com', 'clearcompany.com', 'newtonsoftware.com',
  'jobgether.com', 'indeed.com', 'jobalert.indeed.com', 'methodrecruiting.com',
  'remotehunter.com', 'fractionaljobs.io', 'jobvite.com', 'gem.com',
  'ceipalmail.com', 'lightspeedhq.com'
];
// Obvious application-confirmation / rejection / status subjects. These are
// always automated no matter who "sent" them, so they go to Job-search even
// without machine markers (and catch company career addresses like
// careers@somecompany.com that aren't on a known ATS platform).
var JOB_CONFIRMATION = /thank(s| you) for (applying|your (interest|application))|for your interest|application (was |has been )?received|received your (application|resume)|application (status|follow.?up|update)|reviewing your application|for your application|your application (was|has been|is)|\bcandidacy\b|verify your candidate|candidate account|demographic survey/i;

// Machine-automation header markers: present on bulk/automated mail, absent on
// a person's 1:1 message (even one sent through an ATS). This is what lets us
// tell an automated ATS blast from a recruiter actually writing to you.
var AUTOMATION_HEADERS =
  /\nlist-unsubscribe:|\nauto-submitted:\s*auto|\nprecedence:\s*(bulk|list|junk|auto)|\nx-auto-response-suppress:/i;

// Account / security notices (login codes, security alerts, ToS) -> kept in
// Reply-needed so they stay visible, even though they're automated (many carry
// List-Unsubscribe). Matched only for non-job senders.
var ACCOUNT_DOMAINS = ['github.com', 'accounts.google.com', 'google-noreply@google.com'];
var ACCOUNT_SUBJECT = /security alert|verification code|verify your (email|account|identity|sign)|sign-?in code|\bpassword\b|two-factor|\b2fa\b|personal access token|new (sign-?in|login|device)|terms of service|privacy policy|suspicious (sign|login|activity)/i;

// Newsletter: editorial / digest senders.
var NEWSLETTER_DOMAINS = [
  'beehiiv.com', 'substack.com', 'polymarket.com', 'glgroup.com',
  'askachiefofstaff.com', 'scholaralerts-noreply@google.com'
];
var NEWSLETTER_SUBJECT = /newsletter|digest|weekly|roundup|edition/i;

// Noise: cold outreach / marketing.
var NOISE_DOMAINS = [
  'shop.tiktok.com', 'service.tiktok.com', 'make.com', 'superhuman.com',
  'transatmemberservice.com'
];
var NOISE_SUBJECT = /sale|% off|\boff\b|deal|discount|limited time|last chance|free trial|webinar|promo/i;

// =============================================================================
// Everything below is logic - you normally don't need to touch it.
// =============================================================================

var MANAGED_LABELS = [
  'Clients', 'Strata', 'Reply-needed', 'Job-search',
  'Money-Admin', 'Newsletter', 'Noise', 'Verification'
];

/**
 * Run ONCE from the editor: creates the managed labels, deletes the old ones,
 * installs the recurring trigger, and prompts for Gmail permission.
 */
function setup() {
  MANAGED_LABELS.forEach(function (name) {
    if (!GmailApp.getUserLabelByName(name)) {
      GmailApp.createLabel(name);
      Logger.log('Created label: ' + name);
    }
  });

  // Best-effort: Gmail sometimes refuses programmatic label deletion. Never let
  // it abort setup (the labels + trigger below matter more). Anything it can't
  // remove, you can delete by hand in Gmail > Settings > Labels.
  var couldNotDelete = [];
  LABELS_TO_DELETE.forEach(function (name) {
    var label = GmailApp.getUserLabelByName(name);
    if (!label) return;
    try {
      label.deleteLabel();
      Logger.log('Deleted label: ' + name);
    } catch (e) {
      couldNotDelete.push(name);
    }
  });
  if (couldNotDelete.length) {
    Logger.log('Could not auto-delete: ' + couldNotDelete.join(', ') +
               '  -> delete these by hand in Gmail > Settings > Labels.');
  }

  // Reinstall the 10-minute trigger (remove any old copies first).
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'run') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('run').timeBased().everyMinutes(10).create();

  // Force the sticky sender cache to rebuild on the next run.
  PropertiesService.getScriptProperties().deleteProperty('STICKY_AT');

  Logger.log('Setup complete. Trigger installed (every 10 min). DRY_RUN=' + DRY_RUN);
}

/**
 * Main entry point - called by the trigger every 10 minutes.
 */
function run() {
  var owner = (Session.getActiveUser().getEmail() || '').toLowerCase();
  var sticky = getStickySenders(owner);

  // The query excludes managed labels, so only unprocessed threads come back -
  // no need to re-fetch or re-check ones already labeled.
  var threads = GmailApp.search(scanQuery(), 0, 100);
  var labelCache = {};
  var counts = {};

  threads.forEach(function (thread) {
    var msgs = thread.getMessages();
    var msg = msgs[msgs.length - 1]; // classify on the latest message
    var decision = classify(msg, sticky.clients, sticky.strata);
    var name = decision.label;

    counts[name] = (counts[name] || 0) + 1;

    var markRead = MARK_READ_LABELS.indexOf(name) !== -1;

    if (DRY_RUN) {
      Logger.log('would label [' + name + ']' + (markRead ? ' +read' : '') +
                 '  (' + decision.reason + ')  <- ' +
                 msg.getFrom() + '  |  ' + msg.getSubject());
    } else {
      if (!labelCache[name]) {
        labelCache[name] = GmailApp.getUserLabelByName(name) ||
                           GmailApp.createLabel(name);
      }
      thread.addLabel(labelCache[name]);
      if (markRead) thread.markRead();
    }
  });

  Logger.log((DRY_RUN ? '[DRY RUN] ' : '') + 'Processed ' + threads.length +
             ' threads. Breakdown: ' + JSON.stringify(counts));
}

/**
 * Sticky Clients/Strata sender sets, cached in Script Properties and rebuilt at
 * most every STICKY_REFRESH_MINUTES. Rebuilding scans every labeled thread, so
 * caching is what keeps the 10-min trigger under the Gmail daily quota.
 */
function getStickySenders(owner) {
  var props = PropertiesService.getScriptProperties();
  var cached = props.getProperty('STICKY_JSON');
  var at = Number(props.getProperty('STICKY_AT') || 0);
  if (cached && (Date.now() - at) < STICKY_REFRESH_MINUTES * 60000) {
    var c = JSON.parse(cached);
    return { clients: c.clients || {}, strata: c.strata || {} };
  }
  var fresh = {
    clients: buildStickySenders('Clients', owner),
    strata: buildStickySenders('Strata', owner)
  };
  props.setProperty('STICKY_JSON', JSON.stringify(fresh));
  props.setProperty('STICKY_AT', String(Date.now()));
  return fresh;
}

/** Force the sticky lists to rebuild on the next run - run this by hand right
 *  after labeling new Clients/Strata if you don't want to wait for the refresh. */
function refreshSticky() {
  PropertiesService.getScriptProperties().deleteProperty('STICKY_AT');
  Logger.log('Sticky sender cache cleared - will rebuild on the next run.');
}

/** The scan query with every managed label excluded, so already-processed
 *  threads never come back (this is the main Gmail-quota saver). */
function scanQuery() {
  var exclude = MANAGED_LABELS.map(function (n) {
    return '-label:' + n.toLowerCase();
  }).join(' ');
  return SCAN_QUERY + ' ' + exclude;
}

/**
 * Collect the set of sender addresses from every thread under a given label.
 * These senders are then treated as "always this label" for future mail.
 */
function buildStickySenders(labelName, owner) {
  var set = {};
  var threads = GmailApp.search('label:' + labelName.toLowerCase(), 0, 200);
  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (m) {
      var email = extractEmail(m.getFrom());
      if (email && email !== owner) set[email] = true;
    });
  });
  return set;
}

/**
 * Decide a label for a message. Returns { label, reason } - reason is shown in
 * the dry-run log so you can see WHY each message landed where it did.
 * First match wins.
 */
function classify(msg, clientSenders, strataSenders) {
  var email = extractEmail(msg.getFrom());
  var subject = msg.getSubject() || '';

  // 1 & 2 - sticky relationships always win.
  if (clientSenders[email]) return pick('Clients', 'sticky sender');
  if (strataSenders[email]) return pick('Strata', 'sticky sender');

  // 3 - money / admin.
  if (senderMatches(email, MONEY_DOMAINS) || MONEY_SUBJECT.test(subject)) {
    return pick('Money-Admin', 'money sender/subject');
  }

  // Machine-automation signal - fetched lazily. getRawContent() is the most
  // expensive Gmail call, so only pay it when a branch actually needs the header
  // check (sender/subject-decided mail skips it entirely).
  var _auto = null;
  function automated() {
    if (_auto === null) _auto = isAutomated(msg);
    return _auto;
  }
  var onAts = senderMatches(email, JOB_DOMAINS);
  var confirmation = JOB_CONFIRMATION.test(subject);

  // 3b - account / security notices: important to see, but never need a reply.
  //      Their own Verification label. Only for non-job senders, so "verify your
  //      candidate account" from an ATS isn't caught here.
  if (!onAts && (senderMatches(email, ACCOUNT_DOMAINS) || ACCOUNT_SUBJECT.test(subject))) {
    return pick('Verification', 'account/security notice');
  }

  // 4a - application confirmation from a company career address (not a known
  //      ATS platform) - always automated regardless of headers.
  if (!onAts && confirmation) return pick('Job-search', 'application confirmation');

  // 4b - mail from an ATS / job-board platform.
  if (onAts) {
    // Automated blast (alert, confirmation, rejection) -> Job-search.
    if (automated()) return pick('Job-search', 'ATS automated (machine headers)');
    if (confirmation) return pick('Job-search', 'ATS confirmation (subject)');
    // No machine markers and not a stock confirmation - genuinely ambiguous.
    // Ask OpenAI (if enabled); otherwise fall back to the safe side (visible).
    var llm = classifyAmbiguousJob(msg);
    if (llm) return llm;
    return pick('Reply-needed', 'human via ATS (no machine markers)');
  }

  // 5 - newsletters. Known newsletter senders count even without machine
  //     markers (e.g. Google Scholar alerts); subject-only needs the marker.
  if (senderMatches(email, NEWSLETTER_DOMAINS)) {
    return pick('Newsletter', 'newsletter sender');
  }
  if (automated() && NEWSLETTER_SUBJECT.test(subject)) {
    return pick('Newsletter', 'bulk + newsletter subject');
  }

  // 6a - any remaining automated/bulk mail is noise (a person's 1:1 message
  //      carries no automation markers, so this is safe).
  if (automated()) return pick('Noise', 'bulk/automated');

  // 6b - cold/marketing without machine markers.
  if (senderMatches(email, NOISE_DOMAINS) || NOISE_SUBJECT.test(subject)) {
    return pick('Noise', 'marketing sender/subject');
  }

  // 7 - default: a human wrote to you and is waiting.
  return pick('Reply-needed', 'human');
}

/** Small helper so classify() reads cleanly. */
function pick(label, reason) {
  return { label: label, reason: reason };
}

/**
 * OpenAI fallback for the ambiguous ATS case. Reads the API key from Script
 * Properties (OPENAI_API_KEY) - never hardcoded. Returns a pick() of
 * 'Job-search' or 'Reply-needed', or null if disabled / no key / any error
 * (the caller then falls back to the safe default, Reply-needed).
 */
function classifyAmbiguousJob(msg) {
  if (!USE_LLM_FALLBACK) return null;
  var key = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if (!key) return null;

  var body = (msg.getPlainBody() || '').replace(/\s+/g, ' ').slice(0, 800);
  var system =
    "You triage a job-seeker's inbox. An email arrived from an applicant-tracking " +
    'or job-board system. Decide whether a real human is waiting on a reply.\n' +
    '- "Reply-needed": a recruiter or person wrote personally and expects a ' +
    'response (proposing a call, asking a question, scheduling an interview).\n' +
    '- "Job-search": automated or bulk mail with no human waiting (application ' +
    'received/rejected, status update, job alert, survey, account/verification).\n' +
    'Reply with JSON only: {"label":"Reply-needed" or "Job-search","reason":"<=6 words"}.';

  var payload = {
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: 'From: ' + msg.getFrom() + '\nSubject: ' +
                               (msg.getSubject() || '') + '\n\n' + body }
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
    max_tokens: 40
  };

  try {
    var resp = UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + key },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) {
      Logger.log('OpenAI error ' + resp.getResponseCode() + ': ' + resp.getContentText());
      return null;
    }
    var out = JSON.parse(JSON.parse(resp.getContentText()).choices[0].message.content);
    var label = out.label === 'Job-search' ? 'Job-search'
              : out.label === 'Reply-needed' ? 'Reply-needed' : null;
    if (!label) return null;
    return pick(label, 'LLM: ' + (out.reason || 'openai'));
  } catch (e) {
    Logger.log('OpenAI exception: ' + e);
    return null;
  }
}

// ---- helpers ----------------------------------------------------------------

/** Pull a bare lowercased email from a "Name <a@b.com>" style string. */
function extractEmail(from) {
  if (!from) return '';
  var m = from.match(/<([^>]+)>/);
  var addr = (m ? m[1] : from).trim().toLowerCase();
  return addr;
}

/** Domain portion of an email address. */
function domainOf(email) {
  var i = email.indexOf('@');
  return i === -1 ? '' : email.slice(i + 1);
}

/**
 * True if email matches any pattern. A pattern with "@" matches the full
 * address; otherwise it matches the domain or any subdomain of it.
 */
function senderMatches(email, patterns) {
  var domain = domainOf(email);
  for (var i = 0; i < patterns.length; i++) {
    var p = patterns[i].toLowerCase();
    if (p.indexOf('@') !== -1) {
      if (email === p) return true;
    } else if (domain === p || domain.slice(-(p.length + 1)) === '.' + p) {
      return true;
    }
  }
  return false;
}

/**
 * True if the message carries machine-automation markers (List-Unsubscribe,
 * Auto-Submitted: auto*, Precedence: bulk/list/auto, X-Auto-Response-Suppress).
 * These are present on automated/bulk mail and absent on a person's 1:1 reply -
 * the key to telling an ATS blast from a recruiter who actually wrote to you.
 */
function isAutomated(msg) {
  try {
    var raw = msg.getRawContent() || '';
    var headerEnd = raw.indexOf('\r\n\r\n');
    var headers = (headerEnd === -1 ? raw : raw.slice(0, headerEnd));
    // Normalize line endings so the leading-\n anchors in AUTOMATION_HEADERS
    // match regardless of CRLF vs LF, and prepend one so the first header line
    // can match too.
    return AUTOMATION_HEADERS.test('\n' + headers.replace(/\r\n/g, '\n'));
  } catch (e) {
    return false;
  }
}
