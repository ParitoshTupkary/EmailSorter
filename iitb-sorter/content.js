// IITB Mail Auto-Sorter — content.js
// Auto-sorts inbox + shows AI summary panel on click (critical & high only)

const SORT_INTERVAL_MS = 3 * 60 * 1000;
const STORAGE_KEY = 'anthropic_api_key';

let sortTimer = null;
let lastSortedIds = new Set();
let overlay = null;
let summaryPanel = null;
let isRunning = false;
let emailDataStore = {}; // uid -> { priority, summary, action, reason, subject, from, date }

// ── Entry point ───────────────────────────────────────────────────────────────

function init() {
  injectStyles();
  createOverlay();
  createSummaryPanel();
  waitForInbox();
}

function waitForInbox() {
  const observer = new MutationObserver(() => {
    if (getEmailRows().length > 0) { observer.disconnect(); scheduleSort(); }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  if (getEmailRows().length > 0) { observer.disconnect(); scheduleSort(); }
}

function scheduleSort() {
  runSort();
  clearInterval(sortTimer);
  sortTimer = setInterval(runSort, SORT_INTERVAL_MS);
}

// ── Read emails from Roundcube DOM ────────────────────────────────────────────

function getEmailRows() {
  return Array.from(document.querySelectorAll('#messagelist tbody tr, .message-list tr[data-uid]'));
}

function extractEmails() {
  return getEmailRows().reduce((acc, row) => {
    const uid = row.dataset.uid || row.getAttribute('data-uid') || row.id;
    if (!uid) return acc;
    const subject = row.querySelector('.subject span, td.subject')?.textContent.trim() || '';
    const from    = row.querySelector('.from span, td.from, .sender')?.textContent.trim() || '';
    const date    = row.querySelector('.date, td.date')?.textContent.trim() || '';
    if (subject) acc.push({ uid, subject, from, date, row });
    return acc;
  }, []);
}

// ── Core sort logic ───────────────────────────────────────────────────────────

async function runSort() {
  if (isRunning) return;
  const emails = extractEmails();
  if (!emails.length) return;

  const currentIds = emails.map(e => e.uid).join(',');
  if (currentIds === [...lastSortedIds].join(',')) return;

  isRunning = true;
  setOverlayState('loading', `Analysing ${emails.length} emails...`);

  try {
    const apiKey = await getApiKey();
    if (!apiKey) {
      setOverlayState('error', 'No API key — click the extension icon to add one');
      isRunning = false;
      return;
    }
    const results = await callClaude(emails, apiKey);
    applyPriorities(emails, results);
    lastSortedIds = new Set(emails.map(e => e.uid));
    setOverlayState('done', `Sorted ${emails.length} emails · next in 3 min`);
  } catch (err) {
    console.error('[IITB Sorter]', err);
    setOverlayState('error', err.message || 'Sort failed — check API key');
  }

  isRunning = false;
}

// ── Gemini via background worker ──────────────────────────────────────────────

async function callClaude(emails, apiKey) {
  const emailList = emails.map((e, i) =>
    `${i + 1}. Subject: "${e.subject}" | From: "${e.from}" | Date: "${e.date}"`
  ).join('\n');

  const prompt = `You are helping an IIT Bombay student manage their inbox.

PRIORITY LEVELS:
- "critical": Class cancellations, room changes, exam schedules, grade releases, urgent deadlines, direct professor emails, official academic notices
- "high": Assignment details, timetable updates, important prof communications, academic opportunities
- "medium": General university notices, optional academic events, admin reminders
- "low": Club elections, socials, promotions, newsletters, non-academic spam

For CRITICAL and HIGH emails only — provide a detailed summary and action.
For MEDIUM and LOW — leave summary and action as empty strings.

Emails:
${emailList}

Return ONLY a valid JSON array, same order as input:
[{"index":1,"priority":"critical|high|medium|low","summary":"one specific sentence about what this email says (critical/high only)","action":"exactly what the student should do e.g. Note new venue: LT2 or Submit before Friday 11:59pm or No action needed (critical/high only)","reason":"brief reason for this priority"}]

No markdown. No preamble. Just the JSON array.`;

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'callGemini', prompt }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response?.error) {
        reject(new Error(response.error));
        return;
      }
      try {
        const text = response.result || '[]';
        resolve(JSON.parse(text.replace(/```json|```/g, '').trim()));
      } catch (e) {
        reject(new Error('Failed to parse Gemini response'));
      }
    });
  });
}

