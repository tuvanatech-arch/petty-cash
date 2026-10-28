// Minimal Supabase client mock: every query resolves with canned rows per table.
export const calls = [];
export const rpcArgs = [];
export const SID = '5e550001-0000-4000-8000-000000000000';
const TOKEN = 'h.' + Buffer.from(JSON.stringify({ session_id: SID })).toString('base64url') + '.s';
const ME = { id: '11111111-1111-4111-8111-111111111111', email: 'admin@example.com', full_name: 'Ada Admin', role: 'approver', active: true };
const OTHER = { id: '22222222-2222-4222-8222-222222222222', email: 'f@example.com', full_name: 'Fin Person', role: 'finance', active: true };
const REQ = { id: '33333333-3333-4333-8333-333333333333', request_no: 1001, type: 'stock', requester_id: ME.id, purpose: 'Paper', status: 'disbursed', estimated_total: 250, approval_required: true, for_store: false,
  disbursed_amount: 250, disbursed_to: ME.id, disbursed_by: OTHER.id, disbursed_at: '2026-10-20T10:00:00Z', approved_by: ME.id, approved_at: '2026-10-19T10:00:00Z', created_at: '2026-10-18T10:00:00Z', submitted_at: '2026-10-18T10:00:00Z', updated_at: '2026-10-20T10:00:00Z', stock_reviewed_by: ME.id, stock_reviewed_at: '2026-10-18T12:00:00Z', float_id: 'f1', expense: { total: 0, proof_status: 'pending', finance_note: null } };
