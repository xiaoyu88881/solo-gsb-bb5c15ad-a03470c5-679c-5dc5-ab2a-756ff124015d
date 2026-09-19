const { earliestArrival } = require('./graph');

const MODES = ['classic', 'propagate'];

/** 口令停留时长（秒）：旧数据无该字段，按 0 处理 */
function dwellOf(cue) {
  const d = cue.dwell;
  return Number.isInteger(d) && d > 0 ? d : 0;
}

/** 通道容量（同时占用的最大人数）：旧数据无该字段，按 1 处理 */
function capacityOf(edge) {
  const c = edge.capacity;
  return Number.isInteger(c) && c >= 1 && c <= 10 ? c : 1;
}

/**
 * 通道占用冲突检测：
 * 汇总所有演员对同一无向连接的占用区间 [进入, 离开)（等待发生在区域内，不占用通道），
 * 任一时刻并发人数（按演员去重，同一名演员不会与自己构成冲突）超过连接容量时
 * 生成冲突事件；首尾恰好相接不算重叠，连续超载的区间合并为同一事件。
 *
 * @param {object} data 全量数据（区域 / 连接）
 * @param {Array} occupancies 占用记录：[{ edgeId, actorId, actorName, segmentIndex, fromName, toName, enter, leave }]
 * @returns {Array} 冲突事件：[{ id, edgeId, edgeName, capacity, start, end, peak, occupants }]
 */
function detectConflicts(data, occupancies) {
  const edgeById = new Map(data.edges.map((e) => [e.id, e]));
  const areaName = new Map(data.areas.map((a) => [a.id, a.name]));
  const byEdge = new Map();
  for (const o of occupancies) {
    if (!byEdge.has(o.edgeId)) byEdge.set(o.edgeId, []);
    byEdge.get(o.edgeId).push(o);
  }

  const conflicts = [];
  for (const [edgeId, list] of byEdge) {
    const edge = edgeById.get(edgeId);
    if (!edge) continue;
    const capacity = capacityOf(edge);
    // 扫描线事件：同一时刻先处理离开、再处理进入（半开区间，首尾相接不重叠）
    const events = [];
    for (const o of list) {
      events.push({ t: o.enter, d: 1, actorId: o.actorId });
      events.push({ t: o.leave, d: -1, actorId: o.actorId });
    }
    events.sort((x, y) => x.t - y.t || x.d - y.d);

    const active = new Map(); // actorId -> 进行中的占用次数（同一演员多段重叠仅计一人）
    let open = null; // 当前未闭合的超载区间 { start, peak }
    let lastT = null;
    for (let i = 0; i < events.length; ) {
      const t = events[i].t;
      while (i < events.length && events[i].t === t) {
        const ev = events[i];
        if (ev.d === 1) {
          active.set(ev.actorId, (active.get(ev.actorId) || 0) + 1);
        } else {
          const n = (active.get(ev.actorId) || 0) - 1;
          if (n > 0) active.set(ev.actorId, n);
          else active.delete(ev.actorId);
        }
        i++;
      }
      lastT = t;
      const concurrent = active.size;
      if (concurrent > capacity) {
        if (!open) open = { start: t, peak: concurrent };
        else if (concurrent > open.peak) open.peak = concurrent;
      } else if (open) {
        conflicts.push({ edgeId, capacity, start: open.start, end: t, peak: open.peak });
        open = null;
      }
    }
    if (open) conflicts.push({ edgeId, capacity, start: open.start, end: lastT, peak: open.peak });
  }

  // 补充冲突涉及演员（占用区间与冲突时段重叠者）与连接名称，按开始时刻排序编号
  const result = conflicts
    .map((c) => {
      const edge = edgeById.get(c.edgeId);
      const occupants = byEdge
        .get(c.edgeId)
        .filter((o) => o.enter < c.end && o.leave > c.start)
        .sort((x, y) => x.enter - y.enter || x.actorName.localeCompare(y.actorName, 'zh'))
        .map((o) => ({
          actorId: o.actorId,
          actorName: o.actorName,
          segmentIndex: o.segmentIndex,
          fromName: o.fromName,
          toName: o.toName,
          enter: o.enter,
          leave: o.leave,
        }));
      return {
        ...c,
        edgeName: `${areaName.get(edge.a) || edge.a} ↔ ${areaName.get(edge.b) || edge.b}`,
        occupants,
      };
    })
    .sort((x, y) => x.start - y.start || x.end - y.end || x.edgeName.localeCompare(y.edgeName, 'zh'));
  result.forEach((c, i) => {
    c.id = i + 1;
  });
  return result;
}

/**
 * 走位校验：
 * 对每位演员，将其到位口令按时间升序排列，逐段推演至下一口令区域，
 * 进入连接若与封闭时段重叠，则在区域等待或改走其他路径（复用 graph 的时间依赖 Dijkstra）。
 *
 * mode = 'classic'（区段独立校验）：
 *   每段从上一口令计划时刻出发，段与段互不影响；
 *   以最早到达时刻判定 按时 / 超时，图上不连通判定为 不可达。
 *
 * mode = 'propagate'（连续口令延误传导）：
 *   首条口令视为准时到位；从某条口令前往下一条时，
 *   出发时刻 = max(该条计划时刻, 实际到达该条的时刻) + 该条停留时长，
 *   某段迟到会传导给后续区段；后续间隔充足时可吸收延误、恢复准时。
 *   不可达区段无法计算实际到达，其后区段自下一口令计划时刻重新起算。
 */
