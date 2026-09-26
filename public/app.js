'use strict';

// ---------------- 状态 ----------------
let state = { cues: [], schedule: [], conflicts: [], graphErrors: [] };
let editingId = null;
let fragment = null; // 当前片段预览结果
let fragmentStale = false; // 原提示单发生增删改后，旧预览失效
let deferPlan = null; // 当前顺延预演结果
let deferStale = false; // 提示单发生增删改后，旧预演失效（确认时服务端也会再核对版本）
let rehearsal = null; // 当前排练视图（GET /api/rehearsal 的 rehearsal；null 表示无进行中排练）
let rehEditing = null; // 勘误中的单元格 { cueId, field: 'start'|'end', draft }；null 表示未在勘误
let undoPlan = null; // 当前撤回结束登记预演结果
let undoStale = false; // 排练登记在预演后已变化，旧预演失效（确认时服务端也会再核对排练记录版本）
let gapResult = null; // 当前共同空档查询结果
let gapStale = false; // 提示单发生增删改后，旧查询结果失效（再次查询即使用新计划）
let gapChecked = null; // 已勾选的通道名集合；null 表示尚未初始化（首次渲染默认全选）

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// ---------------- 工具 ----------------
function fmtNum(s) {
  if (s === null || s === undefined) return '—';
  return Number(s).toFixed(3).replace(/\.?0+$/, '');
}
function scheduleById() {
  const m = new Map();
  for (const s of state.schedule) m.set(s.id, s);
  return m;
}
function cueName(id) {
  const c = state.cues.find((x) => x.id === id);
  return c ? c.name : `（已删除 ${id}）`;
}

// ---------------- API ----------------
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* 非 JSON */ }
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `请求失败（${res.status}）`;
    const errors = (data && data.error && data.error.errors) || [msg];
    const e = new Error(msg);
    e.errors = errors;
    e.status = res.status;
    e.code = data && data.error && data.error.code;
    throw e;
  }
  return data;
}

async function reload(notice) {
  const [cuesData, rehData] = await Promise.all([
    api('GET', '/api/cues'),
    api('GET', '/api/rehearsal'),
  ]);
  state = cuesData;
  rehearsal = rehData.rehearsal;
  markFragmentStale();
  markDeferStale();
  markGapStale();
  render();
  renderRehearsal();
  if (notice) showBanner(notice, 'ok');
}

// ---------------- 顶部提示条 ----------------
let bannerTimer = null;
function showBanner(message, kind = 'info', sticky = false) {
  const b = $('#banner');
  b.className = `banner ${kind}`;
  b.innerHTML = '';
  b.append(el('span', null, message));
  b.classList.remove('hidden');
  clearTimeout(bannerTimer);
  if (!sticky) {
    bannerTimer = setTimeout(() => {
      b.classList.add('hidden');
      bannerTimer = null;
    }, 4000);
  }
}
function hideBanner() {
  $('#banner').classList.add('hidden');
}

// ---------------- 渲染：错误 / 冲突 ----------------
function renderErrors() {
  // 图错误（缺失引用、循环依赖）以粘性信息条显示
  const persistent = state.graphErrors || [];
  if (persistent.length) {
    const b = $('#banner');
    b.className = 'banner err';
    b.innerHTML = '';
    b.append(el('strong', null, '存在无法排期的问题：'));
    const ul = el('ul');
    ul.style.margin = '6px 0 0';
    ul.style.paddingLeft = '18px';
    for (const e of persistent) ul.append(el('li', null, e.message));
    b.append(ul);
    b.classList.remove('hidden');
  } else if (!bannerTimer) {
    hideBanner();
  }
}

