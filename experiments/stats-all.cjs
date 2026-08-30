// Сводная статистика по всем транскриптам Claude Code (~/.claude/projects).
// Запуск: node experiments/stats-all.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(process.env.USERPROFILE || process.env.HOME, '.claude', 'projects');
const isTemp = (d) => /AppData-Local-Temp/i.test(d);

const S = () => ({
  files: 0, bytes: 0,
  sessions: new Set(),
  userMsgs: 0, userChars: 0,
  asstMsgs: 0, asstChars: 0, asstThinkChars: 0,
  toolCalls: 0, toolResultChars: 0,
  sideUser: 0, sideAsst: 0, sideChars: 0,
  tokIn: 0, tokOut: 0, tokCacheRead: 0, tokCacheWrite: 0,
  models: new Map(), tools: new Map(),
  days: new Map(),          // YYYY-MM-DD -> {user, asst}
  hours: new Array(24).fill(0),
  perProject: new Map(),
  firstTs: null, lastTs: null,
});

const real = S(), temp = S();

function textOf(content) {
  if (typeof content === 'string') return { text: content, isToolResult: false, tools: [], think: 0 };
  if (!Array.isArray(content)) return { text: '', isToolResult: false, tools: [], think: 0 };
  let text = '', think = 0, isToolResult = false; const tools = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') text += b.text;
    else if (b.type === 'thinking' && typeof b.thinking === 'string') think += b.thinking.length;
    else if (b.type === 'tool_use') tools.push(b.name || '?');
    else if (b.type === 'tool_result') {
      isToolResult = true;
      const c = b.content;
      if (typeof c === 'string') text += c;
      else if (Array.isArray(c)) for (const x of c) if (x && x.type === 'text' && x.text) text += x.text;
    }
  }
  return { text, isToolResult, tools, think };
}

const bump = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);

for (const dir of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const st = isTemp(dir.name) ? temp : real;
  const dp = path.join(ROOT, dir.name);
  // Транскрипты чатов лежат в корне папки проекта; транскрипты субагентов —
  // в <sessionId>/subagents/*.jsonl, их надо обойти рекурсивно.
  const walk = (p) => {
    let ents; try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch { return []; }
    return ents.flatMap((e) => e.isDirectory() ? walk(path.join(p, e.name))
      : e.name.endsWith('.jsonl') ? [path.join(p, e.name)] : []);
  };
  const files = walk(dp);
  if (!files.length) continue;

  for (const fp of files) {
    const f = path.relative(dp, fp).replace(/\\/g, '/');
    const isSub = f.includes('/subagents/');
    let raw;
    try { raw = fs.readFileSync(fp, 'utf8'); } catch { continue; }
    st.files++; st.bytes += Buffer.byteLength(raw);
    if (isSub) st.subFiles = (st.subFiles || 0) + 1; else st.sessions.add(dir.name + '/' + f);

    for (const line of raw.split('\n')) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const ts = o.timestamp;
      if (ts) {
        if (!st.firstTs || ts < st.firstTs) st.firstTs = ts;
        if (!st.lastTs || ts > st.lastTs) st.lastTs = ts;
      }
      const msg = o.message;
      if (!msg || (o.type !== 'user' && o.type !== 'assistant')) continue;
      const { text, isToolResult, tools, think } = textOf(msg.content);
      const day = ts ? ts.slice(0, 10) : null;
      const d = day ? (st.days.get(day) || st.days.set(day, { user: 0, asst: 0 }).get(day)) : null;
      const pp = st.perProject.get(dir.name) || st.perProject.set(dir.name, { sessions: new Set(), user: 0, asst: 0, chars: 0, out: 0 }).get(dir.name);
      if (!isSub) pp.sessions.add(f);

      if (o.isSidechain || isSub) {
        if (o.type === 'user') st.sideUser++; else st.sideAsst++;
        st.sideChars += text.length;
      } else if (o.type === 'user') {
        if (isToolResult) st.toolResultChars += text.length;
        else if (!o.isMeta) { st.userMsgs++; st.userChars += text.length; if (d) d.user++; pp.user++; pp.chars += text.length;
          if (ts) st.hours[new Date(ts).getHours()]++; }
      } else {
        st.asstMsgs++; st.asstChars += text.length; st.asstThinkChars += think;
        if (text.length) st.asstTextMsgs = (st.asstTextMsgs || 0) + 1;
        if (d) d.asst++; pp.asst++; pp.chars += text.length;
      }
      if (o.type === 'assistant') {
        st.toolCalls += tools.length;
        for (const t of tools) bump(st.tools, t);
        if (msg.model) bump(st.models, msg.model);
        const u = msg.usage;
        if (u) {
          st.tokIn += u.input_tokens || 0;
          st.tokOut += u.output_tokens || 0;
          st.tokCacheRead += u.cache_read_input_tokens || 0;
          st.tokCacheWrite += u.cache_creation_input_tokens || 0;
          pp.out += u.output_tokens || 0;
        }
      }
    }
  }
}

