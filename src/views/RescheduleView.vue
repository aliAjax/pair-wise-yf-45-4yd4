<script setup lang="ts">
import { computed, reactive } from "vue";
import dayjs from "dayjs";
import { useScheduleStore } from "../stores/schedule";
import { buildChain } from "../lib/reschedule";

const store = useScheduleStore();

const request = reactive({ anchorSceneId: "", day: "2026-10-08", start: "14:00" });
const blockForm = reactive({ talentId: store.talents[0]?.id ?? "", day: "2026-10-08", start: "14:00", end: "17:00", reason: "" });

const isProducer = computed(() => store.role === "制片");
const canEditBlocks = computed(() => store.role === "制片" || store.role === "演员统筹");

const movableScenes = computed(() => store.sortedScenes.filter((scene) => !scene.locked && scene.status !== "拍摄中" && scene.status !== "已完成"));

const chainScenes = computed(() => (request.anchorSceneId ? buildChain(store.scenes, request.anchorSceneId) : []));

function sceneOf(id: string) {
  return store.scenes.find((item) => item.id === id);
}
function fmtTime(day: string, start: string, end: string) {
  return `${dayjs(day).format("MM-DD")} ${start}–${end}`;
}

function generate() {
  if (!request.anchorSceneId) return;
  store.createPlan(request.anchorSceneId, request.day, request.start);
}

async function commit() {
  await store.commitPlan();
}

function addBlock() {
  if (!blockForm.talentId) return;
  store.addTalentBlock({ talentId: blockForm.talentId, day: blockForm.day, start: blockForm.start, end: blockForm.end, reason: blockForm.reason || undefined });
}
</script>