function renderConflicts(conflictIds) {
  const panel = $('#conflictPanel');
  const list = $('#conflictList');
  list.innerHTML = '';
  if (!state.conflicts.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  for (const cf of state.conflicts) {
    const [a, b] = cf.cueIds;
    const li = el('li');
    li.append(el('span', 'tag', cf.channel));
    li.append(document.createTextNode(
      `「${cueName(a)}」与「${cueName(b)}」在 ${fmtNum(cf.start)}s – ${fmtNum(cf.end)}s 重叠（左闭右开）`
    ));
    const acts = el('span', 'conflict-actions');
    for (const id of [a, b]) {
      const btn = el('button', 'btn small', `顺延「${cueName(id)}」`);
      btn.type = 'button';
      btn.title = '预演把该提示顺推到本通道最早完整空位';
      btn.addEventListener('click', () => previewDeferral(id));
      acts.append(btn);
    }
    li.append(acts);
    list.append(li);
    conflictIds.add(a);
    conflictIds.add(b);
  }
}

// ---------------- 渲染：时间轴 ----------------
function niceStep(span) {
  const target = span / 10; // 期望约 10 格
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  const n = target / pow;
  let mult;
  if (n < 1.5) mult = 1;
  else if (n < 3) mult = 2;
  else if (n < 7) mult = 5;
  else mult = 10;
  return mult * pow;
}

function renderTimeline(conflictIds, schedMap) {
  const root = $('#timeline');
  root.innerHTML = '';

  const good = state.cues
    .map((c) => ({ c, t: schedMap.get(c.id) }))
    .filter((x) => x.t && x.t.start !== null);

  if (!good.length) {
    root.append(el('div', 'tl-empty', '暂无可绘制的提示（新增一条，或先解决引用/循环问题）'));
    return;
  }

  const maxEnd = Math.max(...good.map((x) => x.t.end));
  const span = Math.max(maxEnd * 1.05, 1);
  const pct = (sec) => `${(sec / span) * 100}%`;
  const step = niceStep(span);

  // 按通道分组
  const channels = new Map();
  for (const c of state.cues) {
    if (!channels.has(c.channel)) channels.set(c.channel, []);
    channels.get(c.channel).push(c);
  }

  for (const [channel, cues] of [...channels].sort((a, b) => a[0].localeCompare(b[0]))) {
    const wrapEl = el('div', 'tl-channel');
    wrapEl.append(el('div', 'tl-channel-name', `🔌 ${channel}`));

    const track = el('div', 'tl-track');

    // 网格
    for (let g = 0; g <= span; g += step) {
      const line = el('div', 'tl-grid');
      line.style.left = pct(g);
      const lab = el('div', 'tl-grid-label', fmtNum(g));
      lab.style.left = '2px';
      line.append(lab);
      track.append(line);
    }

    // 冲突红色覆盖层（先放，块在其上）
    for (const cf of state.conflicts) {
      if (cf.channel !== channel) continue;
      const ov = el('div', 'tl-overlap');
      ov.style.left = pct(cf.start);
      ov.style.width = `${((cf.end - cf.start) / span) * 100}%`;
      ov.title = `冲突 ${fmtNum(cf.start)}s – ${fmtNum(cf.end)}s`;
      track.append(ov);
    }

    // 提示块
    for (const c of cues) {
      const t = schedMap.get(c.id);
      if (!t || t.start === null) continue;
      const b = el('div', 'tl-block' + (conflictIds.has(c.id) ? ' has-conflict' : ''));
      b.style.left = pct(t.start);
      b.style.width = pct(Math.max(t.end - t.start, 0.0001));
      b.textContent = c.name;
      b.title = `${c.name}\n${fmtNum(t.start)}s → ${fmtNum(t.end)}s（持续 ${fmtNum(c.duration)}s）`;
      b.addEventListener('click', () => startEdit(c.id));
      track.append(b);
    }

    wrapEl.append(track);

    // 该通道下时间未定的提示（引用缺失 / 在环上）
    const unresolved = cues.filter((c) => {
      const t = schedMap.get(c.id);
      return !t || t.start === null;
    });
    if (unresolved.length) {
      const urow = el('div', 'tl-unresolved');
      for (const c of unresolved) {
        const pill = el('button', 'unk-pill', `⏳ ${c.name}（时间未定）`);
        pill.type = 'button';
        pill.addEventListener('click', () => startEdit(c.id));
        urow.append(pill);
      }
      wrapEl.append(urow);
    }

    root.append(wrapEl);
  }

  // 统一时间标尺
  const scale = el('div', 'tl-scale');
  for (let g = 0; g <= span; g += step) {
    const lab = el('div', 'tl-grid-label', fmtNum(g));
    lab.style.left = pct(g);
    lab.style.transform = 'none';
    scale.append(lab);
  }
  root.append(scale);
}

// ---------------- 渲染：表格 ----------------
function startDesc(c) {
  if (c.startType === 'fixed') {
    return `固定第 ${fmtNum(c.fixedAt)}s`;
  }
  return `「${cueName(c.afterCueId)}」结束 +${fmtNum(c.delayAfter)}s`;
}

function renderTable(conflictIds) {
  const tbody = $('#cueTbody');
  tbody.innerHTML = '';
  const schedMap = scheduleById();

  state.cues.forEach((c, i) => {
    const t = schedMap.get(c.id);
    const tr = el('tr');
    if (conflictIds.has(c.id)) tr.classList.add('row-conflict');
    if (!t || t.start === null) tr.classList.add('row-error');

    tr.append(el('td', 'num', String(i + 1)));
    tr.append(el('td', 'name-cell', c.name));
    tr.append(el('td', null, c.channel));
    tr.append(el('td', 'num', fmtNum(c.duration)));
    tr.append(el('td', null, startDesc(c)));

    const startTd = el('td', 'num');
    const endTd = el('td', 'num');
    const statusTd = el('td');
    if (!t || t.start === null) {
      startTd.textContent = '—';
      endTd.textContent = '—';
      statusTd.append(el('span', 'pill unknown', '时间未定'));
    } else {
      startTd.textContent = fmtNum(t.start);
      endTd.textContent = fmtNum(t.end);
      if (conflictIds.has(c.id)) {
        statusTd.append(el('span', 'pill bad', '通道冲突'));
      } else {
        statusTd.append(el('span', 'pill ok', '正常'));
      }
    }

    const actTd = el('td');
    const actWrap = el('div', 'actions');
    const editBtn = el('button', 'btn small', '编辑');
    editBtn.type = 'button';
    editBtn.addEventListener('click', () => startEdit(c.id));
    const delBtn = el('button', 'btn small danger', '删除');
    delBtn.type = 'button';
    delBtn.addEventListener('click', () => removeCue(c));
    actWrap.append(editBtn, delBtn);
    actTd.append(actWrap);

    tr.append(startTd, endTd, statusTd, actTd);
    tbody.append(tr);
  });
}

// ---------------- 渲染总入口 ----------------
function render() {
  const schedMap = scheduleById();
  const conflictIds = new Set();
  renderConflicts(conflictIds);
  renderErrors();
  renderTimeline(conflictIds, schedMap);
  renderTable(conflictIds);
  renderAfterOptions();
  renderGapChannels();
  updateFormMode();
}

// ---------------- 表单 ----------------
function renderAfterOptions() {
  const sel = $('#f-afterCueId');
  const prev = sel.value;
  sel.innerHTML = '';
  for (const c of state.cues) {
    if (c.id === editingId) continue; // 不能以自己为前置
    const opt = el('option', null, `${c.name}（${c.channel}）`);
    opt.value = c.id;
    sel.append(opt);
  }
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function getStartType() {
  return document.querySelector('input[name="startType"]:checked').value;
}

function syncStartBoxes() {
  const isAfter = getStartType() === 'after';
  $('#fixedBox').hidden = isAfter;
  $('#afterBox').hidden = !isAfter;
  $('#f-fixedAt').disabled = isAfter;
  $('#f-afterCueId').disabled = !isAfter;
  $('#f-delayAfter').disabled = !isAfter;
}

function updateFormMode() {
  $('#formTitle').textContent = editingId ? '✏️ 编辑提示' : '➕ 新增提示';
  $('#submitBtn').textContent = editingId ? '保存修改并重算' : '保存新增';
  $('#cancelEdit').hidden = !editingId;
}

function resetForm() {
  $('#cueForm').reset();
  editingId = null;
  $('#f-id').value = '';
  document.querySelector('input[name="startType"][value="fixed"]').checked = true;
  $('#f-fixedAt').value = '0';
  $('#f-delayAfter').value = '0';
  syncStartBoxes();
  renderAfterOptions();
  updateFormMode();
}

function startEdit(id) {
  const c = state.cues.find((x) => x.id === id);
  if (!c) return;
  editingId = id;
  $('#f-id').value = id;
  $('#f-name').value = c.name;
  $('#f-channel').value = c.channel;
  $('#f-duration').value = c.duration;
  document.querySelector(`input[name="startType"][value="${c.startType}"]`).checked = true;
  renderAfterOptions();
  if (c.startType === 'fixed') {
    $('#f-fixedAt').value = c.fixedAt;
  } else {
    $('#f-afterCueId').value = c.afterCueId;
    $('#f-delayAfter').value = c.delayAfter;
  }
  syncStartBoxes();
  updateFormMode();
  document.querySelector('.cue-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function submitForm(e) {
  e.preventDefault();
  const isAfter = getStartType() === 'after';
  const body = {
    name: $('#f-name').value,
    channel: $('#f-channel').value,
    duration: $('#f-duration').value,
    startType: getStartType(),
    fixedAt: isAfter ? 0 : $('#f-fixedAt').value,
    afterCueId: isAfter ? $('#f-afterCueId').value : null,
    delayAfter: isAfter ? $('#f-delayAfter').value : 0,
  };

  const btn = $('#submitBtn');
  btn.disabled = true;
  try {
    if (editingId) {
      await api('PUT', `/api/cues/${encodeURIComponent(editingId)}`, body);
    } else {
      await api('POST', '/api/cues', body);
    }
    const wasEditing = editingId;
    resetForm();
    await reload(wasEditing ? '已保存，后继提示已全部重算' : '已新增，时间轴已重算');
  } catch (err) {
    showBanner(err.errors.join('\n') || err.message, 'err');
    // 让多条错误换行
    const b = $('#banner');
    b.innerHTML = '';
    b.append(el('strong', null, '保存被拒绝：'));
    const ul = el('ul');
    ul.style.margin = '6px 0 0';
    ul.style.paddingLeft = '18px';
    for (const m of err.errors) ul.append(el('li', null, m));
    b.append(ul);
  } finally {
    btn.disabled = false;
  }
}

async function removeCue(c) {
  if (!confirm(`确定删除「${c.name}」？\n删除后所有后继提示会立即重算。`)) return;
  try {
    await api('DELETE', `/api/cues/${encodeURIComponent(c.id)}`);
    if (editingId === c.id) resetForm();
    await reload('已删除并重算');
  } catch (err) {
    showBanner(err.message, 'err');
  }
}

// ---------------- 片段排练单 ----------------
function showFragError(messages) {
  const box = $('#fragError');
  box.className = 'banner err';
  box.innerHTML = '';
  box.append(el('strong', null, '无法生成片段：'));
  const ul = el('ul');
  ul.style.margin = '6px 0 0';
  ul.style.paddingLeft = '18px';
  for (const m of [].concat(messages)) ul.append(el('li', null, m));
  box.append(ul);
  box.classList.remove('hidden');
}
function hideFragError() {
  $('#fragError').classList.add('hidden');
}

function markFragmentStale() {
  if (!fragment) return;
  fragmentStale = true;
  $('#frDownloadBtn').disabled = true;
  const meta = $('#fragMeta');
  if (meta) {
    meta.classList.add('stale');
    meta.textContent = '原提示单已变更，当前预览已失效，请重新生成预览。';
  }
}

function renderFragmentTimeline() {
  const root = $('#fragTimeline');
  root.innerHTML = '';

  const schedMap = new Map(fragment.schedule.map((s) => [s.id, s]));
  const conflictIds = new Set();
  for (const cf of fragment.conflicts) cf.cueIds.forEach((id) => conflictIds.add(id));

  const span = Math.max(fragment.duration * 1.05, 1);
  const pct = (sec) => `${(sec / span) * 100}%`;
  const step = niceStep(span);

  const channels = new Map();
  for (const c of fragment.cues) {
    if (!channels.has(c.channel)) channels.set(c.channel, []);
    channels.get(c.channel).push(c);
  }

  for (const [channel, cues] of [...channels].sort((a, b) => a[0].localeCompare(b[0]))) {
    const wrapEl = el('div', 'tl-channel');
    wrapEl.append(el('div', 'tl-channel-name', `🔌 ${channel}`));
    const track = el('div', 'tl-track');

    for (let g = 0; g <= span; g += step) {
      const line = el('div', 'tl-grid');
      line.style.left = pct(g);
      const lab = el('div', 'tl-grid-label', fmtNum(g));
      lab.style.left = '2px';
      line.append(lab);
      track.append(line);
    }
    for (const cf of fragment.conflicts) {
      if (cf.channel !== channel) continue;
      const ov = el('div', 'tl-overlap');
      ov.style.left = pct(cf.start);
      ov.style.width = `${((cf.end - cf.start) / span) * 100}%`;
      ov.title = `冲突 ${fmtNum(cf.start)}s – ${fmtNum(cf.end)}s`;
      track.append(ov);
    }
    for (const c of cues) {
      const t = schedMap.get(c.id);
      if (!t || t.start === null) continue;
      const b = el('div', 'tl-block' + (conflictIds.has(c.id) ? ' has-conflict' : ''));
      b.style.left = pct(t.start);
      b.style.width = pct(Math.max(t.end - t.start, 0.0001));
      b.textContent = c.name;
      b.title = `${c.name}\n${fmtNum(t.start)}s → ${fmtNum(t.end)}s（持续 ${fmtNum(c.duration)}s）`;
      track.append(b);
    }
    wrapEl.append(track);
    root.append(wrapEl);
  }

  const scale = el('div', 'tl-scale');
  for (let g = 0; g <= span; g += step) {
    const lab = el('div', 'tl-grid-label', fmtNum(g));
    lab.style.left = pct(g);
    lab.style.transform = 'none';
    scale.append(lab);
  }
  root.append(scale);
}

function fragStartDesc(c) {
  if (c.startType === 'fixed') return `固定第 ${fmtNum(c.fixedAt)}s`;
  const dep = fragment.cues.find((x) => x.id === c.afterCueId);
  const depName = dep ? dep.name : `（未入选 ${c.afterCueId}）`;
  return `「${depName}」结束 +${fmtNum(c.delayAfter)}s`;
}

function renderFragmentTable() {
  const tbody = $('#fragTbody');
  tbody.innerHTML = '';
  const schedMap = new Map(fragment.schedule.map((s) => [s.id, s]));
  const selMap = new Map(fragment.selections.map((s) => [s.cueId, s]));
  const conflictIds = new Set();
  for (const cf of fragment.conflicts) cf.cueIds.forEach((id) => conflictIds.add(id));
  const changeMap = new Map(fragment.changes.map((ch) => [ch.cueId, ch]));

  fragment.cues.forEach((c, i) => {
    const t = schedMap.get(c.id);
    const sel = selMap.get(c.id);
    const ch = changeMap.get(c.id);
    const tr = el('tr');
    if (conflictIds.has(c.id)) tr.classList.add('row-conflict');

    tr.append(el('td', 'num', String(i + 1)));
    tr.append(el('td', 'name-cell', c.name));
    tr.append(el('td', null, c.channel));
    tr.append(el('td', 'num', fmtNum(c.duration)));
    tr.append(el('td', null, fragStartDesc(c)));
    tr.append(el('td', 'num', fmtNum(t.start)));
    tr.append(el('td', 'num', fmtNum(t.end)));
    tr.append(el('td', 'num', `${fmtNum(sel.origStart)} – ${fmtNum(sel.origEnd)}`));

    const noteTd = el('td');
    if (ch) {
      const text = ch.reason === 'crosses_left'
        ? '跨左边界，已改为固定开始'
        : '前置未入选片段，已改为固定开始';
      noteTd.append(el('span', 'pill unknown', text));
    } else if (c.startType === 'after') {
      noteTd.append(el('span', 'rel-muted', '保留相对前置'));
    } else {
      noteTd.append(el('span', 'rel-muted', '固定开始'));
    }
    tr.append(noteTd);
    tbody.append(tr);
  });
}

function renderFragmentConflicts() {
  const panel = $('#fragConflictPanel');
  const list = $('#fragConflictList');
  list.innerHTML = '';
  if (!fragment.conflicts.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const nameOf = (id) => {
    const c = fragment.cues.find((x) => x.id === id);
    return c ? c.name : id;
  };
  for (const cf of fragment.conflicts) {
    const [a, b] = cf.cueIds;
    const li = el('li');
    li.append(el('span', 'tag', cf.channel));
    li.append(document.createTextNode(
      `「${nameOf(a)}」与「${nameOf(b)}」在 ${fmtNum(cf.start)}s – ${fmtNum(cf.end)}s 重叠（左闭右开）`
    ));
    list.append(li);
  }
}

function renderFragment() {
  const box = $('#fragResult');
  if (!fragment) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const { start, end } = fragment.window;
  const fixedCount = fragment.changes.length;
  const meta = $('#fragMeta');
  meta.className = 'frag-meta' + (fragmentStale ? ' stale' : ' ok');
  meta.textContent =
    `原窗口 [${fmtNum(start)}, ${fmtNum(end)})（长 ${fmtNum(fragment.duration)}s）` +
    `｜入选 ${fragment.selectedCount} / ${fragment.totalCount} 条` +
    `｜${fixedCount} 条改为固定开始` +
    `｜冲突 ${fragment.conflicts.length} 处` +
    (fragmentStale ? '｜⚠️ 原提示单已变更，本预览已失效，请重新生成' : '');

  renderFragmentTimeline();
  renderFragmentConflicts();
  renderFragmentTable();
  $('#frDownloadBtn').disabled = fragmentStale;
}

async function previewFragment(e) {
  e.preventDefault();
  const body = {
    start: $('#fr-start').value,
    end: $('#fr-end').value,
  };
  const btn = $('#frPreviewBtn');
  btn.disabled = true;
  try {
    fragment = await api('POST', '/api/fragments/preview', body);
    fragmentStale = false;
    hideFragError();
    renderFragment();
  } catch (err) {
    fragment = null;
    $('#fragResult').hidden = true;
    $('#frDownloadBtn').disabled = true;
    showFragError(err.errors || [err.message]);
  } finally {
    btn.disabled = false;
  }
}

function downloadFragment() {
  if (!fragment || fragmentStale) return;
  const blob = new Blob([JSON.stringify(fragment.document, null, 2) + '\n'], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const { start, end } = fragment.window;
  const fmt = (n) => fmtNum(n).replace(/\./g, '-');
  a.href = url;
  a.download = `cue-fragment_${fmt(start)}-${fmt(end)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------------- 冲突顺延预演 ----------------
function showDeferError(messages) {
  const panel = $('#deferPanel');
  panel.hidden = false;
  $('#deferResult').hidden = true;
  const box = $('#deferError');
  box.className = 'banner err';
  box.innerHTML = '';
  box.append(el('strong', null, '无法预演顺延：'));
  const ul = el('ul');
  ul.style.margin = '6px 0 0';
  ul.style.paddingLeft = '18px';
  for (const m of [].concat(messages)) ul.append(el('li', null, m));
  box.append(ul);
  box.classList.remove('hidden');
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function clearDefer() {
  deferPlan = null;
  deferStale = false;
  $('#deferPanel').hidden = true;
  $('#deferResult').hidden = true;
  $('#deferError').classList.add('hidden');
}

function markDeferStale() {
  if (!deferPlan) return;
  deferStale = true;
  $('#deferConfirmBtn').disabled = true;
  const meta = $('#deferMeta');
  if (meta) {
    meta.classList.add('stale');
    meta.textContent = '提示单已变更，本预演已失效，请重新从冲突面板发起预演。';
  }
}

function deferConflictItems(listEl, items) {
  listEl.innerHTML = '';
  for (const cf of items) {
    const [a, b] = cf.cueIds;
    const li = el('li');
    li.append(el('span', 'tag', cf.channel));
    li.append(document.createTextNode(
      `「${cueName(a)}」与「${cueName(b)}」在 ${fmtNum(cf.start)}s – ${fmtNum(cf.end)}s 重叠（左闭右开）`
    ));
    listEl.append(li);
  }
}

function renderDefer() {
  const panel = $('#deferPanel');
  panel.hidden = false;
  $('#deferError').classList.add('hidden');
  $('#deferResult').hidden = false;

  const t = deferPlan.target;
  const adj = deferPlan.adjust;
  const meta = $('#deferMeta');
  meta.className = 'frag-meta' + (deferStale ? ' stale' : ' ok');
  if (!deferPlan.changed) {
    meta.textContent = `「${t.name}」（${deferPlan.channel}）当前位置已无冲突，无需顺延。`;
  } else {
    const how = adj.field === 'fixedAt'
      ? `固定开始 ${fmtNum(adj.from)}s → ${fmtNum(adj.to)}s`
      : `相对延迟 +${fmtNum(adj.from)}s → +${fmtNum(adj.to)}s（增加 ${fmtNum(adj.delta)}s）`;
    meta.textContent =
      `「${t.name}」（${deferPlan.channel}）顺推到最早完整空位：` +
      `${fmtNum(t.oldStart)}s – ${fmtNum(t.oldEnd)}s → ${fmtNum(t.newStart)}s – ${fmtNum(t.newEnd)}s` +
      `｜${how}｜被顺延 ${deferPlan.moved.length} 条` +
      `｜新增冲突 ${deferPlan.conflictsAdded.length} 处｜消失冲突 ${deferPlan.conflictsRemoved.length} 处` +
      (deferStale ? '｜⚠️ 提示单已变更，预演失效' : '｜确认后才会写入');
  }

  const tbody = $('#deferTbody');
  tbody.innerHTML = '';
  for (const m of deferPlan.moved) {
    const tr = el('tr');
    tr.append(el('td', 'name-cell', m.name));
    tr.append(el('td', null, m.channel));
    tr.append(el('td', 'num', fmtNum(m.oldStart)));
    tr.append(el('td', 'num', fmtNum(m.oldEnd)));
    tr.append(el('td', 'num', fmtNum(m.newStart)));
    tr.append(el('td', 'num', fmtNum(m.newEnd)));
    const noteTd = el('td');
    noteTd.append(el('span', m.isTarget ? 'pill ok' : 'pill unknown',
      m.isTarget ? '目标提示（顺推）' : '后继随调度器重算'));
    tr.append(noteTd);
    tbody.append(tr);
  }

  const addedPanel = $('#deferAddedPanel');
  addedPanel.hidden = !deferPlan.conflictsAdded.length;
  deferConflictItems($('#deferAddedList'), deferPlan.conflictsAdded);

  const removedPanel = $('#deferRemovedPanel');
  removedPanel.hidden = !deferPlan.conflictsRemoved.length;
  deferConflictItems($('#deferRemovedList'), deferPlan.conflictsRemoved);

  $('#deferConfirmBtn').disabled = deferStale || !deferPlan.changed;
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function previewDeferral(cueId) {
  try {
    deferPlan = await api('POST', '/api/deferrals/preview', { cueId });
    deferStale = false;
    renderDefer();
  } catch (err) {
    deferPlan = null;
    showDeferError(err.errors || [err.message]);
  }
}

async function confirmDeferral() {
  if (!deferPlan || deferStale || !deferPlan.changed) return;
  const btn = $('#deferConfirmBtn');
  btn.disabled = true;
  try {
    await api('POST', '/api/deferrals/confirm', {
      cueId: deferPlan.cueId,
      baseVersion: deferPlan.baseVersion,
    });
    clearDefer();
    await reload('已顺延并保存，后继提示已重算');
  } catch (err) {
    if (err.status === 409) {
      // 版本不一致：预演所依据的提示单已变化，要求重新预演
      deferStale = true;
      $('#deferConfirmBtn').disabled = true;
      const meta = $('#deferMeta');
      meta.classList.add('stale');
      meta.textContent = '提示单在预演后已变化，本次确认被拒绝，请重新从冲突面板发起预演。';
      showBanner('提示单已变化，预演失效，请重新预演', 'err');
    } else {
      showBanner(err.errors.join('\n') || err.message, 'err');
      btn.disabled = false;
    }
  }
}

// ---------------- 多通道共同空档查询（只读） ----------------
function showGapError(messages) {
  const box = $('#gapError');
  box.className = 'banner err';
  box.innerHTML = '';
  box.append(el('strong', null, '无法查询共同空档：'));
  const ul = el('ul');
  ul.style.margin = '6px 0 0';
  ul.style.paddingLeft = '18px';
  for (const m of [].concat(messages)) ul.append(el('li', null, m));
  box.append(ul);
  box.classList.remove('hidden');
}
function hideGapError() {
  $('#gapError').classList.add('hidden');
}

// 通道勾选列表：随提示单刷新；保留仍存在的勾选，首次渲染默认全选
function renderGapChannels() {
  const box = $('#gapChannelList');
  const channels = [...new Set(state.cues.map((c) => c.channel))].sort((a, b) => a.localeCompare(b));
  if (gapChecked === null) gapChecked = new Set(channels);
  for (const name of [...gapChecked]) {
    if (!channels.includes(name)) gapChecked.delete(name); // 通道已随提示删除而消失
  }
  box.innerHTML = '';
  if (!channels.length) {
    box.append(el('span', 'rel-muted', '暂无通道：请先在下方新增提示'));
    return;
  }
  for (const name of channels) {
    const lab = el('label', 'gap-channel');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = gapChecked.has(name);
    cb.addEventListener('change', () => {
      if (cb.checked) gapChecked.add(name);
      else gapChecked.delete(name);
    });
    lab.append(cb, el('span', null, name));
    box.append(lab);
  }
}

function markGapStale() {
  if (!gapResult) return;
  gapStale = true;
  const meta = $('#gapMeta');
  if (meta) {
    meta.className = 'frag-meta stale';
    meta.textContent = '提示单已变更，以下结果基于旧计划，请重新查询以使用新计划。';
  }
}

function renderGaps() {
  const box = $('#gapResult');
  if (!gapResult) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const meta = $('#gapMeta');
  meta.className = 'frag-meta' + (gapStale ? ' stale' : ' ok');
  meta.textContent =
    `查询时段 [${fmtNum(gapResult.window.start)}, ${fmtNum(gapResult.window.end)})` +
    `｜通道 ${gapResult.channels.map((n) => `「${n}」`).join('、')}` +
    `｜所需连续 ${fmtNum(gapResult.minSeconds)}s` +
    `｜占用并集 ${gapResult.busy.length} 段` +
    `｜可用共同空档 ${gapResult.gaps.length} 段` +
    (gapStale ? '｜⚠️ 提示单已变更，结果基于旧计划，请重新查询' : '');

  const empty = $('#gapEmpty');
  const wrap = $('#gapTableWrap');
  const tbody = $('#gapTbody');
  tbody.innerHTML = '';
  if (!gapResult.gaps.length) {
    // 无可用窗口：空态
    empty.hidden = false;
    wrap.hidden = true;
  } else {
    empty.hidden = true;
    wrap.hidden = false;
    gapResult.gaps.forEach((g, i) => {
      const tr = el('tr');
      tr.append(el('td', 'num', String(i + 1)));
      tr.append(el('td', 'num', fmtNum(g.start)));
      tr.append(el('td', 'num', fmtNum(g.end)));
      tr.append(el('td', 'num', fmtNum(g.duration)));
      const rangeTd = el('td', 'num');
      rangeTd.textContent = `${fmtNum(g.earliestStart)} – ${fmtNum(g.latestStart)}`;
      rangeTd.title = `在该空档内，开始时刻可取 [${fmtNum(g.earliestStart)}, ${fmtNum(g.latestStart)}] 内任意秒数`;
      tr.append(rangeTd);
      tbody.append(tr);
    });
  }

  const busyPanel = $('#gapBusyPanel');
  const busyList = $('#gapBusyList');
  busyList.innerHTML = '';
  if (!gapResult.busy.length) {
    busyPanel.hidden = true;
  } else {
    busyPanel.hidden = false;
    for (const iv of gapResult.busy) {
      const li = el('li');
      li.append(el('span', 'tag tag-busy', '占用'));
      li.append(document.createTextNode(`${fmtNum(iv.start)}s – ${fmtNum(iv.end)}s（左闭右开）`));
      busyList.append(li);
    }
  }
}

async function queryGaps(e) {
  e.preventDefault();
  if (!gapChecked || !gapChecked.size) {
    gapResult = null;
    $('#gapResult').hidden = true;
    showGapError(['请至少勾选一个现有通道再查询']);
    return;
  }
  const body = {
    channels: [...gapChecked],
    start: $('#gap-start').value,
    end: $('#gap-end').value,
    minSeconds: $('#gap-min').value,
  };
  const btn = $('#gapQueryBtn');
  btn.disabled = true;
  try {
    gapResult = await api('POST', '/api/gaps/query', body);
    gapStale = false;
    hideGapError();
    renderGaps();
  } catch (err) {
    gapResult = null;
    $('#gapResult').hidden = true;
    showGapError(err.errors || [err.message]);
  } finally {
    btn.disabled = false;
  }
}

// ---------------- 实况排练台 ----------------
function showRehError(messages) {
  const box = $('#rehError');
  box.className = 'banner err';
  box.innerHTML = '';
  box.append(el('strong', null, '排练操作被拒绝：'));
  const ul = el('ul');
  ul.style.margin = '6px 0 0';
  ul.style.paddingLeft = '18px';
  for (const m of [].concat(messages)) ul.append(el('li', null, m));
  box.append(ul);
  box.classList.remove('hidden');
}
function hideRehError() {
  $('#rehError').classList.add('hidden');
}

function rehClock() {
  const raw = $('#rehClock').value;
  if (raw === null || String(raw).trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function rehRecOf(cueId) {
  const rec = rehearsal && rehearsal.records ? rehearsal.records[cueId] : null;
  return {
    actualStart: rec && rec.actualStart !== undefined ? rec.actualStart : null,
    actualEnd: rec && rec.actualEnd !== undefined ? rec.actualEnd : null,
  };
}
function rehCue(id) {
  return rehearsal.cues.find((c) => c.id === id);
}

// 与服务端 checkStart 一致的本地预判，用于随演出秒数实时展示阻止原因（服务端仍会权威校验）
function rehStartReasons(cueId, at) {
  const cue = rehCue(cueId);
  if (!cue) return ['提示不在本次排练中'];
  const reasons = [];
  const rec = rehRecOf(cueId);
  if (rec.actualStart !== null) {
    reasons.push(rec.actualEnd !== null ? '该提示已完成' : '该提示已在进行中');
  }
  if (cue.startType === 'after') {
    const pred = rehCue(cue.afterCueId);
    const predRec = rehRecOf(cue.afterCueId);
    if (predRec.actualEnd === null) {
      reasons.push(`前置提示${pred ? `「${pred.name}」` : ''}尚未登记实际结束`);
    } else {
      const earliest = predRec.actualEnd + cue.delayAfter;
      if (at < earliest - 1e-9) {
        reasons.push(`未达到前置实际结束 +${fmtNum(cue.delayAfter)}s 延迟（最早可于 ${fmtNum(earliest)}s 开始）`);
      }
    }
  } else if (at < cue.fixedAt - 1e-9) {
    reasons.push(`未达到固定开始秒数（第 ${fmtNum(cue.fixedAt)}s）`);
  }
  let busyName = null;
  let lastEnd = null;
  for (const o of rehearsal.cues) {
    if (o.id === cueId || o.channel !== cue.channel) continue;
    const r = rehRecOf(o.id);
    if (r.actualStart !== null && r.actualEnd === null) busyName = o.name;
    if (r.actualEnd !== null && (lastEnd === null || r.actualEnd > lastEnd)) lastEnd = r.actualEnd;
  }
  if (busyName !== null) reasons.push(`通道「${cue.channel}」上「${busyName}」正在进行中`);
  if (lastEnd !== null && at < lastEnd - 1e-9) {
    reasons.push(`早于本通道最后一次实际结束（${fmtNum(lastEnd)}s）`);
  }
  return reasons;
}

function rehEndReasons(cueId, at) {
  const rec = rehRecOf(cueId);
  if (rec.actualStart === null) return ['该提示尚未登记实际开始'];
  if (rec.actualEnd !== null) return ['该提示已登记实际结束'];
  if (at < rec.actualStart - 1e-9) {
    return [`结束秒数（${fmtNum(at)}s）不得早于实际开始（${fmtNum(rec.actualStart)}s）`];
  }
  return [];
}

const REH_STATUS = {
  pending: { cls: 'unknown', text: '未开始' },
  running: { cls: 'run', text: '进行中' },
  done: { cls: 'ok', text: '已完成' },
};

function deltaCell(d) {
  const td = el('td', 'num');
  if (d === null || d === undefined) {
    td.textContent = '—';
    return td;
  }
  const span = el('span');
  if (d > 1e-9) {
    span.className = 'delta-late';
    span.textContent = `+${fmtNum(d)}s`;
    span.title = `实际比计划晚 ${fmtNum(d)}s`;
  } else if (d < -1e-9) {
    span.className = 'delta-early';
    span.textContent = `-${fmtNum(-d)}s`;
    span.title = `实际比计划早 ${fmtNum(-d)}s`;
  } else {
    span.className = 'delta-zero';
    span.textContent = '0s';
    span.title = '与计划一致';
  }
  td.append(span);
  return td;
}

// 实际开始/结束单元格：已登记的值可点击 ✏️ 勘误为非负秒数；未登记显示 —（不能借此补录）
function rehActualCell(it, field) {
  const td = el('td', 'num');
  const value = field === 'start' ? it.actualStart : it.actualEnd;
  if (value === null) {
    td.textContent = '—';
    return td;
  }

  if (rehEditing && rehEditing.cueId === it.cueId && rehEditing.field === field) {
    const input = el('input', 'reh-edit-input');
    input.type = 'number';
    input.min = '0';
    input.step = '0.1';
    input.value = rehEditing.draft;
    const okBtn = el('button', 'btn small primary', '✓');
    okBtn.type = 'button';
    okBtn.title = '确认勘误（服务端将基于冻结提示单与全部当前记录重新校验）';
    const cancelBtn = el('button', 'btn small ghost', '✕');
    cancelBtn.type = 'button';
    cancelBtn.title = '取消勘误';
    const submit = () => correctRehearsalRecord(it.cueId, field, input.value);
    okBtn.addEventListener('click', submit);
    // 时钟输入等触发的重渲染会重建本输入框，实时同步草稿避免丢失已输入内容
    input.addEventListener('input', () => {
      if (rehEditing) rehEditing.draft = input.value;
    });
    cancelBtn.addEventListener('click', () => {
      rehEditing = null;
      renderRehearsal();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape') {
        rehEditing = null;
        renderRehearsal();
      }
    });
    td.append(input, okBtn, cancelBtn);
    setTimeout(() => input.focus(), 0);
    return td;
  }

  td.append(el('span', null, fmtNum(value)));
  const editBtn = el('button', 'btn small ghost reh-edit-btn', '✏️');
  editBtn.type = 'button';
  editBtn.title = `勘误实际${field === 'start' ? '开始' : '结束'}秒数（仅已登记字段可改，不能补录或清空）`;
  editBtn.addEventListener('click', () => {
    rehEditing = { cueId: it.cueId, field, draft: fmtNum(value) };
    renderRehearsal();
  });
  td.append(editBtn);
  return td;
}

function renderRehearsal() {
  const idle = $('#rehIdle');
  const active = $('#rehActive');
  if (!rehearsal) {
    rehEditing = null;
    clearUndo();
    idle.hidden = false;
    active.hidden = true;
    renderDeviation(); // 无排练：拆解区显示空态
    return;
  }
  idle.hidden = true;
  active.hidden = false;

  // 排练视图刷新后核对撤回预演所依据的排练记录版本，已变化则标记失效
  if (undoPlan && rehearsal.recordsVersion !== undoPlan.baseVersion) markUndoStale();

  const c = rehearsal.counts;
  $('#rehMeta').textContent =
    `排练 ${rehearsal.id} ｜ 开始于 ${new Date(rehearsal.startedAt).toLocaleString()}` +
    ` ｜ 冻结 ${c.total} 条提示 ｜ ✅ 已完成 ${c.done} ｜ ▶ 进行中 ${c.running} ｜ ⏳ 未开始 ${c.pending}`;

  const at = rehClock();
  const tbody = $('#rehTbody');
  tbody.innerHTML = '';

  rehearsal.items.forEach((it, i) => {
    const tr = el('tr');
    if (it.status === 'running') tr.classList.add('row-running');
    if (it.status === 'done') tr.classList.add('row-done');

    tr.append(el('td', 'num', String(i + 1)));
    tr.append(el('td', 'name-cell', it.name));
    tr.append(el('td', null, it.channel));
    tr.append(el('td', 'num', fmtNum(it.plannedStart)));
    tr.append(el('td', 'num', fmtNum(it.plannedEnd)));
    tr.append(rehActualCell(it, 'start'));
    tr.append(rehActualCell(it, 'end'));
    tr.append(deltaCell(it.startDelta));
    tr.append(deltaCell(it.endDelta));

    const st = REH_STATUS[it.status];
    const statusTd = el('td');
    statusTd.append(el('span', `pill ${st.cls}`, st.text));
    tr.append(statusTd);

    const actTd = el('td');
    if (it.status === 'done') {
      const undoBtn = el('button', 'btn small danger', '↩️ 撤回结束');
      undoBtn.type = 'button';
      undoBtn.title =
        '预演撤回该提示的实际结束登记：目标改回进行中，因前置实际结束缺失或与目标开放的通道占用重叠而失效的登记将整条清除（确认前不写入）';
      undoBtn.addEventListener('click', () => previewUndoEnd(it.cueId));
      actTd.append(undoBtn);
    } else {
      const kind = it.status === 'pending' ? 'start' : 'end';
      const reasons = at === null
        ? ['请先在上方填写当前演出秒数（非负数字）']
        : kind === 'start'
          ? rehStartReasons(it.cueId, at)
          : rehEndReasons(it.cueId, at);
      const btn = el('button', 'btn small primary', kind === 'start' ? '登记开始' : '登记结束');
      btn.type = 'button';
      btn.disabled = reasons.length > 0;
      btn.title = `以第 ${at === null ? '?' : fmtNum(at)}s 登记实际${kind === 'start' ? '开始' : '结束'}`;
      btn.addEventListener('click', () => rehearsalRecord(kind, it.cueId));
      actTd.append(btn);
      if (reasons.length) {
        const ul = el('ul', 'reh-reasons');
        for (const r of reasons) ul.append(el('li', null, r));
        actTd.append(ul);
      }
    }
    tr.append(actTd);
    tbody.append(tr);
  });

  renderDeviation();
}

// ---------------- 起点偏差拆解（只读，数据来自服务端 rehearsal.breakdown） ----------------
function fmtSigned(n) {
  if (n === null || n === undefined) return '—';
  if (n > 1e-9) return `+${fmtNum(n)}`;
  if (n < -1e-9) return `-${fmtNum(-n)}`;
  return '0';
}

// 带正负着色的秒数单元格（晚=红、早=蓝、零=灰）
function devDeltaCell(d) {
  const td = el('td', 'num');
  if (d === null || d === undefined) {
    td.textContent = '—';
    return td;
  }
  const span = el('span');
  if (d > 1e-9) span.className = 'delta-late';
  else if (d < -1e-9) span.className = 'delta-early';
  else span.className = 'delta-zero';
  span.textContent = `${fmtSigned(d)}s`;
  td.append(span);
  return td;
}

// 单条达到 R 的约束的展示文本（含相关提示）
function devConstraintText(c) {
  if (c.kind === 'fixed') {
    return `固定开始第 ${fmtNum(c.value)}s`;
  }
  if (c.kind === 'predecessor') {
    const name = c.cueName || `（${c.cueId}）`;
    return `前置「${name}」实际结束 ${fmtNum(c.actualEnd)}s ＋ 延迟 ${fmtNum(c.delayAfter)}s` +
      `（相关提示：${name}）`;
  }
  // channel
  if (!c.cues || !c.cues.length) {
    return `同通道无实际结束不晚于 A 的其他提示（计 ${fmtNum(c.value)}s）`;
  }
  const names = c.cues.map((x) => `「${x.name}」`).join('、');
  return `同通道 ${names} 实际结束 ${fmtNum(c.value)}s` +
    `（相关提示：${c.cues.map((x) => x.name).join('、')}）`;
}

function renderDeviation() {
  const empty = $('#devEmpty');
  const none = $('#devNone');
  const wrap = $('#devTableWrap');
  const tbody = $('#devTbody');
  tbody.innerHTML = '';

  const items = rehearsal && rehearsal.breakdown ? rehearsal.breakdown : null;
  if (!items) {
    // 无排练：空态
    empty.hidden = false;
    none.hidden = true;
    wrap.hidden = true;
    return;
  }
  empty.hidden = true;

  const nameOf = new Map(rehearsal.items.map((it) => [it.cueId, it.name]));
  const analyzed = items.filter((d) => d.analyzed);
  none.hidden = analyzed.length > 0; // 有排练但全部未开始时的提示
  wrap.hidden = false;

  items.forEach((d, i) => {
    const tr = el('tr');
    tr.append(el('td', 'num', String(i + 1)));
    tr.append(el('td', 'name-cell', nameOf.get(d.cueId) || d.cueId));

    if (!d.analyzed) {
      // 未开始提示：标为未分析
      const td = el('td');
      td.colSpan = 7;
      td.append(el('span', 'pill unknown', '未分析（尚未登记实际开始）'));
      tr.append(td);
      tbody.append(tr);
      return;
    }

    tr.append(el('td', 'num', fmtNum(d.plannedStart)));
    tr.append(el('td', 'num', fmtNum(d.actualStart)));
    tr.append(el('td', 'num', fmtNum(d.releaseAt)));
    tr.append(devDeltaCell(d.shift));
    tr.append(devDeltaCell(d.wait));
    tr.append(devDeltaCell(d.total));

    // 达到 R 的约束（可能起点 / 通道并列）及相关提示 + 分解等式
    const cTd = el('td');
    const ul = el('ul', 'dev-constraints');
    for (const c of d.constraints) {
      const li = el('li');
      li.append(
        el(
          'span',
          c.kind === 'channel' ? 'tag dev-tag-channel' : 'tag dev-tag-origin',
          c.kind === 'channel' ? '通道约束' : '起点约束'
        )
      );
      li.append(document.createTextNode(devConstraintText(c)));
      ul.append(li);
    }
    cTd.append(ul);
    cTd.append(
      el(
        'div',
        'dev-eq',
        `分解：位移 ${fmtSigned(d.shift)}s ＋ 等待 ${fmtSigned(d.wait)}s ＝ 总偏差 ${fmtSigned(d.total)}s`
      )
    );
    tr.append(cTd);
    tbody.append(tr);
  });
}

async function startRehearsal() {
  const btn = $('#rehStartBtn');
  btn.disabled = true;
  try {
    const data = await api('POST', '/api/rehearsal/start');
    rehearsal = data.rehearsal;
    rehEditing = null;
    hideRehError();
    renderRehearsal();
    showBanner('已开始排练：当前提示单与重算计划已冻结', 'ok');
  } catch (err) {
    showRehError(err.errors || [err.message]);
  } finally {
    btn.disabled = false;
  }
}

async function rehearsalRecord(kind, cueId) {
  const at = rehClock();
  if (at === null) {
    showRehError(['请先在「当前演出秒数」填写非负数字']);
    return;
  }
  try {
    const data = await api('POST', `/api/rehearsal/records/${kind}`, { cueId, at });
    rehearsal = data.rehearsal;
    rehEditing = null; // 记录已变化，进行中的勘误草稿作废
    hideRehError();
    renderRehearsal();
    showBanner(kind === 'start' ? '已登记实际开始' : '已登记实际结束', 'ok');
  } catch (err) {
    showRehError(err.errors || [err.message]);
    // 可能被服务端权威校验拒绝（状态已变化），重新拉取最新排练视图
    try {
      const fresh = await api('GET', '/api/rehearsal');
      rehearsal = fresh.rehearsal;
      renderRehearsal();
    } catch (_) { /* 忽略刷新失败 */ }
  }
}

// 提交勘误：已登记的实际开始/结束改为非负秒数；服务端基于冻结提示单与全部当前记录整体重校验
async function correctRehearsalRecord(cueId, field, rawValue) {
  const n = String(rawValue).trim() === '' ? NaN : Number(rawValue);
  if (!Number.isFinite(n) || n < 0) {
    rehEditing = { cueId, field, draft: String(rawValue) };
    showRehError(['勘误秒数必须是非负数字：已登记字段不能清空，也不能改为负数']);
    renderRehearsal();
    return;
  }
  try {
    const data = await api('POST', '/api/rehearsal/records/correct', { cueId, field, value: n });
    rehearsal = data.rehearsal;
    rehEditing = null;
    hideRehError();
    renderRehearsal();
    showBanner('已勘误登记时间，排练视图已刷新', 'ok');
  } catch (err) {
    // 保留输入草稿便于修改后重试；同时拉取最新排练视图（记录可能已被他处改变）
    rehEditing = { cueId, field, draft: String(rawValue) };
    showRehError(err.errors || [err.message]);
    try {
      const fresh = await api('GET', '/api/rehearsal');
      rehearsal = fresh.rehearsal;
    } catch (_) { /* 忽略刷新失败 */ }
    renderRehearsal();
  }
}

async function resetRehearsal() {
  if (!confirm('确定重置本次排练？\n将清除全部实际登记记录并允许开启新一轮排练（原提示单不受影响）。')) return;
  try {
    await api('POST', '/api/rehearsal/reset');
    rehearsal = null;
    rehEditing = null;
    hideRehError();
    renderRehearsal();
    showBanner('已重置，可开始新一轮排练', 'ok');
  } catch (err) {
    showRehError(err.errors || [err.message]);
  }
}

// ---------------- 撤回结束登记（预演只读；确认时服务端核对排练记录版本并重算） ----------------
function clearUndo() {
  undoPlan = null;
  undoStale = false;
  $('#undoPanel').hidden = true;
  $('#undoResult').hidden = true;
}

function markUndoStale() {
  if (!undoPlan || undoStale) return;
  undoStale = true;
  $('#undoConfirmBtn').disabled = true;
  const meta = $('#undoMeta');
  if (meta) {
    meta.classList.add('stale');
    meta.textContent = '排练登记已变更，本预演已失效，请重新从列表发起「撤回结束」预演。';
  }
}

function renderUndo() {
  const panel = $('#undoPanel');
  panel.hidden = false;
  $('#undoResult').hidden = false;

  const t = undoPlan.target;
  const meta = $('#undoMeta');
  meta.className = 'frag-meta' + (undoStale ? ' stale' : ' ok');
  meta.textContent =
    `「${undoPlan.name}」（${undoPlan.channel}）撤回实际结束 ${fmtNum(t.revokedEnd)}s → 改回进行中` +
    `（通道自实际开始 ${fmtNum(t.actualStart)}s 起开放占用）` +
    `｜连带清除登记 ${undoPlan.cleared.length} 条` +
    (undoStale ? '｜⚠️ 排练登记已变更，预演失效' : '｜确认后才会写入');

  $('#undoClearedTitle').textContent = undoPlan.cleared.length
    ? `将被整条清除的登记（${undoPlan.cleared.length} 条，按传播轮次列出）`
    : '将被整条清除的登记';
  $('#undoNone').hidden = undoPlan.cleared.length > 0;
  $('#undoTableWrap').hidden = undoPlan.cleared.length === 0;

  const tbody = $('#undoTbody');
  tbody.innerHTML = '';
  undoPlan.cleared.forEach((cl, i) => {
    const tr = el('tr');
    tr.append(el('td', 'num', String(i + 1)));
    tr.append(el('td', 'name-cell', cl.name));
    tr.append(el('td', null, cl.channel));
    tr.append(el('td', 'num', fmtNum(cl.actualStart)));
    tr.append(el('td', 'num', fmtNum(cl.actualEnd)));
    tr.append(el('td', 'num', `第 ${cl.round} 轮`));
    const reasonTd = el('td', 'undo-reason');
    const ul = el('ul', 'undo-reasons');
    for (const r of cl.reasons) ul.append(el('li', null, r));
    reasonTd.append(ul);
    tr.append(reasonTd);
    tbody.append(tr);
  });

  $('#undoConfirmBtn').disabled = undoStale;
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function previewUndoEnd(cueId) {
  try {
    undoPlan = await api('POST', '/api/rehearsal/undo-end/preview', { cueId });
    undoStale = false;
    hideRehError();
    renderUndo();
  } catch (err) {
    clearUndo();
    showRehError(err.errors || [err.message]);
  }
}

async function confirmUndoEnd() {
  if (!undoPlan || undoStale) return;
  const btn = $('#undoConfirmBtn');
  btn.disabled = true;
  try {
    const data = await api('POST', '/api/rehearsal/undo-end/confirm', {
      cueId: undoPlan.cueId,
      baseVersion: undoPlan.baseVersion,
    });
    rehearsal = data.rehearsal;
    rehEditing = null; // 记录已变化，进行中的勘误草稿作废
    clearUndo();
    hideRehError();
    renderRehearsal();
    showBanner(
      `已撤回结束登记：目标改回进行中，连带清除 ${data.applied.cleared.length} 条失效登记`,
      'ok'
    );
  } catch (err) {
    if (err.code === 'version_mismatch') {
      // 排练记录在预演后已变化：标记失效，要求重新预演
      undoStale = true;
      $('#undoConfirmBtn').disabled = true;
      const meta = $('#undoMeta');
      meta.classList.add('stale');
      meta.textContent = '排练登记在预演后已变化，本次确认被拒绝，请重新发起「撤回结束」预演。';
      showRehError(err.errors || [err.message]);
    } else {
      showRehError(err.errors || [err.message]);
      btn.disabled = false;
      // 状态可能已被他处改变（如目标已被撤回 / 排练已重置），重新拉取最新排练视图
      try {
        const fresh = await api('GET', '/api/rehearsal');
        rehearsal = fresh.rehearsal;
        renderRehearsal();
      } catch (_) { /* 忽略刷新失败 */ }
    }
  }
}

// ---------------- 初始化 ----------------
document.querySelectorAll('input[name="startType"]').forEach((r) =>
  r.addEventListener('change', syncStartBoxes)
);
$('#cueForm').addEventListener('submit', submitForm);
$('#cancelEdit').addEventListener('click', () => resetForm());
$('#fragmentForm').addEventListener('submit', previewFragment);
$('#frDownloadBtn').addEventListener('click', downloadFragment);
$('#gapForm').addEventListener('submit', queryGaps);
$('#deferConfirmBtn').addEventListener('click', confirmDeferral);
$('#deferCancelBtn').addEventListener('click', () => clearDefer());
$('#rehStartBtn').addEventListener('click', startRehearsal);
$('#rehResetBtn').addEventListener('click', resetRehearsal);
$('#undoConfirmBtn').addEventListener('click', confirmUndoEnd);
$('#undoCancelBtn').addEventListener('click', () => clearUndo());
$('#rehClock').addEventListener('input', () => {
  if (rehearsal) renderRehearsal();
});

syncStartBoxes();
reload().catch((err) => showBanner(`加载失败：${err.message}`, 'err', true));