const ITEM = { id: '44444444-4444-4444-8444-444444444444', name: 'A4 paper', unit: 'ream', qty_on_hand: 3, reorder_level: 5, recurring: true, expected_monthly_qty: 10, last_unit_price: 89.9, active: true, category_id: null, preferred_supplier_id: null };
export const TABLES = {
  profiles: [ME, OTHER],
  settings: [{ id: 1, org_name: 'Test Org', currency: 'N$', approval_threshold: 200, default_monthly_float: 3000, float_rollover: false, advance_grace_days: 5, block_with_outstanding: false, budget_mode: 'warn', count_day: 5, headcount: 8, email_from: null, app_url: null, claims_need_approval: true }],
  notifications: [{ id: 'n1', user_id: ME.id, kind: 'approval', title: 'Approval needed: #1001 Paper', body: 'N$250.00', link: '#/requests/33333333-3333-4333-8333-333333333333', created_at: '2026-10-20T10:00:00Z', read_at: null }],
  delegations: [{ id: 'd1', role: 'finance', from_user: OTHER.id, to_user: ME.id, starts_on: '2026-10-20', ends_on: '2026-11-05', note: 'Leave', created_by: ME.id }],
  budgets: [{ id: 'b1', category_id: 'c1', person_id: null, monthly_limit: 1500, active: true, note: null }],
  packs: [{ id: 'pk1', float_id: 'f0', period: '2026-09-01', status: 'review', storage_path: '2026-09/petty-cash-2026-09.pdf', file_name: 'petty-cash-2026-09.pdf', size_bytes: 1000000, pages: 9, summary: { allocated: 3000, spent: 2000, balance: 1000, counted_cash: 1000, vouchers: 3, missing_proofs: 0, months: [], requests: {}, by_category: [] }, built_at: '2026-10-01T07:00:00Z', built_by: OTHER.id }],
  request_documents: [{ id: 'rd1', request_id: '33333333-3333-4333-8333-333333333333', kind: 'invoice', storage_path: '33333333-3333-4333-8333-333333333333/inv.pdf', file_name: 'inv.pdf', mime: 'application/pdf', uploaded_by: ME.id, extracted: { supplier: 'Waltons', total: 260 }, created_at: '2026-10-19T12:00:00Z' }],
  request_messages: [{ id: 'm1', request_id: REQ.id, author_id: OTHER.id, body: 'Which shop?', created_at: '2026-10-21T10:00:00Z' }], push_subscriptions: [],
  receipt_inbox: [{ id: 'ib1', user_id: ME.id, storage_path: 'inbox/x/a.jpg', file_name: 'a.jpg', mime: 'image/jpeg', extracted: { supplier: 'Waltons', date: '2026-10-21', total: 250, lines: [{ description: 'A4 paper', qty: 5, unit_price: 50 }] }, status: 'unfiled', created_at: '2026-10-21T10:00:00Z' }],
  stock_reports: [{ id: 'sr1', item_id: ITEM.id, reported_by: OTHER.id, level: 'low', note: null, created_at: '2026-10-25T10:00:00Z', request_id: null, resolved_at: null, item: ITEM }],
  requests: [REQ],
  request_lines: [{ id: 'l1', request_id: REQ.id, line_no: 1, item_id: ITEM.id, description: 'A4 paper', qty: 5, est_unit_price: 50, qty_from_stock: 0, qty_to_buy: 5, item: ITEM }],
  request_events: [{ id: 'e1', request_id: REQ.id, actor_id: ME.id, action: 'submitted', from_status: 'draft', to_status: 'stock_review', created_at: '2026-10-18T10:00:00Z' }],
  expenses: [{ id: 'x1', request_id: REQ.id, spent_by: ME.id, spent_at: '2026-10-20', total: 0, change_returned: 0, proof_status: 'pending', lines: [], proofs: [] }],
  stock_movements: [{ id: 'm1', item_id: ITEM.id, kind: 'issue_out', delta: -2, created_by: ME.id, issued_to: ME.id, created_at: '2026-10-18T12:00:00Z', item: ITEM, void: false }],
  items: [ITEM],
  categories: [{ id: 'c1', name: 'Stationery', kind: 'stock', active: true }],
  suppliers: [{ id: 's1', name: 'Waltons', active: true }],
  v_floats: [{ id: 'f0', period: '2026-09-01', status: 'closed', opening_amount: 3000, allocated: 3000, topped_up: 0, carried_over: 0, returned: 0, spent: 2000, outstanding: 0, balance: 1000, counted_cash: 1000, opened_at: '2026-09-01T08:00:00Z', opened_by: OTHER.id, closed_at: '2026-10-01T07:00:00Z', closed_by: OTHER.id, notes: null }, { id: 'f1', period: '2026-10-01', status: 'open', opening_amount: 3000, allocated: 3000, topped_up: 0, carried_over: 0, returned: 0, spent: 120, outstanding: 250, balance: 2630, opened_at: '2026-10-01T08:00:00Z', opened_by: OTHER.id }],
  float_transactions: [{ id: 't1', float_id: 'f1', kind: 'allocation', amount: 3000, created_at: '2026-10-01T08:00:00Z' }],
  v_spend_lines: [{ id: 'sl1', spent_at: '2026-10-05', month: '2026-10-01', request_id: REQ.id, request_no: 1000, type: 'stock', requester_id: ME.id, requester_name: 'Ada Admin', item_id: ITEM.id, description: 'A4 paper', qty: 2, unit_price: 60, line_total: 120, category_name: 'Stationery', supplier_name: 'Waltons', float_id: 'f1', status: 'closed', approval_required: false }],
  v_price_history: [{ id: 'p1', on_date: '2026-10-05', item_id: ITEM.id, item_name: 'A4 paper', unit: 'ream', qty: 2, unit_price: 60, supplier_name: 'Waltons' }, { id: 'p2', on_date: '2026-09-05', item_id: ITEM.id, item_name: 'A4 paper', unit: 'ream', qty: 2, unit_price: 55 }],
  expense_proofs: [], invitations: [], floats: [], security_events: [{ id: 1, user_id: ME.id, kind: 'new_device', detail: { label: 'Windows PC · Chrome', place: 'Windhoek, Namibia' }, actor_id: null, at: '2026-10-21T10:00:00Z' }],
};

function builder(table) {
  const rows = TABLES[table] || [];
  const state = { single: false, count: false };
  const p = new Proxy({}, {
    get(_, prop) {
      if (prop === 'then') return (res, rej) => Promise.resolve(result()).then(res, rej);
      if (prop === 'single' || prop === 'maybeSingle') return () => { state.single = true; return p; };
      if (prop === 'select') return (cols, opts) => { if (opts?.count) state.count = true; calls.push(`${table}.select`); return p; };
      return (...args) => { calls.push(`${table}.${String(prop)}`); return p; };
    },
  });
  function result() {
    if (state.count) return { data: null, error: null, count: rows.length };
    return { data: state.single ? (rows[0] ?? null) : rows, error: null, count: rows.length };
  }
  return p;
}