<template>
  <section class="page">
    <div class="grid-2">
      <!-- 选择锚点与新时段 -->
      <section class="panel">
        <div class="panel-head"><h2>发起换场</h2><span class="status">封港整组顺延</span></div>
        <div class="form-grid">
          <label class="field wide">
            <span>锚点场次（选中后连续可移场次一起移动）</span>
            <select v-model="request.anchorSceneId">
              <option value="" disabled>请选择一场</option>
              <option v-for="scene in movableScenes" :key="scene.id" :value="scene.id">
                {{ scene.code }} {{ scene.title }} · {{ fmtTime(scene.day, scene.start, scene.end) }}
              </option>
            </select>
          </label>
          <label class="field"><span>新拍摄日</span><input v-model="request.day" type="date" /></label>
          <label class="field"><span>新开工时间</span><input v-model="request.start" type="time" /></label>
          <div class="actions wide">
            <button class="primary" :disabled="!isProducer || !request.anchorSceneId" @click="generate">生成换场预案</button>
            <span v-if="!isProducer" class="muted">仅制片可发起换场</span>
          </div>
        </div>

        <div v-if="chainScenes.length" class="chain-preview">
          <small class="muted">本次将一起移动（遇到锁定 / 拍摄中 / 已完成 / 跨日即截断）：</small>
          <ol>
            <li v-for="(scene, index) in chainScenes" :key="scene.id">
              <b :class="index === 0 ? 'anchor-tag' : ''">{{ index === 0 ? "锚点" : "顺延" }}</b>
              {{ scene.code }} {{ scene.title }}
              <small class="muted">{{ fmtTime(scene.day, scene.start, scene.end) }} · {{ store.locationName(scene.locationId) }}</small>
            </li>
          </ol>
        </div>
      </section>

      <!-- 当前预案 -->
      <section class="panel">
        <div class="panel-head">
          <div><h2>换场预案</h2><small class="muted">同一时间只允许一份生效，制片确认后提交</small></div>
          <span v-if="store.plan" class="status" :class="store.plan.status">{{ store.plan.status }}</span>
        </div>

        <el-empty v-if="!store.plan" description="尚未生成预案" />

        <div v-else class="plan-card">
          <div v-if="store.planStale" class="stale-banner">
            ⚠ 该预案依据已过期（档期更新或场次完成），旧确认失效，请以最新通告重新排预案。
          </div>

          <p class="muted">
            锚点 {{ store.plan.anchorCode }} 申请 {{ store.plan.requestedDay }} {{ store.plan.requestedStart }} 开工
          </p>

          <!-- 排得下：给出整组移动表 -->
          <template v-if="store.plan.feasible && store.plan.items.length">
            <table class="plan-table">
              <thead><tr><th>场次</th><th>原时段</th><th></th><th>新时段</th></tr></thead>
              <tbody>
                <tr v-for="item in store.plan.items" :key="item.sceneId">
                  <td><span class="kind" :class="item.kind">{{ item.kind }}</span> {{ sceneOf(item.sceneId)?.code }} <small class="muted">{{ sceneOf(item.sceneId)?.title }}</small></td>
                  <td><small>{{ fmtTime(item.fromDay, item.fromStart, item.fromEnd) }}</small></td>
                  <td>→</td>
                  <td><b>{{ fmtTime(item.toDay, item.toStart, item.toEnd) }}</b></td>
                </tr>
              </tbody>
            </table>
            <small class="muted">同一演员、同一器材全程只占一个时间窗；不同场地相邻场次自动留出 30 分钟转场。</small>

            <div v-if="store.plan.status === '写入失败'" class="error-banner">
              写入失败：{{ store.plan.error }}。原通告未改动，以上 {{ store.plan.items.length }} 场均为未完成项，可重试。
            </div>

            <div class="actions wide plan-actions">
              <button v-if="store.plan.status === '待确认'" class="primary" :disabled="!isProducer || store.planStale" @click="store.confirmPlan">
                制片确认
              </button>
              <template v-if="store.plan.status === '已确认待提交'">
                <button class="primary" :disabled="!isProducer || store.planStale || store.committing" @click="commit">
                  {{ store.committing ? "提交中…" : "提交生效" }}
                </button>
                <button class="secondary" :disabled="store.committing" @click="store.dismissPlan">放弃</button>
              </template>
              <button v-if="store.plan.status === '写入失败'" class="primary" :disabled="!isProducer || store.planStale" @click="store.retryPlan(); commit()">
                重试提交
              </button>
              <span v-if="store.planStale" class="muted">请重新生成预案后再确认/提交</span>
            </div>
          </template>

          <!-- 排不下：保留原通告，给最早时段 -->
          <template v-else>
            <div class="infeasible">
              <p><b>新时段整组排不下，原通告保持不动。</b></p>
              <p v-if="store.plan.reasonMessage">受阻原因：{{ store.plan.reasonMessage }}</p>
              <p v-if="store.plan.earliestDay">
                最早可整体排下的时段：<b class="anchor-tag">{{ store.plan.earliestDay }} {{ store.plan.earliestStart }}</b>
              </p>
              <p v-else class="muted">未来 7 天内均无整体可排时段，请调整档期或拆组。</p>
              <div class="actions">
                <button class="secondary" :disabled="!isProducer" @click="request.day = store.plan.earliestDay ?? request.day; request.start = store.plan.earliestStart ?? request.start; generate()">
                  采用最早时段重排
                </button>
                <button class="secondary" @click="store.dismissPlan">关闭</button>
              </div>
            </div>
          </template>
        </div>
      </section>
    </div>

    <!-- 演员不可用档期 -->
    <section class="panel">
      <div class="panel-head">
        <div><h2>演员档期占用</h2><small class="muted">登记后参与换场校验；任何更新都会使未生效的旧预案失效</small></div>
      </div>
      <div class="block-layout">
        <form class="form-grid block-form" @submit.prevent="addBlock">
          <label class="field"><span>演员</span>
            <select v-model="blockForm.talentId">
              <option v-for="talent in store.talents" :key="talent.id" :value="talent.id">{{ talent.name }} · {{ talent.role }}</option>
            </select>
          </label>
          <label class="field"><span>日期</span><input v-model="blockForm.day" type="date" /></label>
          <label class="field"><span>起</span><input v-model="blockForm.start" type="time" /></label>
          <label class="field"><span>止</span><input v-model="blockForm.end" type="time" /></label>
          <label class="field wide"><span>事由</span><input v-model="blockForm.reason" placeholder="例如：品牌活动 / 航班" /></label>
          <div class="actions wide"><button class="primary" :disabled="!canEditBlocks">登记档期</button>
            <span v-if="!canEditBlocks" class="muted">制片 / 演员统筹可登记</span>
          </div>
        </form>
        <div class="block-list">
          <el-empty v-if="!store.talentBlocks.length" description="暂无档期占用" :image-size="60" />
          <article v-for="block in store.talentBlocks" :key="block.id" class="block-row">
            <b>{{ store.talentName(block.talentId) }}</b>
            <span>{{ fmtTime(block.day, block.start, block.end) }}</span>
            <small class="muted">{{ block.reason || "未填事由" }}</small>
            <button class="secondary" :disabled="!canEditBlocks" @click="store.removeTalentBlock(block.id)">撤销</button>
          </article>
        </div>
      </div>
      <div class="simulate">
        <label class="muted"><input type="checkbox" :checked="store.failNextCommit" @change="store.setFailNextCommit(($event.target as HTMLInputElement).checked)" /> 模拟下一次提交写入失败（用于验证原通告不动与重试）</label>
      </div>
    </section>
  </section>
</template>