function validate(data, mode = 'classic') {
  const propagate = mode === 'propagate';
  const areaName = new Map(data.areas.map((a) => [a.id, a.name]));
  const actors = [];
  let ok = 0;
  let failed = 0;
  let unreachable = 0;

  for (const actor of data.actors) {
    const cues = data.cues
      .filter((c) => c.actorId === actor.id && areaName.has(c.areaId))
      .slice()
      .sort((x, y) => x.time - y.time);

    const segments = [];
    // 传导模式：首条口令视为准时到位，之后逐段携带上一段的实际到达时刻
    let prevArrival = cues.length > 0 ? cues[0].time : 0;

    for (let i = 0; i + 1 < cues.length; i++) {
      const from = cues[i];
      const to = cues[i + 1];
      const dwell = propagate ? dwellOf(from) : 0;
      // 继承延误 = 到达本段起点口令时已经晚于计划的秒数
      const inheritedDelay = propagate ? Math.max(0, prevArrival - from.time) : 0;
      // 出发时刻取计划时刻与实际到达时刻的较晚值，再加停留时长
      const depart = propagate ? Math.max(from.time, prevArrival) + dwell : from.time;
      const plannedDepart = from.time + dwell;
      const available = to.time - depart;
      const ea = earliestArrival(data.edges, from.areaId, to.areaId, depart);

      let status;
      let required = null;
      let slack = null;
      let arrivalTime = null;
      let lateness = null;
      let routePath = [];
      let legs = [];
      let waits = [];

      if (!ea) {
        status = 'unreachable';
        unreachable++;
        // 实际到达未知：传导链自下一口令计划时刻重新起算
        if (propagate) prevArrival = to.time;
      } else {
        arrivalTime = ea.time;
        required = ea.time - depart; // 含途中等待的实际所需秒数
        slack = available - required;
        lateness = Math.max(0, ea.time - to.time); // 到达下一条口令时的最终迟到
        routePath = [from.areaId, ...ea.legs.map((l) => l.toId)].map((id) => areaName.get(id) || id);
        legs = ea.legs.map((l) => ({
          edgeId: l.edgeId,
          fromId: l.fromId,
          toId: l.toId,
          fromName: areaName.get(l.fromId) || l.fromId,
          toName: areaName.get(l.toId) || l.toId,
          departTime: l.depart,
          arriveTime: l.arrive,
          waitSeconds: l.wait,
          travelSeconds: l.arrive - l.depart,
        }));
        waits = legs
          .filter((l) => l.waitSeconds > 0)
          .map((l) => ({ areaName: l.fromName, seconds: l.waitSeconds }));
        if (ea.time <= to.time) {
          status = 'ok';
          ok++;
        } else {
          status = 'fail';
          failed++;
        }
        if (propagate) prevArrival = ea.time;
      }

      const segment = {
        index: i + 1,
        from: { time: from.time, areaName: areaName.get(from.areaId), note: from.note || '' },
        to: { time: to.time, areaName: areaName.get(to.areaId), note: to.note || '' },
        availableSeconds: available,
        requiredSeconds: required,
        slackSeconds: slack,
        arrivalTime,
        path: routePath,
        legs,
        waits,
        status,
        conflicts: [], // 关联的通道占用冲突编号，校验全部区段后统一回填
      };
      if (propagate) {
        segment.from.dwell = dwell;
        segment.to.dwell = dwellOf(to);
        segment.plannedDepart = plannedDepart; // 计划出发 = 计划时刻 + 停留时长
        segment.actualDepart = depart; // 实际出发（含继承延误）
        segment.inheritedDelay = inheritedDelay; // 从上一段继承的延误
        segment.lateness = lateness; // 到达终点口令时的最终迟到（不可达为 null）
      }
      segments.push(segment);
    }

    const actorResult = {
      actorId: actor.id,
      actorName: actor.name,
      cueCount: cues.length,
      segments,
    };
    if (propagate && cues.length > 0) {
      // 传导链末端（末条口令）的最终迟到；不可达区段后按计划时刻起算，迟到记 0
      actorResult.finalLateness = Math.max(0, prevArrival - cues[cues.length - 1].time);
    }
    actors.push(actorResult);
  }

  // 通道占用冲突：汇总全部演员对同一无向连接的占用区间 [进入, 离开)
  // （进入时刻为等待结束后的实际进入时刻，等待时间不占用通道；零耗时连接不占时间，直接忽略）
  const occupancies = [];
  for (const ar of actors) {
    for (const seg of ar.segments) {
      for (const leg of seg.legs) {
        if (leg.arriveTime > leg.departTime) {
          occupancies.push({
            edgeId: leg.edgeId,
            actorId: ar.actorId,
            actorName: ar.actorName,
            segmentIndex: seg.index,
            fromName: leg.fromName,
            toName: leg.toName,
            enter: leg.departTime,
            leave: leg.arriveTime,
            segment: seg, // 仅用于回填区段关联，不随结果序列化
          });
        }
      }
    }
  }
  const conflicts = detectConflicts(data, occupancies);
  // 结果区按区段标记关联冲突
  for (const c of conflicts) {
    for (const o of occupancies) {
      if (o.edgeId === c.edgeId && o.enter < c.end && o.leave > c.start) {
        o.segment.conflicts.push(c.id);
      }
    }
  }

  return {
    mode: propagate ? 'propagate' : 'classic',
    generatedAt: new Date().toISOString(),
    summary: {
      actors: data.actors.length,
      segments: ok + failed + unreachable,
      ok,
      failed,
      unreachable,
      conflicts: conflicts.length,
    },
    conflicts,
    actors,
  };
}

module.exports = { validate, MODES, capacityOf, detectConflicts };