// SIGNED_OUT=1 starts without a session; signInWithPassword / signOut then emit the same events supabase would
export const auth = { session: process.env.SIGNED_OUT ? null : { user: { id: ME.id }, access_token: TOKEN }, listeners: [] };
export const emitAuth = (ev) => { for (const l of auth.listeners) l(ev, auth.session); };
export function createClient() {
  return {
    auth: {
      getSession: async () => ({ data: { session: auth.session } }),
      onAuthStateChange: (cb) => { auth.listeners.push(cb); return { data: { subscription: { unsubscribe() {} } } }; },
      signOut: async (opts) => { auth.lastSignOut = opts || null; auth.session = null; emitAuth('SIGNED_OUT'); return {}; },
      signInWithPassword: async () => { auth.session = { user: { id: ME.id }, access_token: TOKEN }; emitAuth('SIGNED_IN'); return { error: null }; },
      verifyOtp: async () => { auth.session = { user: { id: ME.id }, access_token: TOKEN }; return { data: { session: auth.session }, error: null }; }, signInWithOtp: async () => ({ error: null }), updateUser: async () => ({ error: null }), resetPasswordForEmail: async () => ({ error: null }),
    },
    from: (t) => builder(t),
    rpc: async (fn, args) => {
      calls.push(`rpc.${fn}`); rpcArgs.push([fn, args]);
      const canned = { my_roles: ['approver', 'finance'], budget_status: [{ budget_id: 'b1', category_id: 'c1', person_id: null, label: 'Stationery', monthly_limit: 1500, used: 620, note: null, active: true }], item_usage_stats: [], mark_notifications_read: 1, quick_count: 1,
        devices: [
          { session_id: SID, label: 'iPhone · installed app', user_agent: 'iPhone', place: 'Windhoek, Namibia', country: 'NA', approx: false, ip: '1.1.1.1', tz: 'Africa/Windhoek', standalone: true, signed_in_at: '2026-10-20T10:00:00Z', last_active: new Date().toISOString(), alerts: true, reported: true },
          { session_id: '5e550002-0000-4000-8000-000000000000', label: null, user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/155', place: null, country: null, approx: false, ip: '2.2.2.2', tz: null, standalone: null, signed_in_at: '2026-10-21T10:00:00Z', last_active: '2026-10-21T10:00:00Z', alerts: false, reported: false }],
        device_counts: [{ user_id: ME.id, devices: 2, last_active: new Date().toISOString(), places: 'Windhoek, Namibia' }, { user_id: OTHER.id, devices: 1, last_active: new Date().toISOString(), places: 'Luanda, Angola' }],
        sign_out_devices: 1, ask_for_stock: { id: 'sr9' },
        mark_tip: {}, setup_status: { company: true, people: false, finance_named: null, stock_manager_named: null, items: 1, float: false, alerts: false },
        claims_summary: [{ person_id: OTHER.id, person_name: 'Fin Person', claims: 1, claimed: 80, all_spend: 400, share: 20 }],
        expense_checks: [{ request_id: REQ.id, status: 'matches', note: 'Receipt reads N$250.00 – matches what was recorded', reading_total: 250 }],
        float_outlook: { has_float: true, balance: 2630, outstanding: 250, spent: 120, funds: 3000, awaiting: 0, pending_other: 0, this_request: 250, after_approval: 2380, after_all_pending: 2380, days_left: 5, days_in_month: 31, expected_remaining: 400, reserve: 460, buffer_pct: 15, typical_month: 2400, months: 3, basis: '3 months of spending', status: 'ok' } };
      return { data: fn in canned ? canned[fn] : TABLES.requests[0], error: null };
    },
    storage: { from: () => ({ upload: async () => ({ error: null }), move: async () => ({ error: null }), createSignedUrl: async () => ({ data: { signedUrl: 'https://x/y' }, error: null }), remove: async () => ({}) }) },
  };
}
