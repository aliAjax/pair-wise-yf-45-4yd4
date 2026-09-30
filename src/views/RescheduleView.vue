<script setup lang="ts">
import { computed, ref, watch } from "vue";
import dayjs from "dayjs";
import { useScheduleStore } from "../stores/schedule";

const store = useScheduleStore();
const editable = computed(() => store.role !== "场记");

const selectedId = ref<string>(store.sortedScenes[0]?.id ?? "");
const newStart = ref<string>(store.sortedScenes[0]?.start ?? "08:00");

watch(selectedId, (id) => {
  const scene = store.scenes.find((item) => item.id === id);
  if (scene) newStart.value = scene.start;
});

const selectedScene = computed(() => store.scenes.find((item) => item.id === selectedId.value));

const chainPreview = computed(() => {
  if (!selectedId.value) return [];
  // 仅用于展示：与引擎同口径的可移动连续场次
  const sorted = [...store.scenes].sort((a, b) => `${a.day} ${a.start}`.localeCompare(`${b.day} ${b.start}`));
  const index = sorted.findIndex((item) => item.id === selectedId.value);
  if (index < 0) return [];
  const first = sorted[index];
  if (first.locked || first.status === "已完成") return [];
  const chain = [];
  for (let i = index; i < sorted.length; i += 1) {
    const scene = sorted[i];
    if (scene.locked || scene.status === "已完成") break;
    chain.push(scene);
  }
  return chain;
});

function generate() {
  if (!selectedScene.value) return;
  store.planReschedule(selectedScene.value.id, newStart.value);
}

function chainCodes(ids: string[]) {
  return ids
    .map((id) => store.scenes.find((item) => item.id === id)?.code)
    .filter(Boolean)
    .join(" → ");
}

const busyForm = ref({ talentId: store.talents[0]?.id ?? "t1", day: "2026-10-08", start: "09:00", end: "11:00" });
function addBusy() {
  store.updateTalentBusy(busyForm.value.talentId, busyForm.value.day, busyForm.value.start, busyForm.value.end);
}
</script>

<template>
  <section class="page">
    <div class="plan-banner">
      <b>封港后整组顺延</b>
      <span>选中一场填新时段，可用连续场次一起移动；跨场留 30 分钟，同一演员/器材只占一个窗口。排不下则保留原通告并给最早时段。制片确认前若档期更新或场次完成，旧确认失效需重排；并发提交只让一份生效，写入失败回滚原通告，未完成项可重试。</span>
    </div>

    <div class="grid-2">
      <section class="panel">
        <div class="panel-head"><h2>发起换场预案</h2></div>
        <div class="scene-list">
          <article
            v-for="scene in store.sortedScenes"
            :key="scene.id"
            class="scene"
            :class="{ locked: scene.locked, active: scene.id === selectedId }"
            @click="selectedId = scene.id"
          >
            <b>{{ scene.code }}</b>
            <div class="scene-title">
              <b>{{ scene.title }}</b>
              <small>{{ scene.day }} {{ scene.start }}–{{ scene.end }} · {{ store.locationName(scene.locationId) }}</small>
            </div>
            <span class="status" :class="scene.status">{{ scene.status }}</span>
          </article>
        </div>

        <div class="plan-form">
          <label class="field"><span>新时段（首发场次）</span><input v-model="newStart" type="time" /></label>
          <div class="chain-note">
            <template v-if="chainPreview.length">
              将一起顺延 <b>{{ chainPreview.length }}</b> 场：{{ chainCodes(chainPreview.map((s) => s.id)) }}
            </template>
            <template v-else>该场次已锁定或已完成，无法顺延</template>
          </div>
          <div class="actions">
            <button class="primary" :disabled="!editable || !selectedScene || chainPreview.length === 0" @click="generate">生成换场预案</button>
          </div>
        </div>

        <div class="busy-box">
          <div class="panel-head"><h2>档期更新</h2><small class="muted">更新后待确认预案失效</small></div>
          <div class="form-grid">
            <label class="field"><span>演员</span>
              <select v-model="busyForm.talentId">
                <option v-for="item in store.talents" :key="item.id" :value="item.id">{{ item.name }} · {{ item.role }}</option>
              </select>
            </label>
            <label class="field"><span>日期</span><input v-model="busyForm.day" type="date" /></label>
            <label class="field"><span>开始</span><input v-model="busyForm.start" type="time" /></label>
            <label class="field"><span>结束</span><input v-model="busyForm.end" type="time" /></label>
          </div>
          <div class="actions"><button class="secondary" :disabled="!editable" @click="addBusy">更新档期</button></div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div><h2>换场预案</h2><small class="muted">数据版本 v{{ store.dataVersion }} · {{ store.plans.length }} 份预案</small></div>
          <label class="fail-toggle"><input type="checkbox" v-model="store.simulateWriteFail" /> 模拟写入失败</label>
        </div>

        <el-empty v-if="!store.plans.length" description="尚未生成预案" />

        <article v-for="plan in store.plans" :key="plan.id" class="plan-card" :class="plan.status">
          <div class="plan-head">
            <b>{{ plan.sceneCode }}</b>
            <span class="status" :class="plan.status">{{ plan.status }}</span>
            <small class="muted">{{ dayjs(plan.createdAt).format("MM-DD HH:mm:ss") }} · v{{ plan.baseVersion }}</small>
          </div>
          <div class="plan-meta">
            <span>{{ plan.day }} · 新时段 {{ plan.newStart }}</span>
            <span class="muted">链：{{ chainCodes(plan.chainIds) || "—" }}</span>
          </div>

          <template v-if="plan.status === '已失效'">
            <p class="plan-reason">数据已更新（档期或场次变化），原确认已失效，需重新排程。</p>
            <div class="actions">
              <button class="primary" :disabled="!editable" @click="store.replanPlan(plan.id)">重排</button>
              <button class="secondary" @click="store.removePlan(plan.id)">删除</button>
            </div>
          </template>

          <template v-else-if="plan.status === '已失败'">
            <p class="plan-reason">写入失败：{{ plan.failReason }}。原通告未改动，可重试。</p>
            <div class="actions">
              <button class="primary" :disabled="!editable || store.submitting" @click="store.retryPlan(plan.id)">重试</button>
              <button class="secondary" @click="store.removePlan(plan.id)">删除</button>
            </div>
          </template>

          <template v-else-if="!plan.feasible">
            <p class="plan-reason">排不下（{{ plan.failReason }}），原通告保留不变。</p>
            <p v-if="plan.earliestStart" class="plan-earliest">最早可行时段：<b>{{ plan.earliestStart }}</b></p>
            <p v-else class="plan-reason">当日已无可行窗口。</p>
            <div class="actions">
              <button v-if="plan.earliestStart" class="primary" :disabled="!editable" @click="store.adoptEarliest(plan.id)">采用最早时段</button>
              <button class="secondary" @click="store.removePlan(plan.id)">删除</button>
            </div>
          </template>

          <template v-else>
            <div class="plan-changes">
              <div v-for="change in plan.changes" :key="change.sceneId" class="change-row">
                <b>{{ change.code }}</b>
                <span>{{ change.fromStart }}–{{ change.fromEnd }}</span>
                <em>→</em>
                <span class="to">{{ change.toStart }}–{{ change.toEnd }}</span>
              </div>
            </div>
            <div class="actions">
              <button class="primary" :disabled="!editable || store.submitting" @click="store.submitPlan(plan.id)">确认生效</button>
              <button class="secondary" @click="store.removePlan(plan.id)">删除</button>
            </div>
          </template>
        </article>
      </section>
    </div>
  </section>
