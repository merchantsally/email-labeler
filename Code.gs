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

// Job-search: ATS / job-board senders. Mix of full addresses and domains.
var JOB_DOMAINS = [
  'greenhouse-mail.io', 'hire.lever.co', 'ashbyhq.com', 'app.bamboohr.com',
  'jobs-noreply@linkedin.com', 'messages-noreply@linkedin.com',
  'smartrecruiters.com', 'applytojob.com', 'myworkdayjobs.com', 'workday.com',
  'hi.wellfound.com', 'jobleads.com', 'housesigma.com', 'getgarner.com',
  'icims.com'
];
// An address is "automated" (vs a real recruiter replying) if it looks like this.
var AUTOMATED_PREFIX = /(^|[._-])(no-?reply|donotreply|jobs-noreply|notifications?|mailer|noreply)/i;

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
  'Money-Admin', 'Newsletter', 'Noise'
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

  LABELS_TO_DELETE.forEach(function (name) {
    var label = GmailApp.getUserLabelByName(name);
    if (label) {
      label.deleteLabel();
      Logger.log('Deleted label: ' + name);
    }
  });

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
    var label = classify(msg, clientSenders, strataSenders);

    counts[label] = (counts[label] || 0) + 1;

    if (DRY_RUN) {
      Logger.log('would label [' + label + ']  <- ' + msg.getFrom() +
                 '  |  ' + msg.getSubject());
    } else {
      if (!labelCache[label]) {
        labelCache[label] = GmailApp.getUserLabelByName(label) ||
                            GmailApp.createLabel(label);
      }
      thread.addLabel(labelCache[label]);
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
 * Decide a single label for a message. First match wins.
 */
function classify(msg, clientSenders, strataSenders) {
  var email = extractEmail(msg.getFrom());
  var subject = msg.getSubject() || '';

  // 1 & 2 - sticky relationships always win.
  if (clientSenders[email]) return 'Clients';
  if (strataSenders[email]) return 'Strata';

  // 3 - money / admin.
  if (senderMatches(email, MONEY_DOMAINS) || MONEY_SUBJECT.test(subject)) {
    return 'Money-Admin';
  }

  // 4 - job-search vs a real recruiter replying.
  if (senderMatches(email, JOB_DOMAINS)) {
    var local = email.split('@')[0];
    return AUTOMATED_PREFIX.test(local) ? 'Job-search' : 'Reply-needed';
  }

  // Bulk-mail signal, computed once (raw fetch is the expensive part).
  var bulk = hasListUnsubscribe(msg);

  // 5 - newsletters.
  if (bulk && (senderMatches(email, NEWSLETTER_DOMAINS) ||
               NEWSLETTER_SUBJECT.test(subject))) {
    return 'Newsletter';
  }

  // 6a - any remaining bulk mail is noise (real humans don't send
  //       List-Unsubscribe, so this is safe).
  if (bulk) return 'Noise';

  // 6b - cold/marketing that omits List-Unsubscribe (1:1-looking outreach).
  if (senderMatches(email, NOISE_DOMAINS) || NOISE_SUBJECT.test(subject)) {
    return 'Noise';
  }

  // 7 - default: a human wrote to you and is waiting.
  return 'Reply-needed';
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

/** True if the message carries a List-Unsubscribe header (a bulk-mail marker). */
function hasListUnsubscribe(msg) {
  try {
    var raw = msg.getRawContent() || '';
    var headerEnd = raw.indexOf('\r\n\r\n');
    var headers = (headerEnd === -1 ? raw : raw.slice(0, headerEnd)).toLowerCase();
    return headers.indexOf('list-unsubscribe:') !== -1;
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
