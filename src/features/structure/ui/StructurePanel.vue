<script setup lang="ts">
import { computed, ref } from "vue";
import { Activity, TriangleAlert, ShieldCheck, ArrowDown, Gauge } from "lucide-vue-next";
import type { Workspace } from "../../../shared/document";
import { materialSpec } from "../../../shared/materials";

const props = defineProps<{ state: Workspace }>();
const st = computed(() => props.state.structure);
const showRules = ref(false);

const phaseLabel = computed(() => {
  switch (st.value.phase) {
    case "analyzing":
      return "分析中";
    case "warning":
      return "失稳预警";
    case "collapsing":
      return "坍塌中";
    default:
      return "结构稳定";
  }
});

const phaseClass = computed(() => ({
  analyzing: st.value.phase === "analyzing",
  warning: st.value.phase === "warning",
  collapsing: st.value.phase === "collapsing",
  stable: st.value.phase === "idle" && st.value.unstable === 0,
}));

const progress = computed(() => {
  const total = st.value.total || 0;
  if (!total) return 0;
  if (st.value.phase === "analyzing")
    return Math.min(100, Math.round((st.value.analyzed / total) * 100));
  return 100;
});

const loadTone = computed(() => {
  const r = st.value.maxLoadRatio;
  if (r > 0.9) return "heavy";
  if (r > 0.65) return "warm";
  return "calm";
});

const materialRows = computed(() =>
  ["wood", "brick", "stone", "glass", "sand", "leaf"].map((id) => {
    const spec = materialSpec(id as never);
    return {
      id,
      name: spec.name,
      color: spec.color,
      span: spec.span,
      capacity: spec.capacity,
      weight: spec.weight,
    };
  }),
);
</script>
<template>
  <section class="panel structure" :class="phaseClass">
    <div class="section-title">
      <h2>结构诊断</h2>
      <Activity :size="17" />
    </div>
    <div class="structure-head">
      <span class="structure-state">
        <TriangleAlert v-if="st.phase === 'warning'" :size="15" />
        <ArrowDown v-else-if="st.phase === 'collapsing'" :size="15" />
        <ShieldCheck v-else :size="15" />
        {{ phaseLabel }}
      </span>
      <span class="structure-count">
        <template v-if="st.phase === 'analyzing'"
          >扫描 {{ st.analyzed }} / {{ st.total }}</template
        >
        <template v-else
          >{{ st.stable }} 稳固<template v-if="st.falling"
            > · {{ st.falling }} 坠落</template
          ></template
        >
      </span>
    </div>
    <div class="structure-meter" :title="phaseLabel">
      <i
        class="structure-fill"
        :class="{ danger: st.phase === 'warning' || st.phase === 'collapsing' }"
        :style="{ width: progress + '%' }"
      ></i>
      <span v-if="st.phase === 'analyzing'" class="structure-meter-label"
        >扫描 {{ st.analyzed }} / {{ st.total }}</span
      >
      <span v-else-if="st.phase === 'warning'" class="structure-meter-label"
        >{{ st.warningLeft.toFixed(1) }} 秒后坠落</span
      >
    </div>
    <p class="structure-message" :class="{ danger: st.danger }">
      {{ st.message }}
    </p>
    <div class="load-row">
      <span><Gauge :size="13" /> 最大载荷比</span>
      <b :class="loadTone">{{ st.maxLoadRatio.toFixed(2) }}×</b>
    </div>
    <button class="rules-toggle" @click="showRules = !showRules">
      <span>材质承重表</span>
      <em>{{ showRules ? "收起" : "展开" }}</em>
    </button>
    <div v-if="showRules" class="material-rules">
      <div class="rule-head">
        <span>材质</span><span>悬挑</span><span>承重</span>
      </div>
      <div
        v-for="m in materialRows"
        :key="m.id"
        class="material-rule"
        :title="`${m.name}：每块重量 ${m.weight}，可承载 ${m.capacity}`"
      >
        <span class="rule-name"
          ><i class="swatch" :style="{ background: m.color }"></i
          >{{ m.name }}</span
        ><em>{{ m.span }}</em
        ><small>{{ m.capacity }}</small>
      </div>
    </div>
    <p class="small muted structure-hint">
      拆掉支柱会让相连部分失去支撑；红色标记是坠落预警，离开红色区域即可避开。坍塌的方块不会回收材料。
    </p>
  </section>
</template>
