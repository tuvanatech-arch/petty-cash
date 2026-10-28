// Static scan: every database call in the app checked against the live schema.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
const cat = JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url)));
const cols = Object.fromEntries(Object.entries(cat.tables).map(([t, c]) => [t, new Set(c.split(','))]));
const fks = cat.fks.split(' ').map((s) => { const [a, b] = s.split('>'); const [t, c] = a.split('.'); return { t, c, ref: b }; });
const fns = Object.fromEntries(Object.entries(cat.fns).map(([n, v]) => { const [args, auth] = v.split('|'); return [n, { args: args ? args.split(',') : [], auth }]; }));
const root = process.argv[2];
const files = [];
const walk = (d) => { for (const f of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
walk(root);
const issues = []; const seen = { tables: new Set(), rpcs: new Set() };
const note = (file, line, msg) => issues.push(`${path.relative(root, file)}:${line}  ${msg}`);

// read a balanced (...) starting at index of '('
function balanced(s, i) { let d = 0; for (let j = i; j < s.length; j++) { const c = s[j]; if (c === "'" || c === '"' || c === '`') { const q = c; j++; while (j < s.length && s[j] !== q) { if (s[j] === '\\') j++; j++; } continue; } if (c === '(' || c === '[' || c === '{') d++; else if (c === ')' || c === ']' || c === '}') { d--; if (d === 0) return s.slice(i, j + 1); } } return s.slice(i); }
// the method chain after .from('t'): .a(...).b(...)
function chain(s, i) { const out = []; let j = i; for (;;) { const m = /^\s*\.(\w+)\(/.exec(s.slice(j, j + 200)); if (!m) break; const start = j + m[0].length - 1; const args = balanced(s, start); out.push({ name: m[1], args: args.slice(1, -1) }); j = start + args.length; } return out; }
// parse a PostgREST select string: cols, alias:table(cols), table(cols), table!fk(cols)
function parseSelect(str, table, file, line) {
  const parts = []; let d = 0, cur = '';
  for (const ch of str) { if (ch === '(') d++; if (ch === ')') d--; if (ch === ',' && d === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch; }
  if (cur.trim()) parts.push(cur.trim());
  for (const p of parts) {
    if (p === '*' || p === '') continue;
    const em = /^(?:(\w+):)?(\w+)(?:!(\w+))?\((.*)\)$/s.exec(p);
    if (em) {
      const [, , et, hint, inner] = em;
      if (!cols[et]) { note(file, line, `embed of unknown table "${et}" from ${table}`); continue; }
      const links = fks.filter((f) => (f.t === table && f.ref === et) || (f.t === et && f.ref === table));
      if (!links.length) note(file, line, `embed ${table} → ${et}: no foreign key between them`);
      else if (links.length > 1 && !hint) note(file, line, `embed ${table} → ${et} is ambiguous (${links.map((l) => `${l.t}.${l.c}`).join(', ')}) – needs !fk hint`);
      parseSelect(inner, et, file, line);
      continue;
    }
    const c = p.replace(/::\w+$/, '').split(':').pop().trim();
    if (!cols[table].has(c)) note(file, line, `${table}.${c} does not exist (select)`);
  }
}
const FILTERS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'like', 'ilike', 'order', 'contains', 'not', 'match']);
function objKeys(src) {
  const s = src.trim(); if (!s.startsWith('{') && !s.startsWith('[')) return null;
  const body = s.startsWith('[') ? null : s;
  if (!body) return null;
  const keys = []; let d = 0; let tok = '';
  for (let i = 1; i < body.length - 1; i++) { const c = body[i]; if ('([{'.includes(c)) d++; if (')]}'.includes(c)) d--; if (d === 0 && c === ',') { keys.push(tok); tok = ''; } else tok += c; }
  keys.push(tok);
  return keys.map((k) => k.trim()).filter(Boolean).map((k) => (k.startsWith('...') ? '...' : (/^(\w+)\s*:/.exec(k)?.[1] || (/^\w+$/.test(k) ? k : '?'))));
}
for (const file of files) {
  const s = readFileSync(file, 'utf8');
  const lineOf = (i) => s.slice(0, i).split('\n').length;
  for (const m of s.matchAll(/(?<!storage)\.from\('(\w+)'\)/g)) {
    const before = s.slice(Math.max(0, m.index - 12), m.index);
    if (/storage$/.test(before) || /\.storage\s*$/.test(before)) continue;
    const t = m[1]; const line = lineOf(m.index);
    if (!cols[t]) { note(file, line, `table "${t}" does not exist`); continue; }
    seen.tables.add(t);
    for (const c of chain(s, m.index + m[0].length)) {
      const q = /^\s*'([^']*)'/.exec(c.args);
      if (c.name === 'select' && q) parseSelect(q[1], t, file, line);
      else if (FILTERS.has(c.name) && q) { const col = q[1].split('.')[0]; if (!cols[t].has(col) && !/^\w+$/.test(col) === false && !cols[t].has(col)) note(file, line, `${t}.${col} does not exist (.${c.name})`); }
      else if (c.name === 'or' && /^\s*[`']/.test(c.args)) { for (const mm of c.args.matchAll(/(\w+)\.(eq|neq|gt|gte|lt|lte|in|is)\./g)) if (!cols[t].has(mm[1]) && mm[1] !== 'and' && mm[1] !== 'or') note(file, line, `${t}.${mm[1]} does not exist (.or)`); }
      else if (['insert', 'update', 'upsert'].includes(c.name)) {
        const keys = objKeys(c.args);
        if (!keys) { issues.push(`${path.relative(root, file)}:${line}  [check by hand] ${t}.${c.name}(${c.args.slice(0, 60).replace(/\s+/g, ' ')}…)`); continue; }
        for (const k of keys) if (k !== '...' && k !== '?' && !cols[t].has(k)) note(file, line, `${t}.${k} does not exist (${c.name})`);
        if (keys.includes('...') || keys.includes('?')) issues.push(`${path.relative(root, file)}:${line}  [check by hand] ${t}.${c.name} spreads/computed keys: ${c.args.slice(0, 80).replace(/\s+/g, ' ')}`);
      }
    }
  }
  for (const m of s.matchAll(/\.storage\.from\('([\w-]+)'\)/g)) if (!cat.buckets.includes(m[1])) note(file, lineOf(m.index), `storage bucket "${m[1]}" does not exist`);
  for (const m of s.matchAll(/\brpc\(\s*'(\w+)'\s*(?:,\s*)?/g)) {
    const name = m[1]; const line = lineOf(m.index); seen.rpcs.add(name);
    const f = fns[name]; if (!f) { note(file, line, `function ${name}() does not exist`); continue; }
    if (f.auth !== 'auth') note(file, line, `function ${name}() is not callable by signed-in users`);
    const rest = s.slice(m.index + m[0].length);
    if (rest.startsWith('{')) { const keys = objKeys(balanced(rest, 0)); for (const k of keys || []) if (k !== '...' && k !== '?' && !f.args.includes(k)) note(file, line, `${name}(): argument "${k}" does not exist (has ${f.args.join(', ') || 'none'})`); }
  }
}
console.log(`files ${files.length} · tables used ${seen.tables.size} · functions used ${seen.rpcs.size}`);
console.log(`functions callable by everyone but never used by the app: ${Object.entries(fns).filter(([n, f]) => f.auth === 'auth' && !seen.rpcs.has(n)).map(([n]) => n).join(', ')}`);
console.log(issues.length ? issues.join('\n') : 'no issues');
