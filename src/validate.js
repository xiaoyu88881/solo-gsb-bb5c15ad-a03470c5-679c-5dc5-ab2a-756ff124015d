const { earliestArrival } = require('./graph');

const MODES = ['classic', 'propagate'];

/** 口令停留时长（秒）：旧数据无该字段，按 0 处理 */
function dwellOf(cue) {
  const d = cue.dwell;
  return Number.isInteger(d) && d > 0 ? d : 0;
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

  return {
    mode: propagate ? 'propagate' : 'classic',
    generatedAt: new Date().toISOString(),
    summary: {
      actors: data.actors.length,
      segments: ok + failed + unreachable,
      ok,
      failed,
      unreachable,
    },
    actors,
  };
}

module.exports = { validate, MODES };
