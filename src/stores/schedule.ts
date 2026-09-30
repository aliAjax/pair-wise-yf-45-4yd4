import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
import dayjs from "dayjs";
import type { Conflict, Equipment, HistoryEntry, Location, OfflineDraft, ReschedulePlan, Role, Scene, SceneStatus, Talent, TalentBlock, Version } from "../types";
import { buildPlan as buildPlanDraft, isMovable } from "../lib/reschedule";

const STORAGE_KEY = "pair-wise-yf-45/schedule-v1";
const DRAFT_KEY = "pair-wise-yf-45/offline-draft";

function readState<T>(field: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return (field in parsed ? parsed[field] : fallback) as T;
  } catch {
    return fallback;
  }
}

const talents: Talent[] = [
  { id: "t1", name: "林川", role: "男主" },
  { id: "t2", name: "周禾", role: "女主" },
  { id: "t3", name: "顾言", role: "配角" },
  { id: "t4", name: "孙宁", role: "群演领队" }
];

const locations: Location[] = [
  { id: "l1", name: "老码头" },
  { id: "l2", name: "玻璃厂房" },
  { id: "l3", name: "南站候车厅" }
];

const equipment: Equipment[] = [
  { id: "e1", name: "ARRI A机" },
  { id: "e2", name: "移动伸缩炮" },
  { id: "e3", name: "LED灯组" },
  { id: "e4", name: "跟拍车" }
];

const seedScenes: Scene[] = [
  { id: "s1", code: "A-012", title: "码头交接", day: "2026-10-08", start: "08:00", end: "11:30", talentIds: ["t1", "t3"], locationId: "l1", equipmentIds: ["e1", "e3"], status: "已确认", locked: false },
  { id: "s2", code: "A-013", title: "厂房追逐", day: "2026-10-08", start: "11:00", end: "13:00", talentIds: ["t1", "t2"], locationId: "l2", equipmentIds: ["e2", "e4"], status: "草稿", locked: false },
  { id: "s3", code: "B-021", title: "候车厅告别", day: "2026-10-09", start: "15:00", end: "18:30", talentIds: ["t2", "t3"], locationId: "l3", equipmentIds: ["e1"], status: "草稿", locked: false }
];

function readScenes(): Scene[] {
  return readState<Scene[]>("scenes", structuredClone(seedScenes));
}

function readHistory(): HistoryEntry[] {
  return readState<HistoryEntry[]>("history", []);
}

function readVersions(): Version[] {
  return readState<Version[]>("versions", []);
}

