'use strict';

/**
 * 已完成提示的「撤回结束登记」（预演只读；确认核对版本后原子保存）：
 * - 预演：把目标提示改回进行中（移除其实际结束，本通道占用变为自实际开始起的开放区间
 *   [实际开始, +∞)），再依据本次冻结提示单，整条清除因此失效的提示登记：
 *     1) 相对开始提示的「前置实际结束缺失」（前置的结束被撤回或其登记被清除）；
 *     2) 与目标开放的通道占用重叠（同通道、实际开始不早于目标实际开始的其他提示）。
 *   清除沿相对依赖反复传播（被清除提示的后继因前置实际结束缺失而失效），
 *   直至剩余记录全部有效；预演逐条列出被清除提示及原因，不落盘。
 * - 确认：携带预演时的排练记录版本（baseVersion），服务端重新核对，
 *   版本已变化则拒绝（HTTP 409）并要求重新预演；一致则重算同一计划、
 *   应用并原子保存（临时文件 + rename），刷新排练视图。
 * - 仅读写排练记录，不修改原提示单。
 */

const crypto = require('crypto');
const { round } = require('./scheduler');

const EPS = 1e-9; // 与调度 / 冲突检测一致的浮点容差

function httpError(status, message, errors, code) {
  const err = new Error(message);
  err.status = status;
  err.errors = errors || [message];
  if (code) err.code = code;
  return err;
}

/**
 * 排练记录版本：本次排练（冻结提示单 + 冻结计划 + 登记记录）全量内容的哈希。
 * 任何登记 / 勘误 / 撤回都会改变它；records 键排序后序列化，与键的插入顺序无关。
 */
function rehearsalVersion(rehearsal) {
  const records = {};
  for (const k of Object.keys(rehearsal.records || {}).sort()) {
    records[k] = rehearsal.records[k];
  }
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        id: rehearsal.id,
        cues: rehearsal.cues,
        schedule: rehearsal.schedule,
        records,
      })
    )
    .digest('hex');
}

function recOf(records, cueId) {
  const rec = records[cueId];
  if (!rec) return { actualStart: null, actualEnd: null };
  return {
    actualStart: rec.actualStart === undefined ? null : rec.actualStart,
    actualEnd: rec.actualEnd === undefined ? null : rec.actualEnd,
  };
}

/**
 * 按提示归集登记失效问题（与 rehearsal.js 的 validateRecords 同一套规则，
 * 但返回 Map：cueId → 该提示的失效原因列表，供逐条清除与说明）：
 *   1) 已登记结束不早于其实际开始（有结束却无开始同样失效）；
 *   2) 已登记开始满足 固定起点 / 前置实际结束 + 延迟（前置实际结束缺失即失效）；
 *   3) 同通道已开始区间互不重叠（进行中视为开放区间 [start, +∞)，首尾相接允许）。
 * exemptOverlapId（撤回目标）不参与规则 3：其开放占用本就是清除他条的依据，
 * 与目标重叠的另一方仍会被标记失效；目标自身的规则 1 / 2 仍照常检查。
 */
function collectInvalidities(rehearsal, recordsMap, exemptOverlapId) {
  const problems = new Map(); // cueId → string[]
  const add = (id, reason) => {
    if (!problems.has(id)) problems.set(id, []);
    problems.get(id).push(reason);
  };
  const get = (id) => recordsMap[id] || { actualStart: null, actualEnd: null };
  const nameOf = (id) => {
    const c = rehearsal.cues.find((x) => x.id === id);
    return c ? `「${c.name}」` : `（${id}）`;
  };

  // 1) 结束不早于开始
  for (const c of rehearsal.cues) {
    const r = get(c.id);
    if (r.actualEnd === null) continue;
    if (r.actualStart === null) {
      add(c.id, `已登记实际结束（${r.actualEnd}s）但未登记实际开始`);
    } else if (r.actualEnd < r.actualStart - EPS) {
      add(c.id, `实际结束（${r.actualEnd}s）早于其实际开始（${r.actualStart}s）`);
    }
  }

  // 2) 开始满足固定起点 / 前置实际结束 + 延迟
  for (const c of rehearsal.cues) {
    const r = get(c.id);
    if (r.actualStart === null) continue;
    if (c.startType === 'after') {
      const predRec = get(c.afterCueId);
      if (predRec.actualEnd === null) {
        add(c.id, `前置${nameOf(c.afterCueId)}的实际结束缺失（其登记已撤回或被清除）`);
      } else {
        const earliest = round(predRec.actualEnd + c.delayAfter);
        if (r.actualStart < earliest - EPS) {
          add(
            c.id,
            `实际开始（${r.actualStart}s）早于前置${nameOf(c.afterCueId)}实际结束 ` +
              `+${round(c.delayAfter)}s 延迟（最早可于 ${earliest}s 开始）`
          );
        }
      }
    } else if (r.actualStart < c.fixedAt - EPS) {
      add(c.id, `实际开始（${r.actualStart}s）早于固定开始秒数（第 ${round(c.fixedAt)}s）`);
    }
  }

  // 3) 同通道已开始区间互不重叠（进行中视为开放区间，首尾相接允许）
  const byChannel = new Map();
  for (const c of rehearsal.cues) {
    const r = get(c.id);
    if (r.actualStart === null) continue;
    if (!byChannel.has(c.channel)) byChannel.set(c.channel, []);
    byChannel.get(c.channel).push({ cue: c, start: r.actualStart, end: r.actualEnd });
  }
  for (const [channel, items] of byChannel) {
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        const aEnd = a.end === null ? Infinity : a.end;
        const bEnd = b.end === null ? Infinity : b.end;
        // 左闭右开重叠：max(start) < min(end)；进行中（end 为 null）视为开放到 +∞
        if (Math.max(a.start, b.start) < Math.min(aEnd, bEnd) - EPS) {
          const fmt = (x) =>
            x.end === null
              ? `${nameOf(x.cue.id)}（进行中，自 ${x.start}s 起的开放占用）`
              : `${nameOf(x.cue.id)}（${x.start}s–${x.end}s）`;
          // 撤回目标免于重叠判定：其开放占用是清除另一方的依据，而非目标自身失效
          if (a.cue.id !== exemptOverlapId) {
            add(a.cue.id, `通道「${channel}」上与${fmt(b)}的实际区间重叠`);
          }
          if (b.cue.id !== exemptOverlapId) {
            add(b.cue.id, `通道「${channel}」上与${fmt(a)}的实际区间重叠`);
          }
        }
      }
    }
  }

  return problems;
}

