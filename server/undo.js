'use strict';

/**
 * 撤回结束登记（已完成提示 → 进行中）：
 * - 预演（只读）：先把目标提示改回进行中（仅撤回其实际结束，保留实际开始），
 *   再依据本次冻结提示单，反复清除因此失效的提示整条登记，直至剩余记录全部有效：
 *     1) 前置实际结束缺失：相对开始提示已登记实际开始，但其前置提示的实际结束
 *        被撤回或被清除（沿相对依赖逐轮传播）；
 *     2) 与目标开放的通道占用重叠：目标改回进行中后，其通道占用开放为 [实际开始, +∞)，
 *        同通道其他登记的实际区间与之重叠（左闭右开，首尾相接不算）。
 *   被清除的登记整条移除（实际开始与实际结束一并清除）；预演逐条列出被清除提示、
 *   传播轮次与原因，不写入任何数据。
 * - 确认：携带预演时的排练记录版本；服务端核对版本并重算同一计划，
 *   版本不一致则拒绝（需重新预演），一致才应用并原子保存。
 * - 只读写排练记录，不修改原提示单。
 */

const { validateRecords, recordsVersion } = require('./rehearsal');

const EPS = 1e-9; // 与冲突检测一致的浮点容差

function httpError(status, message, errors) {
  const err = new Error(message);
  err.status = status;
  err.errors = errors || [message];
  return err;
}

function recOf(rehearsal, cueId) {
  const rec = rehearsal.records[cueId];
  if (!rec) return { actualStart: null, actualEnd: null };
  return {
    actualStart: rec.actualStart === undefined ? null : rec.actualStart,
    actualEnd: rec.actualEnd === undefined ? null : rec.actualEnd,
  };
}

/**
 * 生成「撤回结束登记」预演计划（只读，不修改 rehearsal）。
 * 提示不在本次排练中抛 404；目标未完成（未登记实际结束）抛 409。
 * 返回 { cueId, name, channel, target, cleared, baseVersion }。
 */
function planUndoEnd(rehearsal, cueId) {
  const cue = rehearsal.cues.find((c) => c.id === cueId);
  if (!cue) {
    throw httpError(404, '该提示不在本次排练冻结的提示单中', [`提示 ${cueId} 不在本次排练中`]);
  }
  const rec = recOf(rehearsal, cueId);
  if (rec.actualEnd === null) {
    throw httpError(
      409,
      rec.actualStart === null
        ? `提示「${cue.name}」尚未登记实际开始与结束，无需撤回`
        : `提示「${cue.name}」仍在进行中、尚未登记实际结束，无需撤回`,
      ['仅已完成（已登记实际结束）的提示才能撤回结束登记']
    );
  }

  const nameOf = (id) => {
    const c = rehearsal.cues.find((x) => x.id === id);
    return c ? `「${c.name}」` : `（${id}）`;
  };

  // 候选记录：目标改回进行中（仅撤回其实际结束，保留实际开始）
  const candidate = {};
  for (const c of rehearsal.cues) candidate[c.id] = recOf(rehearsal, c.id);
  candidate[cueId] = { actualStart: rec.actualStart, actualEnd: null };

  // 目标开放的通道占用：[实际开始, +∞)
  const openStart = rec.actualStart;

  // 反复传播：每轮找出全部失效登记并整条清除，直至剩余记录有效。
  // 清除只会移除占用与实际结束，不会产生新的通道重叠，因此后续轮次只沿相对依赖传播。
  const cleared = [];
  let roundNo = 0;
  for (;;) {
    const invalid = [];
    for (const c of rehearsal.cues) {
      if (c.id === cueId) continue; // 目标本身只撤回结束，不清除整条登记
      const r = candidate[c.id];
      if (!r || r.actualStart === null) continue; // 无登记或已被清除
      const reasons = [];

      // 失效原因 1：前置实际结束缺失（被撤回或被清除）
      if (c.startType === 'after') {
        const pred = candidate[c.afterCueId];
        if (!pred || pred.actualEnd === null) {
          reasons.push(`前置${nameOf(c.afterCueId)}的实际结束缺失（已撤回或被清除），登记失效`);
        }
      }

      // 失效原因 2：与目标开放的通道占用重叠（左闭右开，首尾相接不算）
      if (c.channel === cue.channel) {
        const end = r.actualEnd === null ? Infinity : r.actualEnd;
        if (Math.max(r.actualStart, openStart) < end - EPS) {
          reasons.push(
            `与目标「${cue.name}」开放的通道占用重叠（通道「${cue.channel}」自 ${openStart}s 起进行中）`
          );
        }
      }

      if (reasons.length) invalid.push({ cue: c, rec: r, reasons });
    }
    if (!invalid.length) break;

    roundNo += 1;
    for (const it of invalid) {
      candidate[it.cue.id] = { actualStart: null, actualEnd: null }; // 整条清除
      cleared.push({
        cueId: it.cue.id,
        name: it.cue.name,
        channel: it.cue.channel,
        actualStart: it.rec.actualStart,
        actualEnd: it.rec.actualEnd,
        round: roundNo,
        reasons: it.reasons,
      });
    }
  }

  // 安全网：剩余记录必须全部有效（正常流程必然成立；不成立说明登记本身已失效）
  const problems = validateRecords(rehearsal, candidate);
  if (problems.length) {
    throw httpError(409, '当前登记记录本身已失效，无法预演撤回，请先勘误或重置排练', problems);
  }

  return {
    cueId,
    name: cue.name,
    channel: cue.channel,
    target: { actualStart: rec.actualStart, revokedEnd: rec.actualEnd },
    cleared,
    baseVersion: recordsVersion(rehearsal),
  };
}

module.exports = { planUndoEnd };