function minutes(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function overlaps(a: Scene, b: Scene) {
  return a.day === b.day && minutes(a.start) < minutes(b.end) && minutes(b.start) < minutes(a.end);
}

function shared(a: string[], b: string[]) {
  return a.some((value) => b.includes(value));
}

export const useScheduleStore = defineStore("schedule", () => {
  const scenes = ref<Scene[]>(readScenes());
  const history = ref<HistoryEntry[]>(readHistory());
  const versions = ref<Version[]>(readVersions());
  const talentBlocks = ref<TalentBlock[]>(readState<TalentBlock[]>("talentBlocks", []));
  const revision = ref<number>(readState<number>("revision", 0));
  const plan = ref<ReschedulePlan | null>(readState<ReschedulePlan | null>("plan", null));
  const committing = ref(false);
  const failNextCommit = ref(false);
  const role = ref<Role>("制片");
  const exemptions = ref<string[]>([]);
  const online = ref(navigator.onLine);
  const draft = ref<OfflineDraft | null>(null);

  const talentNames = (ids: string[]) => ids.map((id) => talents.find((item) => item.id === id)?.name ?? id);
  const talentName = (id: string) => talents.find((item) => item.id === id)?.name ?? id;
  const locationName = (id: string) => locations.find((item) => item.id === id)?.name ?? id;
  const equipmentNames = (ids: string[]) => ids.map((id) => equipment.find((item) => item.id === id)?.name ?? id);

  /** 每次档期 / 场次 / 完成状态变化都推进修订号，旧预案据此失效 */
  function bumpRevision() {
    revision.value += 1;
  }

  /** 已生成但依据过期的预案：制片确认前档期更新或场次完成，需重新排 */
  const planStale = computed(() => plan.value !== null && plan.value.basisRevision !== revision.value);

  const conflicts = computed<Conflict[]>(() => {
    const result: Conflict[] = [];
    for (let i = 0; i < scenes.value.length; i += 1) {
      for (let j = i + 1; j < scenes.value.length; j += 1) {
        const a = scenes.value[i];
        const b = scenes.value[j];
        if (!overlaps(a, b)) continue;
        const id = `${a.id}:${b.id}`;
        if (exemptions.value.includes(id)) continue;
        if (shared(a.talentIds, b.talentIds)) result.push({ id: `${id}:talent`, type: "演员档期", sceneIds: [a.id, b.id], message: `${talentNames(a.talentIds.filter((item) => b.talentIds.includes(item))).join("、")} 在两场戏中档期重叠`, severity: "高" });
        if (a.locationId === b.locationId) result.push({ id: `${id}:location`, type: "场地占用", sceneIds: [a.id, b.id], message: `${locationName(a.locationId)} 被同时占用`, severity: "高" });
        if (shared(a.equipmentIds, b.equipmentIds)) result.push({ id: `${id}:equipment`, type: "器材借用", sceneIds: [a.id, b.id], message: `${equipmentNames(a.equipmentIds.filter((item) => b.equipmentIds.includes(item))).join("、")} 发生借用重叠`, severity: "中" });
        if (a.locationId !== b.locationId && minutes(b.start) - minutes(a.end) < 30) result.push({ id: `${id}:transfer`, type: "转场时间", sceneIds: [a.id, b.id], message: "两个场地之间转场时间不足30分钟", severity: "中" });
      }
    }
    return result;
  });

  const sortedScenes = computed(() => [...scenes.value].sort((a, b) => `${a.day} ${a.start}`.localeCompare(`${b.day} ${b.start}`)));

  function log(action: string, detail: string) {
    history.value.unshift({ id: crypto.randomUUID(), action, detail, time: new Date().toISOString() });
    history.value = history.value.slice(0, 80);
  }

  function persist() {
    const snapshot = {
      scenes: scenes.value,
      history: history.value,
      versions: versions.value,
      talentBlocks: talentBlocks.value,
      revision: revision.value,
      plan: plan.value
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  }

  watch([scenes, history, versions, talentBlocks, revision, plan], persist, { deep: true });

  function addScene(input: Omit<Scene, "id" | "status" | "locked">) {
    scenes.value.push({ ...input, id: crypto.randomUUID(), status: "草稿", locked: false });
    bumpRevision();
    log("新增场次", `${input.code} ${input.title}`);
  }

  function updateStatus(id: string, status: SceneStatus) {
    const scene = scenes.value.find((item) => item.id === id);
    if (!scene || scene.locked) return;
    scene.status = status;
    bumpRevision();
    log("流转状态", `${scene.code} → ${status}`);
  }

  function toggleLock(id: string) {
    const scene = scenes.value.find((item) => item.id === id);
    if (!scene) return;
    scene.locked = !scene.locked;
    bumpRevision();
    log(scene.locked ? "锁定场次" : "解锁场次", scene.code);
  }

  function moveScene(from: number, to: number) {
    if (from === to || to < 0 || to >= scenes.value.length) return;
    const [item] = scenes.value.splice(from, 1);
    scenes.value.splice(to, 0, item);
    log("调整顺序", `${item.code} 移至第 ${to + 1} 位`);
  }

  function snapshot(name = `版本 ${versions.value.length + 1}`) {
    versions.value.unshift({ id: crypto.randomUUID(), name, time: new Date().toISOString(), scenes: structuredClone(scenes.value) });
    versions.value = versions.value.slice(0, 12);
    log("保存版本", name);
  }

  function restore(id: string) {
    const version = versions.value.find((item) => item.id === id);
    if (!version) return;
    scenes.value = structuredClone(version.scenes);
    bumpRevision();
    log("恢复版本", version.name);
  }

  function saveDraft() {
    draft.value = { scenes: structuredClone(scenes.value), savedAt: new Date().toISOString() };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft.value));
    log("保存离线草稿", dayjs(draft.value.savedAt).format("MM-DD HH:mm"));
  }

  function loadDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      draft.value = raw ? JSON.parse(raw) as OfflineDraft : null;
    } catch {
      draft.value = null;
    }
  }

  function syncDraft() {
    if (!draft.value) return;
    scenes.value = structuredClone(draft.value.scenes);
    bumpRevision();
    log("同步离线草稿", `同步 ${draft.value.scenes.length} 个场次`);
    draft.value = null;
    localStorage.removeItem(DRAFT_KEY);
  }

  // ---------------- 演员不可用档期 ----------------

  function addTalentBlock(input: Omit<TalentBlock, "id">) {
    talentBlocks.value.push({ ...input, id: crypto.randomUUID() });
    bumpRevision();
    log("登记档期", `${talentName(input.talentId)} ${input.day} ${input.start}-${input.end}`);
  }

  function removeTalentBlock(id: string) {
    const block = talentBlocks.value.find((item) => item.id === id);
    talentBlocks.value = talentBlocks.value.filter((item) => item.id !== id);
    bumpRevision();
    if (block) log("撤销档期", `${talentName(block.talentId)} ${block.day}`);
  }

  // ---------------- 换场预案 ----------------

  /** 生成预案：同时只保留一份；排不下则 items 为空并回报最早时段，原通告不动 */
  function createPlan(anchorSceneId: string, requestedDay: string, requestedStart: string) {
    if (role.value !== "制片") return;
    const anchor = scenes.value.find((scene) => scene.id === anchorSceneId);
    if (!anchor || !isMovable(anchor)) return;
    const draft = buildPlanDraft(scenes.value, anchorSceneId, requestedDay, requestedStart, talentBlocks.value);
    plan.value = {
      id: crypto.randomUUID(),
      anchorSceneId,
      anchorCode: anchor.code,
      requestedDay,
      requestedStart,
      status: "待确认",
      createdAt: new Date().toISOString(),
      basisRevision: revision.value,
      feasible: draft.feasible,
      items: draft.feasible
        ? draft.items.map((item) => {
            const scene = scenes.value.find((entry) => entry.id === item.sceneId)!;
            return {
              sceneId: item.sceneId,
              kind: item.kind,
              fromDay: scene.day,
              fromStart: scene.start,
              fromEnd: scene.end,
              toDay: item.toDay,
              toStart: item.toStart,
              toEnd: item.toEnd
            };
          })
        : [],
      earliestDay: draft.earliestDay,
      earliestStart: draft.earliestStart,
      reasonSceneId: draft.reasonSceneId,
      reasonMessage: draft.reasonMessage
    };
    log(draft.feasible ? "生成换场预案" : "换场排不下", `${anchor.code} → ${requestedDay} ${requestedStart}`);
  }

  /** 制片确认：依据必须是最新修订号，否则旧确认失效，要求重排 */
  function confirmPlan() {
    if (!plan.value || role.value !== "制片") return;
    if (!plan.value.feasible || plan.value.items.length === 0) return;
    if (plan.value.basisRevision !== revision.value) return;
    plan.value.status = "已确认待提交";
    log("确认换场预案", `${plan.value.anchorCode} 等 ${plan.value.items.length} 场`);
  }

  /**
   * 提交：同一时间只让一份生效。先把整组写入工作区，写入成功才动内存；
   * 写入失败原通告不动，保留全部未完成项可重试。
   */
  async function commitPlan(): Promise<{ ok: boolean; error?: string }> {
    const current = plan.value;
    if (!current || current.status !== "已确认待提交" || committing.value) {
      return { ok: false, error: "当前没有可提交的预案" };
    }
    // CAS：确认后档期更新 / 场次完成，旧确认失效，必须重排后再提交
    if (current.basisRevision !== revision.value) {
      current.error = "提交前通告依据已变化（档期更新或场次完成），旧确认已失效，请重新排预案";
      return { ok: false, error: current.error };
    }

    committing.value = true;
    await new Promise((resolve) => setTimeout(resolve, 320));

    const nextScenes = structuredClone(scenes.value);
    for (const item of current.items) {
      const scene = nextScenes.find((entry) => entry.id === item.sceneId);
      if (!scene) {
        committing.value = false;
        current.error = `场次 ${item.sceneId} 已不存在，原通告未改动，请重排`;
        return { ok: false, error: current.error };
      }
      scene.day = item.toDay;
      scene.start = item.toStart;
      scene.end = item.toEnd;
    }

    try {
      if (!online.value) throw new Error("离线状态，无法写入");
      if (failNextCommit.value) {
        failNextCommit.value = false;
        throw new Error("模拟写入失败（服务端拒绝）");
      }
      const snapshot = {
        scenes: nextScenes,
        history: history.value,
        versions: versions.value,
        talentBlocks: talentBlocks.value,
        revision: revision.value,
        plan: null as ReschedulePlan | null
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      // 写入成功后才替换内存，保证失败时原通告不动
      scenes.value = nextScenes;
      const applied = current.items.length;
      plan.value = null;
      bumpRevision();
      log("换场生效", `${current.anchorCode} 等 ${applied} 场已整体顺延`);
      return { ok: true };
    } catch (error) {
      // 原子失败：内存中的原通告完全未改，全部场次仍属未完成项，可直接重试
      current.status = "写入失败";
      current.error = error instanceof Error ? error.message : "写入失败";
      log("换场写入失败", `${current.anchorCode}：原通告未改动，可重试`);
      return { ok: false, error: current.error };
    } finally {
      committing.value = false;
    }
  }

  /** 写入失败后重试：依据过期则先要求重排，否则回到待提交再提交 */
  function retryPlan() {
    if (!plan.value || plan.value.status !== "写入失败") return;
    if (plan.value.basisRevision !== revision.value) {
      plan.value.error = "重试前依据已变化，请重新排预案";
      return;
    }
    plan.value.status = "已确认待提交";
    plan.value.error = undefined;
  }

  function dismissPlan() {
    if (!plan.value) return;
    log("放弃换场预案", plan.value.anchorCode);
    plan.value = null;
  }

  function setFailNextCommit(value: boolean) {
    failNextCommit.value = value;
  }

  function exempt(id: string) {
    exemptions.value.push(id);
    log("豁免冲突", id);
  }

  function setOnline(value: boolean) {
    online.value = value;
  }

  return { scenes, sortedScenes, conflicts, history, versions, role, exemptions, online, draft, talents, locations, equipment, talentBlocks, revision, plan, planStale, committing, failNextCommit, talentNames, talentName, equipmentNames, locationName, addScene, updateStatus, toggleLock, moveScene, snapshot, restore, saveDraft, loadDraft, syncDraft, exempt, setOnline, addTalentBlock, removeTalentBlock, createPlan, confirmPlan, commitPlan, retryPlan, dismissPlan, setFailNextCommit };
});
