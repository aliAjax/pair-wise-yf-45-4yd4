import dayjs from "dayjs";
import type { Scene, TalentBlock } from "../types";

/** 跨场最小转场缓冲（分钟） */
export const TRANSFER_GAP = 30;
/** 每天可开工起点；顺延跨越午夜后回到次日此时段 */
export const DAY_START = "08:00";
/** 最早时段搜索步长与上限 */
const SEARCH_STEP = 15;
const SEARCH_DAYS = 7;
const SLOT_LIMIT = 24 * 60;

export interface BlockWindow {
  day: string;
  startMin: number;
  endMin: number;
}

export interface Violation {
  sceneId: string;
  message: string;
}

export type PlacedWindow = BlockWindow & { duration: number };

export function toMin(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function addDays(day: string, offset: number) {
  return dayjs(day).add(offset, "day").format("YYYY-MM-DD");
}

export function isMovable(scene: Scene) {
  return !scene.locked && scene.status !== "拍摄中" && scene.status !== "已完成";
}

function shared(a: string[], b: string[]) {
  return a.some((value) => b.includes(value));
}

function blockWindows(blocks: TalentBlock[]): BlockWindow[] {
  return blocks.map((block) => ({ day: block.day, startMin: toMin(block.start), endMin: toMin(block.end) }));
}

/**
 * 取锚点之后同一拍摄日内「可一起移动的连续场次」：
 * 按拍摄顺序向后顺延，遇到锁定 / 拍摄中 / 已完成 / 跨日即截断，原通告保持不动。
 */
export function buildChain(scenes: Scene[], anchorId: string): Scene[] {
  const ordered = [...scenes].sort((a, b) => `${a.day} ${a.start}`.localeCompare(`${b.day} ${b.start}`));
  const anchorIndex = ordered.findIndex((scene) => scene.id === anchorId);
  if (anchorIndex < 0 || !isMovable(ordered[anchorIndex])) return [];
  const anchor = ordered[anchorIndex];
  const chain: Scene[] = [anchor];
  for (let i = anchorIndex + 1; i < ordered.length; i += 1) {
    const next = ordered[i];
    if (next.day !== anchor.day) break;
    if (!isMovable(next)) break;
    chain.push(next);
  }
  return chain;
}

/**
 * 校验某场以 [startMin, endMin) 落在 day 是否违反固定窗口。
 * 被移动的场次（movingIds）彼此之间不互查，由落位顺序保证。
 */
export function checkSlot(
  scene: Scene,
  day: string,
  startMin: number,
  endMin: number,
  fixed: Scene[],
  blocks: BlockWindow[],
  movingIds: string[]
): Violation | null {
  if (startMin < 0 || endMin > SLOT_LIMIT || endMin <= startMin) {
    return { sceneId: scene.id, message: "超出当日可拍摄时段" };
  }
  for (const other of fixed) {
    if (movingIds.includes(other.id)) continue;
    const overlap = day === other.day && startMin < toMin(other.end) && toMin(other.start) < endMin;
    if (overlap && scene.locationId === other.locationId) {
      return { sceneId: scene.id, message: `与固定场次 ${other.code} 的场地占用冲突` };
    }
    if (overlap && shared(scene.talentIds, other.talentIds)) {
      return { sceneId: scene.id, message: `与固定场次 ${other.code} 的演员档期冲突` };
    }
    if (overlap && shared(scene.equipmentIds, other.equipmentIds)) {
      return { sceneId: scene.id, message: `与固定场次 ${other.code} 的器材借用冲突` };
    }
    if (scene.locationId !== other.locationId) {
      // 跨场地且共享演员或器材、两场前后相邻时，要留出 30 分钟转场窗口
      const sharedResource = shared(scene.talentIds, other.talentIds) || shared(scene.equipmentIds, other.equipmentIds);
      const afterOther = day === other.day && startMin >= toMin(other.end) && startMin - toMin(other.end) < TRANSFER_GAP;
      const beforeOther = day === other.day && toMin(other.start) >= endMin && toMin(other.start) - endMin < TRANSFER_GAP;
      if (sharedResource && (afterOther || beforeOther)) {
        return { sceneId: scene.id, message: `与固定场次 ${other.code} 之间转场不足 30 分钟` };
      }
    }
  }
  for (const block of blocks) {
    if (block.day !== day) continue;
    if (scene.talentIds.length && startMin < block.endMin && block.startMin < endMin) {
      return { sceneId: scene.id, message: "落入演员已登记的不可用档期" };
    }
  }
  return null;
}

interface Placed {
  scene: Scene;
  day: string;
  startMin: number;
  endMin: number;
}

/**
 * 给定锚点起点，顺序贪心落位整条链；每场保持原时长，不同场地之间留 30 分钟，
 * 超过当日 24:00 则次日 DAY_START 继续。任何一场排不下即整体失败。
 */
function placeChain(
  chain: Scene[],
  anchorDay: string,
  anchorStartMin: number,
  fixed: Scene[],
  blocks: BlockWindow[]
): { ok: true; placed: Placed[] } | { ok: false; violation: Violation } {
  const movingIds = chain.map((scene) => scene.id);
  const placed: Placed[] = [];
  for (let i = 0; i < chain.length; i += 1) {
    const scene = chain[i];
    const duration = toMin(scene.end) - toMin(scene.start);
    if (i === 0) {
      const endMin = anchorStartMin + duration;
      const violation = checkSlot(scene, anchorDay, anchorStartMin, endMin, fixed, blocks, movingIds);
      if (violation) return { ok: false, violation };
      placed.push({ scene, day: anchorDay, startMin: anchorStartMin, endMin });
      continue;
    }
    const previous = placed[i - 1];
    const needGap = scene.locationId !== previous.scene.locationId ? TRANSFER_GAP : 0;
    let day = previous.day;
    let startMin = previous.endMin + needGap;
    if (startMin + duration > SLOT_LIMIT) {
      day = addDays(day, 1);
      startMin = toMin(DAY_START);
    }
    const endMin = startMin + duration;
    const violation = checkSlot(scene, day, startMin, endMin, fixed, blocks, movingIds);
    if (violation) return { ok: false, violation };
    placed.push({ scene, day, startMin, endMin });
  }
  return { ok: true, placed };
}

function fmt(min: number) {
  const hour = Math.floor(min / 60);
  const minute = min % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export interface PlanDraft {
  feasible: boolean;
  items: {
    sceneId: string;
    kind: "锚点" | "顺延";
    toDay: string;
    toStart: string;
    toEnd: string;
  }[];
  earliestDay?: string;
  earliestStart?: string;
  reasonSceneId?: string;
  reasonMessage?: string;
}

/**
 * 换场预案核心：锚点必须精确落在新时段；落不下则保留原通告并回报最早可排时段。
 */
export function buildPlan(
  scenes: Scene[],
  anchorId: string,
  requestedDay: string,
  requestedStart: string,
  talentBlocks: TalentBlock[]
): PlanDraft {
  const chain = buildChain(scenes, anchorId);
  const anchor = chain[0];
  if (!anchor) {
    return { feasible: false, items: [], reasonSceneId: anchorId, reasonMessage: "该场已锁定或正在拍摄/已完成，不能换场" };
  }
  const fixed = scenes.filter((scene) => !chain.some((item) => item.id === scene.id));
  const blocks = blockWindows(talentBlocks);

  // 1) 严格按制片填写的新时段尝试
  const requestedMin = toMin(requestedStart);
  const exact = placeChain(chain, requestedDay, requestedMin, fixed, blocks);
  if (exact.ok) {
    return {
      feasible: true,
      items: exact.placed.map((entry, index) => ({
        sceneId: entry.scene.id,
        kind: index === 0 ? "锚点" : "顺延",
        toDay: entry.day,
        toStart: fmt(entry.startMin),
        toEnd: fmt(entry.endMin)
      }))
    };
  }

  // 2) 排不下：保留原通告，从当日开工时间起逐格搜索最早可整体排下的时段
  for (let offset = 0; offset <= SEARCH_DAYS; offset += 1) {
    const day = addDays(requestedDay, offset);
    for (let startMin = toMin(DAY_START); startMin + (toMin(anchor.end) - toMin(anchor.start)) <= SLOT_LIMIT; startMin += SEARCH_STEP) {
      if (offset === 0 && startMin < requestedMin) continue;
      const candidate = placeChain(chain, day, startMin, fixed, blocks);
      if (candidate.ok) {
        return {
          feasible: false,
          items: [],
          earliestDay: day,
          earliestStart: fmt(startMin),
          reasonSceneId: exact.violation.sceneId,
          reasonMessage: exact.violation.message
        };
      }
    }
  }

  // 3) 搜索窗口内没有任何可行解
  return {
    feasible: false,
    items: [],
    reasonSceneId: exact.violation.sceneId,
    reasonMessage: `${exact.violation.message}；未来 ${SEARCH_DAYS} 天内也无整体可排时段`
  };
}
