import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
import dayjs from "dayjs";
import type { Conflict, Equipment, HistoryEntry, Location, OfflineDraft, PlanStatus, ReschedulePlan, Role, Scene, SceneStatus, Talent, Version } from "../types";
import { planReschedule as computePlan } from "../utils/reschedule";

const STORAGE_KEY = "pair-wise-yf-45/schedule-v1";
const DRAFT_KEY = "pair-wise-yf-45/offline-draft";

const talents: Talent[] = [
  { id: "t1", name: "林川", role: "男主", busy: [] },
  { id: "t2", name: "周禾", role: "女主", busy: [] },
  { id: "t3", name: "顾言", role: "配角", busy: [] },
  { id: "t4", name: "孙宁", role: "群演领队", busy: [] }
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
  { id: "s2", code: "A-013", title: "厂房追逐", day: "2026-10-08", start: "10:30", end: "13:00", talentIds: ["t1", "t2"], locationId: "l1", equipmentIds: ["e2", "e4"], status: "草稿", locked: false },
  { id: "s3", code: "B-021", title: "候车厅告别", day: "2026-10-09", start: "15:00", end: "18:30", talentIds: ["t2", "t3"], locationId: "l3", equipmentIds: ["e1"], status: "草稿", locked: false }
];

function readScenes(): Scene[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw).scenes as Scene[] : structuredClone(seedScenes);
  } catch {
    return structuredClone(seedScenes);
  }
}

function readHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw).history as HistoryEntry[] : [];
  } catch {
    return [];
  }
}

function readVersions(): Version[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw).versions as Version[] : [];
  } catch {
    return [];
  }
}

function readPlans(): ReschedulePlan[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw).plans as ReschedulePlan[] : [];
  } catch {
    return [];
  }
}

