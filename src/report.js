function fmtTime(sec) {
  const sign = sec < 0 ? '-' : '';
  const abs = Math.abs(sec);
  const m = Math.floor(abs / 60);
  const s = abs % 60;
  return `${sign}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const STATUS_TEXT = {
  ok: '✅ 可达',
  fail: '❌ 无法按时抵达',
  unreachable: '⛔ 区域不可达',
};

/** 将单个区段的实际路线渲染为带时刻与等待信息的行进链 */
function renderLegChain(seg) {
  let chain = `${fmtTime(seg.actualDepart !== undefined ? seg.actualDepart : seg.from.time)}「${seg.from.areaName}」`;
  for (const leg of seg.legs) {
    if (leg.waitSeconds > 0) chain += ` ⏱等待 ${leg.waitSeconds} 秒`;
    chain += ` —${leg.travelSeconds} 秒→ ${fmtTime(leg.arriveTime)}「${leg.toName}」`;
  }
  return chain;
}

/** 区段独立校验模式下的演员区段表 */
function renderClassicTable(lines, actor) {
  lines.push('| # | 起点 | 终点 | 可用时间 | 所需时间 | 最早到达 | 结论 | 实际路线 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const seg of actor.segments) {
    const from = `${seg.from.areaName}（${fmtTime(seg.from.time)}）`;
    const to = `${seg.to.areaName}（${fmtTime(seg.to.time)}）`;
    const available = `${seg.availableSeconds} 秒`;
    const required = seg.requiredSeconds === null ? '—' : `${seg.requiredSeconds} 秒`;
    const arrival = seg.arrivalTime === null ? '—' : fmtTime(seg.arrivalTime);
    let verdict = STATUS_TEXT[seg.status];
    if (seg.status === 'ok') verdict += `（余 ${seg.slackSeconds} 秒）`;
    if (seg.status === 'fail') verdict += `（缺 ${-seg.slackSeconds} 秒）`;
    const route = seg.path.length > 0 ? seg.path.join(' → ') : '—';
    lines.push(`| ${seg.index} | ${from} | ${to} | ${available} | ${required} | ${arrival} | ${verdict} | ${route} |`);
  }
}

/** 连续口令延误传导模式下的演员区段表（含计划/实际出发、继承延误、最终迟到） */
function renderPropagateTable(lines, actor) {
  lines.push('| # | 起点 | 终点 | 计划出发 | 实际出发 | 实际到达 | 继承延误 | 最终迟到 | 结论 | 实际路线 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const seg of actor.segments) {
    const dwellText = seg.from.dwell > 0 ? `，停留 ${seg.from.dwell} 秒` : '';
    const from = `${seg.from.areaName}（${fmtTime(seg.from.time)}${dwellText}）`;
    const to = `${seg.to.areaName}（${fmtTime(seg.to.time)}）`;
    const planned = fmtTime(seg.plannedDepart);
    const depart = fmtTime(seg.actualDepart);
    const arrival = seg.arrivalTime === null ? '—' : fmtTime(seg.arrivalTime);
    const inherited = seg.inheritedDelay > 0 ? `+${seg.inheritedDelay} 秒` : '—';
    const late = seg.lateness === null ? '—' : seg.lateness > 0 ? `迟到 ${seg.lateness} 秒` : '准时';
    let verdict = STATUS_TEXT[seg.status];
    if (seg.status === 'ok') verdict += `（余 ${seg.slackSeconds} 秒）`;
    if (seg.status === 'fail') verdict += `（缺 ${-seg.slackSeconds} 秒）`;
    const route = seg.path.length > 0 ? seg.path.join(' → ') : '—';
    lines.push(`| ${seg.index} | ${from} | ${to} | ${planned} | ${depart} | ${arrival} | ${inherited} | ${late} | ${verdict} | ${route} |`);
  }
}

/** 传导明细：逐段用文字说明延误如何产生、传导与被吸收 */
function renderPropagationDetails(lines, actor) {
  lines.push('**延误传导明细：**');
  lines.push('');
  for (const seg of actor.segments) {
    if (seg.status === 'unreachable') {
      lines.push(
        `- 区段 ${seg.index}：⛔ 「${seg.from.areaName}」→「${seg.to.areaName}」在连接图上不连通，` +
          `实际到达未知，后续区段自 ${fmtTime(seg.to.time)}（计划时刻）重新起算`
      );
      continue;
    }
    let text = `- 区段 ${seg.index}：${fmtTime(seg.actualDepart)} 自「${seg.from.areaName}」出发`;
    const departNotes = [];
    departNotes.push(`计划 ${fmtTime(seg.plannedDepart)}`);
    if (seg.from.dwell > 0) departNotes.push(`含停留 ${seg.from.dwell} 秒`);
    if (seg.inheritedDelay > 0) departNotes.push(`继承上段延误 ${seg.inheritedDelay} 秒`);
    text += `（${departNotes.join('，')}）`;
    text += `，${fmtTime(seg.arrivalTime)} 抵达「${seg.to.areaName}」`;
    if (seg.lateness > 0) {
      text += `，迟到 ${seg.lateness} 秒 → 传导至后续区段`;
    } else if (seg.inheritedDelay > 0) {
      text += `，间隔充足，吸收 ${seg.inheritedDelay} 秒延误，恢复准时`;
    } else {
      text += '，准时';
    }
    lines.push(text);
  }
  lines.push('');
}

/** 通道占用冲突明细：冲突时段、峰值人数与涉及演员（方向 / 占用区间） */
function renderConflictSection(lines, result) {
  const conflicts = result.conflicts || [];
  lines.push('## 通道占用冲突');
  lines.push('');
  if (conflicts.length === 0) {
    lines.push('未检测到通道占用冲突。（容量缺省为 1；占用区间按 [进入, 离开) 半开统计，首尾相接不算重叠，等待时间不占用通道）');
    lines.push('');
    return;
  }
  lines.push(`共检测出 ${conflicts.length} 起通道占用冲突（占用区间按 [进入, 离开) 半开统计，首尾相接不算重叠，等待时间不占用通道）：`);
  lines.push('');
  lines.push('| 编号 | 连接 | 容量 | 冲突时段 | 峰值人数 | 涉及演员（区段 / 方向 / 占用区间） |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const c of conflicts) {
    const occupants = c.occupants
      .map((o) => `${o.actorName}（区段 ${o.segmentIndex}，${o.fromName}→${o.toName}，${fmtTime(o.enter)}~${fmtTime(o.leave)}）`)
      .join('；');
    lines.push(`| C${c.id} | ${c.edgeName} | ${c.capacity} | ${fmtTime(c.start)} ~ ${fmtTime(c.end)} | ${c.peak} | ${occupants} |`);
  }
  lines.push('');
}

/** 将校验结果渲染为 Markdown 报告 */
function toMarkdown(result) {
  const propagate = result.mode === 'propagate';
  const lines = [];
  const s = result.summary;

  lines.push('# 舞台走位校验报告');
  lines.push('');
  lines.push(`生成时间：${new Date(result.generatedAt).toLocaleString('zh-CN', { hour12: false })}`);
  lines.push(`校验模式：${propagate ? '连续口令延误传导' : '区段独立校验'}`);
  lines.push('');
  lines.push('## 汇总');
  lines.push('');
  lines.push('| 指标 | 数值 |');
  lines.push('| --- | --- |');
  lines.push(`| 演员数 | ${s.actors} |`);
  lines.push(`| 校验区段数 | ${s.segments} |`);
  lines.push(`| ✅ 按时可达 | ${s.ok} |`);
  lines.push(`| ❌ 无法按时抵达 | ${s.failed} |`);
  lines.push(`| ⛔ 区域不可达 | ${s.unreachable} |`);
  lines.push(`| ⚠ 通道占用冲突 | ${s.conflicts ?? 0} |`);
  lines.push('');

  renderConflictSection(lines, result);

  for (const actor of result.actors) {
    lines.push(`## ${actor.actorName}`);
    lines.push('');
    if (actor.segments.length === 0) {
      lines.push(`（口令数 ${actor.cueCount}，不足两条，无需校验区段）`);
      lines.push('');
      continue;
    }
    if (propagate) {
      const finalText =
        actor.finalLateness > 0 ? `末条口令最终迟到 ${actor.finalLateness} 秒` : '末条口令准时（延误已全部吸收）';
      lines.push(`传导链末端状态：${finalText}`);
      lines.push('');
      renderPropagateTable(lines, actor);
    } else {
      renderClassicTable(lines, actor);
    }
    lines.push('');

    if (propagate) renderPropagationDetails(lines, actor);

    // 动态路线明细：逐边列出出发 / 到达时刻与等待位置、时长
    if (actor.segments.some((seg) => seg.legs && seg.legs.length > 0)) {
      lines.push('**路线明细（含封闭时段等待推演）：**');
      lines.push('');
      for (const seg of actor.segments) {
        if (seg.status === 'unreachable') {
          lines.push(`- 区段 ${seg.index}：⛔ 两区域在连接图上不连通，无可用路线`);
        } else if (!seg.legs || seg.legs.length === 0) {
          lines.push(`- 区段 ${seg.index}：起点即终点（${seg.from.areaName}），无需移动`);
        } else {
          const conflictNote =
            seg.conflicts && seg.conflicts.length > 0
              ? `；⚠ 涉及通道冲突 ${seg.conflicts.map((id) => `C${id}`).join('、')}`
              : '';
          lines.push(`- 区段 ${seg.index}：${renderLegChain(seg)}；最早到达 ${fmtTime(seg.arrivalTime)}${conflictNote}`);
        }
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

module.exports = { toMarkdown, fmtTime };
