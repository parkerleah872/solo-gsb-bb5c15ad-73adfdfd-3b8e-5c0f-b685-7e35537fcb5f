'use strict';

/**
 * 多通道共同空档查询（只读）：
 * - 页面勾选一个或多个现有通道，给定查询时段 [起, 止)（左闭右开，秒）与所需连续秒数
 * - 基于当前重算计划，把所选通道上时间已定提示的占用裁剪到查询时段（正长度交集）
 * - 占用按左闭右开区间求并集：重叠或首尾相接都合并 —— 相邻占用不产生虚假空档，
 *   已有通道冲突同样只按占用处理
 * - 时段内并集的补集即最大共同空档；返回全部长度 ≥ 所需秒数的空档，
 *   以及每个空档的可用起点范围 [空档起, 空档止 − 所需秒数]
 * - 只读：不修改、不持久化任何数据；提示单增删改后再次查询即使用新计划
 */

const { round, evaluate } = require('./scheduler');

const EPS = 1e-9; // 与冲突检测一致的浮点容差

function httpError(status, message, errors) {
  const err = new Error(message);
  err.status = status;
  err.errors = errors || [message];
  return err;
}

const REASON_TEXT = {
  missing: '引用了不存在的前置提示',
  cycle: '处于循环依赖中',
  'dep-missing': '其前置引用了不存在的提示',
  'dep-cycle': '其前置处于循环依赖中',
};

function readSecond(raw, label, errors) {
  if (typeof raw === 'boolean' || raw === null || raw === undefined || String(raw).trim() === '') {
    errors.push(`${label}必须填写数字`);
    return null;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    errors.push(`${label}必须是数字`);
    return null;
  }
  if (n < 0) {
    errors.push(`${label}不能为负数`);
    return null;
  }
  return round(n);
}

/** 校验查询时段 [起, 止)：都是非负数字、止严格晚于起（正长度）；非法抛 400 */
function parseWindow(rawStart, rawEnd) {
  const errors = [];
  const start = readSecond(rawStart, '查询时段起点', errors);
  const end = readSecond(rawEnd, '查询时段止点', errors);
  if (errors.length) {
    throw httpError(400, `查询时段非法：${errors.join('；')}（需要左闭右开 [起, 止)）`, errors);
  }
  if (end < start - EPS) {
    throw httpError(400, '查询时段非法：止点不能早于起点（左闭右开 [起, 止)）', [
      '查询时段止点不能早于起点',
    ]);
  }
  if (end - start <= EPS) {
    throw httpError(400, '查询时段必须是正长度区间：止点必须严格晚于起点（左闭右开 [起, 止)）', [
      '查询时段必须为正长度区间（止 > 起）',
    ]);
  }
  return { start, end };
}

/** 校验所需连续秒数：必须是大于 0 的数字；非法抛 400 */
function parseMinSeconds(raw) {
  const errors = [];
  const n = readSecond(raw, '所需连续秒数', errors);
  if (errors.length) {
    throw httpError(400, `所需连续秒数非法：${errors.join('；')}`, errors);
  }
  if (n <= EPS) {
    throw httpError(400, '所需连续秒数必须大于 0', ['所需连续秒数必须大于 0']);
  }
  return n;
}

/** 校验所选通道：至少一个、且都必须存在于当前提示单；非法抛 400 */
function parseChannels(raw, cues) {
  const list = Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw];
  const names = [];
  for (const item of list) {
    if (typeof item !== 'string' || !item.trim()) continue;
    const name = item.trim();
    if (!names.includes(name)) names.push(name);
  }
  if (!names.length) {
    throw httpError(400, '请至少选择一个现有通道再查询', ['未选择任何通道']);
  }
  const existing = new Set(cues.map((c) => c.channel));
  const unknown = names.filter((n) => !existing.has(n));
  if (unknown.length) {
    throw httpError(
      400,
      `所选通道在当前提示单中不存在：${unknown.map((n) => `「${n}」`).join('、')}，请刷新页面后重新选择`,
      unknown.map((n) => `通道「${n}」不存在`)
    );
  }
  return names;
}

/**
 * 查询多通道共同空档（只读，不修改传入的 cues）。
 * 返回 { window, channels, minSeconds, busy, gaps }：
 * - busy：所选通道占用裁剪到时段后的并集（按开始排序，首尾相接已合并）；
 * - gaps：长度足够的最大共同空档 [{ start, end, duration, earliestStart, latestStart }]，
 *   可用起点范围为 [earliestStart, latestStart]。
 * 任何非法输入抛带 status 的 Error。
 */
function findCommonGaps(cues, rawChannels, rawStart, rawEnd, rawMinSeconds) {
  const channels = parseChannels(rawChannels, cues);
  const win = parseWindow(rawStart, rawEnd);
  const minSeconds = parseMinSeconds(rawMinSeconds);

  // 基于当前重算计划；所选通道上时间未定的提示会让占用无法确定，明确拒绝
  const result = evaluate(cues);
  const times = new Map(result.schedule.map((s) => [s.id, s]));
  const selected = new Set(channels);
  const unresolved = [];
  for (const c of cues) {
    if (!selected.has(c.channel)) continue;
    const t = times.get(c.id);
    if (!t || t.start === null) {
      const reason = REASON_TEXT[t && t.reason] || '无法排期';
      unresolved.push(`通道「${c.channel}」的提示「${c.name}」时间未定（${reason}）`);
    }
  }
  if (unresolved.length) {
    throw httpError(
      400,
      '所选通道存在时间未定的提示，无法确定其占用，请先在提示单中解决引用或循环依赖问题',
      unresolved
    );
  }

  // 1) 裁剪：所选通道的占用与查询时段求正长度交集（端点相接不计入）
  const clipped = [];
  for (const c of cues) {
    if (!selected.has(c.channel)) continue;
    const t = times.get(c.id);
    const s = Math.max(t.start, win.start);
    const e = Math.min(t.end, win.end);
    if (s < e - EPS) clipped.push({ start: s, end: e });
  }

  // 2) 并集：按开始排序后合并重叠或首尾相接的左闭右开区间（冲突同样只算占用）
  clipped.sort((a, b) => a.start - b.start || a.end - b.end);
  const busy = [];
  for (const iv of clipped) {
    const last = busy[busy.length - 1];
    if (last && iv.start <= last.end + EPS) {
      if (iv.end > last.end) last.end = iv.end;
    } else {
      busy.push({ start: iv.start, end: iv.end });
    }
  }
  for (const iv of busy) {
    iv.start = round(iv.start);
    iv.end = round(iv.end);
  }

  // 3) 最大共同空档：时段内并集的补集（补集区间天然最大），再按所需秒数过滤
  const complements = [];
  let cursor = win.start;
  for (const iv of busy) {
    if (iv.start > cursor + EPS) complements.push({ start: cursor, end: iv.start });
    if (iv.end > cursor) cursor = iv.end;
  }
  if (win.end > cursor + EPS) complements.push({ start: cursor, end: win.end });

  const gaps = complements
    .filter((g) => g.end - g.start >= minSeconds - EPS)
    .map((g) => ({
      start: round(g.start),
      end: round(g.end),
      duration: round(g.end - g.start),
      // 可用起点范围：[空档起, 空档止 − 所需秒数]
      earliestStart: round(g.start),
      latestStart: round(g.end - minSeconds),
    }));

  return {
    window: { start: win.start, end: win.end },
    channels,
    minSeconds,
    busy,
    gaps,
  };
}

module.exports = { findCommonGaps };