const fmt = (n) => n.toLocaleString('ru-RU');
const mb = (b) => (b / 1024 / 1024).toFixed(1) + ' МБ';

function report(name, st) {
  const days = [...st.days.entries()].sort();
  const active = days.length;
  const span = st.firstTs && st.lastTs
    ? Math.round((new Date(st.lastTs) - new Date(st.firstTs)) / 86400000) + 1 : 0;
  const totalMsgs = st.userMsgs + st.asstMsgs;
  console.log('\n===== ' + name + ' =====');
  console.log('проектов (папок):        ' + fmt(st.perProject.size));
  console.log('чатов (сессий):          ' + fmt(st.sessions.size));
  console.log('объём транскриптов:      ' + mb(st.bytes));
  console.log('период:                  ' + (st.firstTs || '').slice(0, 10) + ' — ' + (st.lastTs || '').slice(0, 10) + '  (' + span + ' дн., активных ' + active + ')');
  console.log('');
  console.log('мои сообщения:           ' + fmt(st.userMsgs) + '  (' + fmt(st.userChars) + ' знаков, ' + mb(st.userChars) + ')');
  console.log('ответы Клода:            ' + fmt(st.asstMsgs) + '  (' + fmt(st.asstChars) + ' знаков, ' + mb(st.asstChars) + ')');
  console.log('  из них размышления:    ' + fmt(st.asstThinkChars) + ' знаков');
  console.log('вызовов инструментов:    ' + fmt(st.toolCalls) + '  (результаты: ' + mb(st.toolResultChars) + ')');
  console.log('субагенты:               ' + fmt(st.subFiles || 0) + ' запусков, ' + fmt(st.sideUser + st.sideAsst) + ' сообщений, ' + mb(st.sideChars));
  console.log('');
  console.log('среднее моё сообщение:   ' + Math.round(st.userChars / (st.userMsgs || 1)) + ' знаков');
  console.log('реплик с текстом:        ' + fmt(st.asstTextMsgs || 0) + ', в среднем ' + Math.round(st.asstChars / (st.asstTextMsgs || 1)) + ' знаков');
  console.log('сообщений в чате:        ' + (totalMsgs / (st.sessions.size || 1)).toFixed(1) + ' (мои: ' + (st.userMsgs / (st.sessions.size || 1)).toFixed(1) + ')');
  console.log('');
  console.log('в день (активных):       ' + (st.userMsgs / (active || 1)).toFixed(1) + ' моих, ' + (st.asstMsgs / (active || 1)).toFixed(1) + ' ответов, ' + (st.sessions.size / (active || 1)).toFixed(1) + ' чатов');
  console.log('в день (календарных):    ' + (st.userMsgs / (span || 1)).toFixed(1) + ' моих сообщений');
  console.log('');
  console.log('токены: вход ' + fmt(st.tokIn) + ' | выход ' + fmt(st.tokOut) + ' | кэш чтение ' + fmt(st.tokCacheRead) + ' | кэш запись ' + fmt(st.tokCacheWrite));
  console.log('модели: ' + [...st.models.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + fmt(v)).join(', '));
  console.log('топ инструментов: ' + [...st.tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => k + ' ' + fmt(v)).join(', '));

  if (name.startsWith('РЕАЛ')) {
    console.log('\n-- по проектам --');
    for (const [k, v] of [...st.perProject.entries()].sort((a, b) => b[1].chars - a[1].chars)) {
      console.log('  ' + k.padEnd(50) + ' чатов ' + String(v.sessions.size).padStart(4) + ' | мои ' + String(v.user).padStart(5) + ' | ответы ' + String(v.asst).padStart(6) + ' | ' + mb(v.chars).padStart(9));
    }
    console.log('\n-- по дням (последние 20) --');
    for (const [d, v] of days.slice(-20)) console.log('  ' + d + '  мои ' + String(v.user).padStart(4) + ' | ответы ' + String(v.asst).padStart(5));
    const busiest = [...days].sort((a, b) => b[1].user - a[1].user)[0];
    if (busiest) console.log('\nсамый плотный день: ' + busiest[0] + ' — ' + busiest[1].user + ' моих сообщений');
    console.log('\n-- по часам суток (мои сообщения) --');
    const max = Math.max(...st.hours);
    st.hours.forEach((n, h) => console.log('  ' + String(h).padStart(2, '0') + ':00 ' + '#'.repeat(Math.round((n / (max || 1)) * 40)) + ' ' + n));
  }
}

report('РЕАЛЬНЫЕ ПРОЕКТЫ', real);
report('ТЕСТОВЫЕ ПАПКИ (temp, e2e remaude)', temp);
