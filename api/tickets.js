/**
 * Vercel Serverless Function — /api/tickets
 *
 * Fetches all pending tickets from Freshdesk and returns them
 * in the exact same shape the dashboard expects (same column names
 * as the old Google Sheets CSV).
 *
 * Required Vercel env vars:
 *   FRESHDESK_DOMAIN   e.g. "spyne"
 *   FRESHDESK_API_KEY  your Freshdesk API key
 */

const DOMAIN  = process.env.FRESHDESK_DOMAIN;
const API_KEY = process.env.FRESHDESK_API_KEY;

// ─── Status mappings (matches your Freshdesk custom statuses) ────────────────
const STATUS_LABELS = {
  2:  'Open',
  3:  'Pending',
  4:  'Resolved',
  5:  'Closed',
  6:  'Waiting on Customer',
  7:  'Waiting on Product',
  10: 'Waiting on third party',
  15: 'Pending L2 (Technical)',
  16: 'Pending L1 (Technical)',
  17: 'On Hold (Internal)',
  18: 'Pending at Creative',
  19: 'Pending at Production',
};

// Statuses that count as "pending" for the dashboard
const PENDING_STATUSES = [2, 7, 15, 16, 17, 18, 19];

const PRIORITY_LABELS = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };

// ─── Auth header ─────────────────────────────────────────────────────────────
function authHeader() {
  return 'Basic ' + Buffer.from(`${API_KEY}:X`).toString('base64');
}

// ─── Fetch one page of tickets for a given status ────────────────────────────
async function fetchPage(status, page) {
  const url = [
    `https://${DOMAIN}.freshdesk.com/api/v2/tickets`,
    `?status=${status}`,
    `&page=${page}`,
    `&per_page=100`,
    `&include=stats`,          // gives first_responded_at, resolved_at, due_by, fr_due_by
  ].join('');

  const res = await fetch(url, { headers: { Authorization: authHeader() } });
  if (res.status === 429) {
    // Rate limited — wait 60s and retry once
    await new Promise(r => setTimeout(r, 60000));
    const retry = await fetch(url, { headers: { Authorization: authHeader() } });
    if (!retry.ok) return [];
    return retry.json();
  }
  if (!res.ok) return [];
  return res.json();
}

// ─── Fetch ALL pages for a given status ─────────────────────────────────────
async function fetchAllForStatus(status) {
  const all = [];
  let page = 1;
  while (true) {
    const tickets = await fetchPage(status, page);
    if (!Array.isArray(tickets) || tickets.length === 0) break;
    all.push(...tickets);
    if (tickets.length < 100) break;  // last page
    page++;
  }
  return all;
}

// ─── Derive SLA status strings from timestamps ───────────────────────────────
function slaStatus(respondedAt, dueBy) {
  if (!respondedAt || !dueBy) return '';
  return new Date(respondedAt) <= new Date(dueBy) ? 'Within SLA' : 'Violated SLA';
}

// ─── Map a Freshdesk ticket → dashboard row ──────────────────────────────────
function mapTicket(t) {
  const cf    = t.custom_fields || {};
  const stats = t.stats || {};
  const created = t.created_at || '';
  const month = created ? String(new Date(created).getMonth() + 1) : '';

  // Resolution time in hours (if resolved)
  let resMins = null;
  if (stats.resolved_at && t.created_at) {
    resMins = (new Date(stats.resolved_at) - new Date(t.created_at)) / 60000;
  }
  const resHrs = resMins !== null ? (resMins / 60).toFixed(2) : '';

  // Tags as space-separated string (keeps Jira-linked detection working)
  const tags = Array.isArray(t.tags) ? t.tags.join(' ') : (t.tags || '');

  return {
    'Ticket ID':              String(t.id),
    'Subject':                t.subject || '',
    'Status':                 STATUS_LABELS[t.status] || String(t.status),
    'Priority':               PRIORITY_LABELS[t.priority] || String(t.priority),
    'Product (Studio/Vini)':  cf.cf_product_studiovini || '',
    'Category/Type':          cf.cf_categorytype || '',
    'VoC L1':                 cf.cf_voc_l1 || '',
    'VoC L2':                 cf.cf_voc_l2 || '',
    'ENT Type':               cf.cf_account_type || cf.cf_account_type1 || '',
    'Enterprise Name':        cf.cf_enterprise_name || '',
    'Jira':                   cf.cf_jira_ticket || '',
    'Tags':                   tags,
    'Created time':           created,
    'Month':                  month,
    // SLA columns (used by All Tickets tab)
    'First response status':  slaStatus(stats.first_responded_at, t.fr_due_by),
    'Resolution status':      slaStatus(stats.resolved_at, t.due_by),
    'Resolution time (in hrs)': resHrs,
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // CORS — allow the dashboard origin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!DOMAIN || !API_KEY) {
    return res.status(500).json({ error: 'FRESHDESK_DOMAIN or FRESHDESK_API_KEY not set.' });
  }

  try {
    // Fetch all pending statuses in parallel
    const batches = await Promise.all(PENDING_STATUSES.map(fetchAllForStatus));
    const all = batches.flat();
    const mapped = all.map(mapTicket);

    // Cache for 5 minutes on Vercel Edge
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json(mapped);
  } catch (err) {
    console.error('Freshdesk fetch error:', err);
    return res.status(500).json({ error: err.message });
  }
};