function readDataVersion(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? Number(JSON.parse(raw).dataVersion ?? 0) : 0;
  } catch {
    return 0;
  }
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
  const plans = ref<ReschedulePlan[]>(readPlans());
  const dataVersion = ref<number>(readDataVersion());
  const submitting = ref(false);
  const simulateWriteFail = ref(false);
  const role = ref<Role>("制片");
  const exemptions = ref<string[]>([]);
  const online = ref(navigator.onLine);
  const draft = ref<OfflineDraft | null>(null);

  const talentNames = (ids: string[]) => ids.map((id) => talents.find((item) => item.id === id)?.name ?? id);
  const locationName = (id: string) => locations.find((item) => item.id === id)?.name ?? id;
  const equipmentNames = (ids: string[]) => ids.map((id) => equipment.find((item) => item.id === id)?.name ?? id);

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
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ scenes: scenes.value, history: history.value, versions: versions.value, plans: plans.value, dataVersion: dataVersion.value }));
  }

  watch([scenes, history, versions, plans, dataVersion], persist, { deep: true });

  function addScene(input: Omit<Scene, "id" | "status" | "locked">) {
    scenes.value.push({ ...input, id: crypto.randomUUID(), status: "草稿", locked: false });
    log("新增场次", `${input.code} ${input.title}`);
    bumpVersion();
  }

  function updateStatus(id: string, status: SceneStatus) {
    const scene = scenes.value.find((item) => item.id === id);
    if (!scene || scene.locked) return;
    scene.status = status;
    log("流转状态", `${scene.code} → ${status}`);
    bumpVersion();
  }

  function toggleLock(id: string) {
    const scene = scenes.value.find((item) => item.id === id);
    if (!scene) return;
    scene.locked = !scene.locked;
    log(scene.locked ? "锁定场次" : "解锁场次", scene.code);
    bumpVersion();
  }

  function moveScene(from: number, to: number) {
    if (from === to || to < 0 || to >= scenes.value.length) return;
    const [item] = scenes.value.splice(from, 1);
    scenes.value.splice(to, 0, item);
    log("调整顺序", `${item.code} 移至第 ${to + 1} 位`);
    bumpVersion();
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
    log("恢复版本", version.name);
    bumpVersion();
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
    log("同步离线草稿", `同步 ${draft.value.scenes.length} 个场次`);
    draft.value = null;
    localStorage.removeItem(DRAFT_KEY);
    bumpVersion();
  }

  function exempt(id: string) {
    exemptions.value.push(id);
    log("豁免冲突", id);
  }

  function setOnline(value: boolean) {
    online.value = value;
  }

  function bumpVersion() {
    dataVersion.value += 1;
    invalidatePlans();
  }

  function invalidatePlans() {
    for (const plan of plans.value) {
      if (plan.status === "待确认" && plan.baseVersion !== dataVersion.value) {
        plan.status = "已失效";
      }
    }
  }

  /** 选中一场填新时段，整组顺延可用连续场次；排不下则保留原通告并给出最早时段。 */
  function planReschedule(sceneId: string, newStart: string) {
    const result = computePlan(scenes.value, talents, sceneId, newStart);
    const selected = scenes.value.find((scene) => scene.id === sceneId);
    const plan: ReschedulePlan = {
      id: crypto.randomUUID(),
      sceneId,
      sceneCode: selected?.code ?? "?",
      day: selected?.day ?? "",
      newStart,
      chainIds: result.chainIds,
      changes: result.changes,
      feasible: result.feasible,
      earliestStart: result.earliestStart,
      status: "待确认",
      baseVersion: dataVersion.value,
      createdAt: new Date().toISOString(),
      failReason: result.reason
    };
    plans.value.unshift(plan);
    plans.value = plans.value.slice(0, 30);
    log("生成换场预案", `${plan.sceneCode} → ${newStart}${result.feasible ? "（可行）" : "（排不下，保留原通告）"}`);
    return plan;
  }

  /** 对比提交：并发只让一份生效；写入失败原子回滚，原通告不动。 */
  async function submitPlan(planId: string) {
    const plan = plans.value.find((item) => item.id === planId);
    if (!plan) return;
    if (submitting.value) return;
    if (plan.baseVersion !== dataVersion.value || plan.status === "已失效") {
      plan.status = "已失效";
      log("预案已失效", `${plan.sceneCode}：档期或场次已更新，请重排`);
      return;
    }
    if (!plan.feasible) {
      plan.status = "已失败";
      plan.failReason = plan.failReason ?? "预案排不下，未生效";
      return;
    }
    submitting.value = true;
    const snapshot = structuredClone(scenes.value);
    try {
      if (simulateWriteFail.value) throw new Error("模拟写入失败");
      const recheck = computePlan(scenes.value, talents, plan.sceneId, plan.newStart);
      if (!recheck.feasible) throw new Error(recheck.reason ?? "重算不可行");
      for (const change of plan.changes) {
        const scene = scenes.value.find((item) => item.id === change.sceneId);
        if (scene) {
          scene.start = change.toStart;
          scene.end = change.toEnd;
        }
      }
      plan.status = "已确认";
      plan.failReason = null;
      log("换场生效", `${plan.sceneCode} 起 ${plan.changes.length} 场顺延并写入`);
      bumpVersion();
    } catch (error) {
      scenes.value = snapshot;
      plan.status = "已失败";
      plan.failReason = error instanceof Error ? error.message : "写入失败，已回滚";
      log("换场失败已回滚", `${plan.sceneCode}：${plan.failReason}`);
    } finally {
      submitting.value = false;
    }
  }

  /** 未完成项重试：失败的重新提交，失效的重新排程。 */
  async function retryPlan(planId: string) {
    const plan = plans.value.find((item) => item.id === planId);
    if (!plan) return;
    if (plan.status === "已失效") {
      replanPlan(planId);
      return;
    }
    plan.status = "待确认";
    plan.failReason = null;
    await submitPlan(planId);
  }

  /** 依据当前档期/场次重新排程（旧确认失效后重排）。 */
  function replanPlan(planId: string) {
    const plan = plans.value.find((item) => item.id === planId);
    if (!plan) return;
    const result = computePlan(scenes.value, talents, plan.sceneId, plan.newStart);
    plan.chainIds = result.chainIds;
    plan.changes = result.changes;
    plan.feasible = result.feasible;
    plan.earliestStart = result.earliestStart;
    plan.baseVersion = dataVersion.value;
    plan.status = "待确认";
    plan.failReason = result.reason;
    log("重新排程", `${plan.sceneCode} → ${plan.newStart}${result.feasible ? "（可行）" : "（仍排不下）"}`);
  }

  /** 采用最早可行时段重排。 */
  function adoptEarliest(planId: string) {
    const plan = plans.value.find((item) => item.id === planId);
    if (!plan || !plan.earliestStart) return;
    plan.newStart = plan.earliestStart;
    replanPlan(planId);
  }

  /** 档期更新： bump 版本，使待确认预案失效需重排。 */
  function updateTalentBusy(talentId: string, day: string, start: string, end: string) {
    const talent = talents.find((item) => item.id === talentId);
    if (!talent) return;
    talent.busy.push({ day, start, end });
    log("档期更新", `${talent.name} ${day} ${start}-${end}`);
    bumpVersion();
  }

  function removePlan(planId: string) {
    plans.value = plans.value.filter((item) => item.id !== planId);
  }

  return { scenes, sortedScenes, conflicts, history, versions, role, exemptions, online, draft, talents, locations, equipment, plans, dataVersion, submitting, simulateWriteFail, talentNames, equipmentNames, locationName, addScene, updateStatus, toggleLock, moveScene, snapshot, restore, saveDraft, loadDraft, syncDraft, exempt, setOnline, bumpVersion, planReschedule, submitPlan, retryPlan, replanPlan, adoptEarliest, updateTalentBusy, removePlan };
});