// ── Storage ───────────────────────────────────────────────────────────────────

function getApiKey() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'getApiKey' }, (response) => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      resolve(response?.key || null);
    });
  });
}

const PRIORITY_ORDER  = { critical: 0, high: 1, medium: 2, low: 3 };
const PRIORITY_LABELS = { critical: '🔴', high: '🟡', medium: '⚫', low: '·' };

function applyPriorities(emails, results) {
  const tbody = getEmailRows()[0]?.parentElement;
  if (!tbody) return;

  const scored = emails.map((email, i) => {
    const r = results.find(r => r.index === i + 1) || {};
    const entry = {
      priority: r.priority || 'medium',
      summary:  r.summary  || '',
      action:   r.action   || '',
      reason:   r.reason   || '',
      subject:  email.subject,
      from:     email.from,
      date:     email.date
    };
    emailDataStore[email.uid] = entry;
    return { ...email, ...entry };
  });

  scored.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2));

  document.querySelectorAll('.iitb-badge').forEach(b => b.remove());

  scored.forEach((email) => {
    tbody.appendChild(email.row);

    // Badge
    const subjectCell = email.row.querySelector('td.subject, .subject');
    if (subjectCell && !subjectCell.querySelector('.iitb-badge')) {
      const badge = document.createElement('span');
      badge.className = `iitb-badge iitb-badge-${email.priority}`;
      badge.title = email.reason;
      badge.textContent = PRIORITY_LABELS[email.priority] || '·';
      subjectCell.prepend(badge);
    }

    // Dim low priority rows
    email.row.style.opacity = email.priority === 'low' ? '0.4' : '1';

    // ── Summary click: ONLY for critical + high ──
    if (email.priority === 'critical' || email.priority === 'high') {
      email.row.style.cursor = 'pointer';
      const uid = email.uid;
      email.row.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT') return;
        showSummary(uid);
      });
    }
  });
}

// ── Summary panel ─────────────────────────────────────────────────────────────

function createSummaryPanel() {
  summaryPanel = document.createElement('div');
  summaryPanel.id = 'iitb-summary-panel';
  summaryPanel.innerHTML = `
    <div class="isp-inner">
      <div class="isp-topbar">
        <div class="isp-badge-wrap">
          <span class="isp-badge" id="isp-badge"></span>
          <span class="isp-priority-label" id="isp-priority-label"></span>
        </div>
        <button class="isp-close" id="isp-close">✕</button>
      </div>
      <div class="isp-subject" id="isp-subject"></div>
      <div class="isp-meta" id="isp-meta"></div>
      <div class="isp-divider"></div>
      <div class="isp-section-label">SUMMARY</div>
      <div class="isp-summary" id="isp-summary"></div>
      <div class="isp-section-label" style="margin-top:14px">ACTION</div>
      <div class="isp-action" id="isp-action"></div>
    </div>
  `;
  document.body.appendChild(summaryPanel);

  document.getElementById('isp-close').addEventListener('click', hideSummary);
  document.addEventListener('click', (e) => {
    if (!summaryPanel.contains(e.target) && summaryPanel.classList.contains('visible')) {
      hideSummary();
    }
  });
}

function showSummary(uid) {
  const d = emailDataStore[uid];
  if (!d) return;

  const badges         = { critical: '🔴', high: '🟡' };
  const priorityNames  = { critical: 'CRITICAL', high: 'HIGH PRIORITY' };
  const priorityColors = { critical: '#ef4444', high: '#f59e0b' };

  document.getElementById('isp-badge').textContent          = badges[d.priority] || '';
  document.getElementById('isp-priority-label').textContent = priorityNames[d.priority] || d.priority.toUpperCase();
  document.getElementById('isp-priority-label').style.color = priorityColors[d.priority] || '#a5b4fc';
  document.getElementById('isp-subject').textContent        = d.subject;
  document.getElementById('isp-meta').textContent           = `From: ${d.from}  ·  ${d.date}`;
  document.getElementById('isp-summary').textContent        = d.summary || 'No summary available.';
  document.getElementById('isp-action').textContent         = d.action  || '—';

  summaryPanel.classList.add('visible');
}

function hideSummary() {
  summaryPanel.classList.remove('visible');
}

// ── Floating status chip ──────────────────────────────────────────────────────

