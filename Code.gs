/**
 * Gmail auto-labeler
 * -----------------------------------------------------------------------------
 * A "label only" tool: it tags incoming inbox mail into a fixed scheme.
 * It never archives, moves, deletes, or marks anything read.
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

// How far back to scan each run.
var SCAN_QUERY = 'in:inbox newer_than:3d';

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

  Logger.log('Setup complete. Trigger installed (every 10 min). DRY_RUN=' + DRY_RUN);
}

/**
 * Main entry point - called by the trigger every 10 minutes.
 */
function run() {
  var owner = (Session.getActiveUser().getEmail() || '').toLowerCase();
  var clientSenders = buildStickySenders('Clients', owner);
  var strataSenders = buildStickySenders('Strata', owner);

  var threads = GmailApp.search(SCAN_QUERY, 0, 200);
  var labelCache = {};
  var counts = {};

  threads.forEach(function (thread) {
    if (hasManagedLabel(thread)) return; // already handled (auto or by hand)

    var msgs = thread.getMessages();
    var msg = msgs[msgs.length - 1]; // classify on the latest message
    var decision = classify(msg, clientSenders, strataSenders);
    var name = decision.label;

    counts[name] = (counts[name] || 0) + 1;

    if (DRY_RUN) {
      Logger.log('would label [' + name + ']  (' + decision.reason + ')  <- ' +
                 msg.getFrom() + '  |  ' + msg.getSubject());
    } else {
      if (!labelCache[name]) {
        labelCache[name] = GmailApp.getUserLabelByName(name) ||
                           GmailApp.createLabel(name);
      }
      thread.addLabel(labelCache[name]);
    }
  });

  Logger.log((DRY_RUN ? '[DRY RUN] ' : '') + 'Processed ' + threads.length +
             ' threads. Breakdown: ' + JSON.stringify(counts));
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

  // Machine-automation signal, computed once (raw header fetch is the cost).
  var automated = isAutomated(msg);
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
    if (automated) return pick('Job-search', 'ATS automated (machine headers)');
    if (confirmation) return pick('Job-search', 'ATS confirmation (subject)');
    // No machine markers and not a stock confirmation: a recruiter likely
    // typed this through the ATS and wants a reply.
    return pick('Reply-needed', 'human via ATS (no machine markers)');
  }

  // 5 - newsletters. Known newsletter senders count even without machine
  //     markers (e.g. Google Scholar alerts); subject-only needs the marker.
  if (senderMatches(email, NEWSLETTER_DOMAINS)) {
    return pick('Newsletter', 'newsletter sender');
  }
  if (automated && NEWSLETTER_SUBJECT.test(subject)) {
    return pick('Newsletter', 'bulk + newsletter subject');
  }

  // 6a - any remaining automated/bulk mail is noise (a person's 1:1 message
  //      carries no automation markers, so this is safe).
  if (automated) return pick('Noise', 'bulk/automated');

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

/** True if the thread already carries one of our managed labels. */
function hasManagedLabel(thread) {
  var names = thread.getLabels().map(function (l) { return l.getName(); });
  for (var i = 0; i < MANAGED_LABELS.length; i++) {
    if (names.indexOf(MANAGED_LABELS[i]) !== -1) return true;
  }
  return false;
}
