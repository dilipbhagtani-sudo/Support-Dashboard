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

// Pending status codes to keep (filter applied after fetching)
const PENDING_STATUSES = new Set([2, 7, 15, 16, 17, 18, 19]);

const PRIORITY_LABELS = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };

// Google Sheets reference CSV (Enterprise ID → Customer Segment + CSM Name)
const SHEETS_LOOKUP_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRdTkcqzfVDk-e10HQUQMVY5ZiDYm3-myV3_FZ7mUAwrmLElYfUOwa_eBwBgjJQxtsdBWmpid40NCyU/pub?output=csv';

// ─── Robust CSV row parser (no lookbehind regex) ─────────────────────────────
function parseCSVRow(line) {
  const cols = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuote = false;
      else cur += ch;
    } else {
      if (ch === '"') inQuote = true;
      else if (ch === ',') { cols.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  cols.push(cur);
  return cols.map(c => c.trim());
}

// ─── Fetch & parse Google Sheets CSV into a lookup map ───────────────────────
async function fetchEnterpriseLookup() {
  try {
    const res = await fetch(SHEETS_LOOKUP_URL);
    if (!res.ok) return {};
    const text = await res.text();
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) return {};

    // Parse header row — case-insensitive, flexible matching
    const headers = parseCSVRow(lines[0]).map(h => h.toLowerCase());
    const idIdx  = headers.findIndex(h => h.includes('enterprise id') || h === 'id' || h === 'enterprise_id');
    const segIdx = headers.findIndex(h => h.includes('customer segment') || h.includes('segment'));
    // CSM: try 'csm name', 'csm', 'customer success manager', 'account manager'
    const csmIdx = headers.findIndex(h =>
      h.includes('csm name') || h === 'csm' || h.includes('customer success') || h.includes('account manager')
    );

    if (idIdx === -1) return {};

    const lookup = {};
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const cols = parseCSVRow(lines[i]);
      const id = (cols[idIdx] || '').trim();
      if (!id) continue;
      lookup[id] = {
        segment: segIdx !== -1 ? (cols[segIdx] || '').trim() : '',
        csm:     csmIdx !== -1 ? (cols[csmIdx] || '').trim() : '',
      };
    }
    return lookup;
  } catch {
    return {};
  }
}

// Extract enterprise ID from "Enterprise Name - ID" format
function extractEnterpriseId(entName) {
  if (!entName) return '';
  const lastDash = entName.lastIndexOf(' - ');
  return lastDash !== -1 ? entName.slice(lastDash + 3).trim() : '';
}

// ─── Auth header ─────────────────────────────────────────────────────────────
function authHeader() {
  return 'Basic ' + Buffer.from(`${API_KEY}:X`).toString('base64');
}

// ─── Fetch one page of tickets (no status filter — returns all non-resolved) ──
async function fetchPage(page) {
  const url = `https://${DOMAIN}.freshdesk.com/api/v2/tickets?page=${page}&per_page=100&include=stats`;
  const res = await fetch(url, { headers: { Authorization: authHeader() } });
  if (res.status === 429) {
    await new Promise(r => setTimeout(r, 60000));
    const retry = await fetch(url, { headers: { Authorization: authHeader() } });
    if (!retry.ok) return [];
    return retry.json();
  }
  if (!res.ok) return [];
  return res.json();
}

// ─── Fetch ALL tickets and filter to pending statuses ────────────────────────
async function fetchAllTickets() {
  const all = [];
  let page = 1;
  while (true) {
    const tickets = await fetchPage(page);
    if (!Array.isArray(tickets) || tickets.length === 0) break;
    // Keep only tickets with a pending status
    tickets.forEach(t => { if (PENDING_STATUSES.has(t.status)) all.push(t); });
    if (tickets.length < 100) break;
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
function mapTicket(t, lookup = {}) {
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

  // Tags as space-separated string
  const tags = Array.isArray(t.tags) ? t.tags.join(' ') : (t.tags || '');

  // Enrich from Google Sheets lookup via enterprise ID
  const entName = cf.cf_enterprise_name || '';
  const entId   = extractEnterpriseId(entName);
  const entInfo = lookup[entId] || {};

  // Clean enterprise display name (remove trailing " - ID")
  const lastDash = entName.lastIndexOf(' - ');
  const entDisplayName = lastDash !== -1 ? entName.slice(0, lastDash).trim() : entName;

  return {
    'Ticket ID':                String(t.id),
    'Subject':                  t.subject || '',
    'Status':                   STATUS_LABELS[t.status] || String(t.status),
    'Priority':                 PRIORITY_LABELS[t.priority] || String(t.priority),
    'Product (Studio/Vini)':    cf.cf_product_studiovini || '',
    'Type':                     t.type || '',
    'Category/Type':            t.type || cf.cf_categorytype || '',
    'cf_categorytype':          cf.cf_categorytype || '',
    'VoC L1':                   cf.cf_voc_l1 || '',
    'VoC L2':                   cf.cf_voc_l2 || '',
    'Customer Segment':         entInfo.segment || cf.cf_account_type || cf.cf_account_type1 || '',
    'ENT Type':                 entInfo.segment || cf.cf_account_type || cf.cf_account_type1 || '',
    'Enterprise Name':          entDisplayName,
    'Enterprise ID':            entId,
    'CSM Name':                 entInfo.csm || '',
    'CSM Name (updated)':       entInfo.csm || '',
    'Jira':                     cf.cf_jira_ticket || '',
    'Tags':                     tags,
    'Created time':             created,
    'Month':                    month,
    'First response status':    slaStatus(stats.first_responded_at, t.fr_due_by),
    'Resolution status':        slaStatus(stats.resolved_at, t.due_by),
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
    // Fetch Freshdesk tickets and Google Sheets lookup in parallel
    const [all, lookup] = await Promise.all([fetchAllTickets(), fetchEnterpriseLookup()]);
    const mapped = all.map(t => mapTicket(t, lookup));

    // Cache for 5 minutes on Vercel Edge
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json(mapped);
  } catch (err) {
    console.error('Freshdesk fetch error:', err);
    return res.status(500).json({ error: err.message });
  }
};