function createOverlay() {
  overlay = document.createElement('div');
  overlay.id = 'iitb-sorter-overlay';
  overlay.innerHTML = `
    <div class="iitb-overlay-inner">
      <span>📬</span>
      <span class="iitb-overlay-text">Mail Sorter ready</span>
      <button class="iitb-overlay-sort" title="Sort now">↻</button>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('.iitb-overlay-sort').addEventListener('click', (e) => {
    e.stopPropagation();
    lastSortedIds.clear();
    runSort();
  });
}

function setOverlayState(state, text) {
  if (!overlay) return;
  overlay.querySelector('.iitb-overlay-text').textContent    = text;
  overlay.querySelector('.iitb-overlay-inner').dataset.state = state;
}

// ── Styles ────────────────────────────────────────────────────────────────────

function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
    /* ── Status chip ── */
    #iitb-sorter-overlay {
      position: fixed; bottom: 20px; right: 20px;
      z-index: 99999; font-family: 'Courier New', monospace;
      font-size: 12px; pointer-events: none;
    }
    .iitb-overlay-inner {
      display: flex; align-items: center; gap: 8px;
      background: rgba(10,10,20,0.93); border: 1px solid #2d2d4f;
      border-radius: 10px; padding: 8px 14px; color: #a5b4fc;
      backdrop-filter: blur(12px); box-shadow: 0 4px 24px rgba(0,0,0,0.4);
      pointer-events: all; transition: border-color 0.3s, color 0.3s;
    }
    .iitb-overlay-inner[data-state="loading"] { border-color: #4f46e5; color: #818cf8; }
    .iitb-overlay-inner[data-state="done"]    { border-color: #059669; color: #34d399; }
    .iitb-overlay-inner[data-state="error"]   { border-color: #ef4444; color: #f87171; }
    .iitb-overlay-sort {
      background: none; border: 1px solid #3d3d6f; border-radius: 6px;
      color: #6b7280; cursor: pointer; font-size: 14px; padding: 2px 7px;
      transition: all 0.2s;
    }
    .iitb-overlay-sort:hover { border-color: #4f46e5; color: #a5b4fc; }

    /* ── Priority badges ── */
    .iitb-badge {
      display: inline-block; margin-right: 6px;
      font-size: 11px; vertical-align: middle; cursor: pointer;
    }
    #messagelist tbody tr { transition: opacity 0.4s; }

    /* ── Summary panel ── */
    #iitb-summary-panel {
      position: fixed; top: 50%; right: -380px;
      transform: translateY(-50%);
      width: 340px; z-index: 99998;
      transition: right 0.32s cubic-bezier(0.34, 1.56, 0.64, 1);
    }
    #iitb-summary-panel.visible { right: 24px; }

    .isp-inner {
      background: rgba(8,8,18,0.97);
      border: 1px solid #2a2a45;
      border-radius: 14px;
      padding: 18px 20px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.6);
      backdrop-filter: blur(20px);
      font-family: 'Courier New', monospace;
    }
    .isp-topbar {
      display: flex; justify-content: space-between;
      align-items: center; margin-bottom: 12px;
    }
    .isp-badge-wrap { display: flex; align-items: center; gap: 8px; }
    .isp-badge { font-size: 18px; }
    .isp-priority-label {
      font-size: 10px; font-weight: 700;
      letter-spacing: 1.5px; text-transform: uppercase;
    }
    .isp-close {
      background: none; border: 1px solid #2d2d4a;
      border-radius: 6px; color: #6b7280; cursor: pointer;
      font-size: 11px; padding: 3px 8px; transition: all 0.2s;
    }
    .isp-close:hover { border-color: #ef4444; color: #ef4444; }
    .isp-subject {
      font-size: 14px; font-weight: 700; color: #e2e2f0;
      line-height: 1.35; margin-bottom: 6px;
    }
    .isp-meta { font-size: 10px; color: #4b5563; margin-bottom: 14px; }
    .isp-divider { border: none; border-top: 1px solid #1e1e30; margin-bottom: 14px; }
    .isp-section-label {
      font-size: 9px; font-weight: 700; color: #4b5563;
      letter-spacing: 1.5px; text-transform: uppercase; margin-bottom: 6px;
    }
    .isp-summary { font-size: 12px; color: #c4c4d4; line-height: 1.6; }
    .isp-action  { font-size: 12px; color: #818cf8; line-height: 1.5; font-weight: 600; }
  `;
  document.head.appendChild(style);
}

// ── Message listener (from popup) ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'forceSort') {
    lastSortedIds.clear();
    runSort();
  }
});

// ── Go ────────────────────────────────────────────────────────────────────────
init();