/**
 * 生成「撤回结束登记」预演计划（只读，不修改传入的 rehearsal）。
 * 目标必须是已完成提示（已登记实际开始与实际结束），否则抛出 409（code: not_completed）；
 * 目标不在本次冻结提示单中抛出 404。
 * 返回 { cueId, name, channel, actualStart, withdrawnEnd, cleared, clearedCount,
 *        baseVersion, nextRecords }：
 *   - cleared：被整条清除的登记 [{ cueId, name, channel, actualStart, actualEnd, reasons }]；
 *   - nextRecords：应用撤回 + 清除后的完整登记记录（确认时直接使用；预演响应中不返回）。
 */
function planWithdrawal(rehearsal, cueId) {
  const cue = rehearsal.cues.find((c) => c.id === cueId);
  if (!cue) {
    throw httpError(404, '该提示不在本次排练冻结的提示单中', [`提示 ${cueId} 不在本次排练中`]);
  }
  const rec = recOf(rehearsal.records, cueId);
  if (rec.actualStart === null || rec.actualEnd === null) {
    const state = rec.actualStart === null ? '尚未登记实际开始' : '仍在进行中（未登记实际结束）';
    throw httpError(
      409,
      `「${cue.name}」${state}，不是已完成提示，不能撤回结束登记`,
      [`撤回结束登记仅适用于已完成（已登记实际开始与实际结束）的提示`,
       `「${cue.name}」${state}`],
      'not_completed'
    );
  }

  // 候选记录：目标改回进行中（移除实际结束，本通道占用变为开放区间）
  const candidate = {};
  for (const c of rehearsal.cues) candidate[c.id] = recOf(rehearsal.records, c.id);
  candidate[cueId] = { actualStart: rec.actualStart, actualEnd: null };

  // 反复传播：每轮把全部失效提示（目标除外）的整条登记清除，直至剩余记录有效。
  // 每轮至少清除一条，提示数量有限，必然收敛；目标自身的开始约束只依赖其上游，
  // 不受撤回与清除影响，不会失效（若失效说明现存记录本身不一致，直接报错）。
  const cleared = [];
  for (let guard = 0; ; guard++) {
    if (guard > rehearsal.cues.length) {
      throw httpError(500, '撤回预演未能在有限步内收敛，请重置排练后重试');
    }
    const problems = collectInvalidities(rehearsal, candidate, cueId);
    if (problems.has(cueId)) {
      throw httpError(
        409,
        '当前登记记录本身已失效（目标提示的开始约束不成立），无法预演撤回，请先勘误修正',
        problems.get(cueId)
      );
    }
    if (!problems.size) break;
    for (const [id, reasons] of problems) {
      const c = rehearsal.cues.find((x) => x.id === id);
      const r = candidate[id];
      cleared.push({
        cueId: id,
        name: c ? c.name : id,
        channel: c ? c.channel : null,
        actualStart: r.actualStart,
        actualEnd: r.actualEnd,
        reasons,
      });
      candidate[id] = { actualStart: null, actualEnd: null }; // 整条清除
    }
  }

  // 应用后的完整登记记录：仅保留有实际登记（开始或结束）的条目
  const nextRecords = {};
  for (const c of rehearsal.cues) {
    const r = candidate[c.id];
    if (r.actualStart !== null || r.actualEnd !== null) nextRecords[c.id] = r;
  }

  return {
    cueId,
    name: cue.name,
    channel: cue.channel,
    actualStart: rec.actualStart,
    withdrawnEnd: rec.actualEnd,
    cleared,
    clearedCount: cleared.length,
    baseVersion: rehearsalVersion(rehearsal),
    nextRecords,
  };
}

module.exports = { rehearsalVersion, planWithdrawal };
