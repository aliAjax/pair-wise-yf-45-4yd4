import type { Scene, Talent } from "../types";

export interface PlanChange {
  sceneId: string;
  code: string;
  title: string;
  day: string;
  fromStart: string;
  fromEnd: string;
  toStart: string;
  toEnd: string;
}

export interface PlanResult {
  feasible: boolean;
  chainIds: string[];
  changes: PlanChange[];
  earliestStart: string | null;
  reason: string | null;
}

const DAY_END = 24 * 60;
const SEARCH_LIMIT = 22 * 60;
const STEP = 15;

export function minutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

export function toHHMM(total: number): string {
  const clamped = Math.max(0, total);
  const hour = Math.floor(clamped / 60) % 24;
  const minute = clamped % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function rangesOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA < endB && startB < endA;
}

interface RawPos {
  day: string;
  start: number;
  end: number;
}

function posOf(scene: Scene, moved: Map<string, RawPos>): RawPos {
  return moved.get(scene.id) ?? { day: scene.day, start: minutes(scene.start), end: minutes(scene.end) };
}

/** 两场戏之间的资源/转场冲突判定（与冲突中心口径一致），顺延场次用原始分钟计算。 */
function pairConflict(a: Scene, b: Scene, moved: Map<string, RawPos>): string | null {
  const posA = posOf(a, moved);
  const posB = posOf(b, moved);
  if (posA.day !== posB.day) return null;
  if (!rangesOverlap(posA.start, posA.end, posB.start, posB.end)) {
    if (a.locationId !== b.locationId) {
      const gap = posA.start <= posB.start ? posB.start - posA.end : posA.start - posB.end;
      if (gap < 30) return "转场时间";
    }
    return null;
  }
  if (a.talentIds.some((id) => b.talentIds.includes(id))) return "演员档期";
  if (a.locationId === b.locationId) return "场地占用";
  if (a.equipmentIds.some((id) => b.equipmentIds.includes(id))) return "器材借用";
  return null;
}

function talentBusyConflict(scene: Scene, pos: RawPos, talents: Talent[]): boolean {
  return scene.talentIds.some((tid) => {
    const talent = talents.find((item) => item.id === tid);
    if (!talent || !talent.busy.length) return false;
    return talent.busy.some((window) =>
      window.day === pos.day &&
      rangesOverlap(pos.start, pos.end, minutes(window.start), minutes(window.end))
    );
  });
}

/** 选中一场后，同一拍摄日内可一起顺延的连续场次（跨日不属同组；已锁定/已完成的场次不可移动，链止于此）。 */
export function findChain(scenes: Scene[], sceneId: string): Scene[] {
  const sorted = [...scenes].sort((a, b) => `${a.day} ${a.start}`.localeCompare(`${b.day} ${b.start}`));
  const index = sorted.findIndex((item) => item.id === sceneId);
  if (index < 0) return [];
  const selected = sorted[index];
  if (selected.locked || selected.status === "已完成") return [];
  const chain: Scene[] = [];
  for (let i = index; i < sorted.length; i += 1) {
    const scene = sorted[i];
    if (scene.day !== selected.day) break;
    if (scene.locked || scene.status === "已完成") break;
    chain.push(scene);
  }
  return chain;
}

function buildMoved(chain: Scene[], delta: number): Map<string, RawPos> {
  const moved = new Map<string, RawPos>();
  for (const scene of chain) {
    moved.set(scene.id, { day: scene.day, start: minutes(scene.start) + delta, end: minutes(scene.end) + delta });
  }
  return moved;
}

function evaluate(scenes: Scene[], chain: Scene[], delta: number, talents: Talent[]): { ok: boolean; reason: string | null } {
  const moved = buildMoved(chain, delta);
  for (const scene of chain) {
    const pos = moved.get(scene.id);
    if (!pos) continue;
    if (pos.end >= DAY_END) return { ok: false, reason: "顺延超出当日拍摄窗口" };
    if (pos.start < 0) return { ok: false, reason: "早于当日拍摄窗口" };
    if (talentBusyConflict(scene, pos, talents)) return { ok: false, reason: "演员档期冲突" };
  }
  for (let i = 0; i < scenes.length; i += 1) {
    for (let j = i + 1; j < scenes.length; j += 1) {
      if (!moved.has(scenes[i].id) && !moved.has(scenes[j].id)) continue;
      const conflict = pairConflict(scenes[i], scenes[j], moved);
      if (conflict) return { ok: false, reason: conflict };
    }
  }
  return { ok: true, reason: null };
}

function changesFor(chain: Scene[], delta: number): PlanChange[] {
  return chain.map((origin) => {
    const start = minutes(origin.start) + delta;
    const end = minutes(origin.end) + delta;
    return {
      sceneId: origin.id,
      code: origin.code,
      title: origin.title,
      day: origin.day,
      fromStart: origin.start,
      fromEnd: origin.end,
      toStart: toHHMM(start),
      toEnd: toHHMM(end)
    };
  });
}

/**
 * 换场预案：选中一场填新时段后，整组顺延可用连续场次，跨场留三十分钟，
 * 同一演员/器材只占一个窗口。排不下则保留原通告并给出最早可行时段。
 */
export function planReschedule(scenes: Scene[], talents: Talent[], sceneId: string, newStart: string): PlanResult {
  const chain = findChain(scenes, sceneId);
  if (!chain.length) {
    return { feasible: false, chainIds: [], changes: [], earliestStart: null, reason: "该场次已锁定或已完成，无法顺延" };
  }
  const selected = chain[0];
  const chainIds = chain.map((scene) => scene.id);
  const delta = minutes(newStart) - minutes(selected.start);
  const first = evaluate(scenes, chain, delta, talents);
  if (first.ok) {
    return { feasible: true, chainIds, changes: changesFor(chain, delta), earliestStart: null, reason: null };
  }
  for (let t = minutes(newStart); t <= SEARCH_LIMIT; t += STEP) {
    const candidate = evaluate(scenes, chain, t - minutes(selected.start), talents);
    if (candidate.ok) {
      return { feasible: false, chainIds, changes: [], earliestStart: toHHMM(t), reason: first.reason };
    }
  }
  return { feasible: false, chainIds, changes: [], earliestStart: null, reason: first.reason };
}