</template>

<style scoped>
.plan-banner { background:#fff4d8; border:1px solid #efcf83; border-radius:12px; padding:13px 16px; display:grid; gap:4px; }
.plan-banner b { color:#96600d; } .plan-banner span { color:#6b5d3f; font-size:13px; line-height:1.6; }
.scene.active { border-color:var(--accent); background:#fff3ef; }
.plan-form { margin-top:14px; display:grid; gap:10px; }
.chain-note { font-size:13px; color:var(--muted); background:#f5f7fb; border-radius:8px; padding:9px 11px; }
.chain-note b { color:var(--accent); }
.busy-box { margin-top:18px; padding-top:16px; border-top:1px dashed var(--line); }
.fail-toggle { display:flex; align-items:center; gap:6px; font-size:13px; color:var(--muted); }
.plan-card { border:1px solid var(--line); border-radius:12px; padding:14px; margin-bottom:12px; background:#fbfcfe; display:grid; gap:9px; }
.plan-card.已失效 { border-color:#e6c27a; background:#fffaf0; }
.plan-card.已失败 { border-color:#e0a4a4; background:#fff6f6; }
.plan-card.已确认 { border-color:#9fd6b6; background:#f3fbf6; }
.plan-head { display:flex; align-items:center; gap:10px; }
.plan-head small { margin-left:auto; }
.plan-meta { display:flex; justify-content:space-between; gap:10px; font-size:13px; color:var(--ink); }
.plan-reason { margin:0; font-size:13px; color:#96600d; }
.plan-earliest { margin:0; font-size:13px; color:var(--ink); }
.plan-earliest b { color:var(--accent); font-size:15px; }
.plan-changes { display:grid; gap:6px; }
.change-row { display:flex; align-items:center; gap:9px; font-size:13px; padding:6px 9px; background:#fff; border:1px solid var(--line); border-radius:8px; }
.change-row em { font-style:normal; color:var(--muted); }
.change-row .to { color:var(--accent); font-weight:700; }
.status.待确认 { background:#e8edf4; color:#3c4a63; }
.status.已失效 { background:#fde9c8; color:#96600d; }
.status.已失败 { background:#fbdada; color:#a83a3a; }
.status.已确认 { background:#dff3e8; color:#19704b; }
</style>
