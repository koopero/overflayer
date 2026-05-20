<template>
  <div :class="['card', 'player', { selected }]" @click="$emit('toggle', player.username)">
    <header>
      <input type="checkbox" :checked="selected" @click.stop="$emit('toggle', player.username)" />
      <span class="name">{{ player.username }}</span>
      <span :class="['status', player.status]">{{ player.status }}</span>
      <button
        class="view-btn"
        :disabled="!player.viewerPort"
        :title="player.viewerPort ? 'View first-person camera' : 'prismarine-viewer not loaded'"
        @click.stop="showView = true"
      >📸</button>
    </header>
    <div class="stats">
      <div><label>Pos</label>{{ pos }}</div>
      <div><label>Health</label>{{ player.health ?? '–' }}</div>
      <div><label>Food</label>{{ player.food ?? '–' }}</div>
    </div>
    <div class="snippets">
      <label>Snippets ({{ player.snippets.length }})</label>
      <ul v-if="player.snippets.length">
        <li v-for="s in player.snippets" :key="s.id">
          <span class="sid">{{ s.id }}</span>
          <span class="meta">{{ s.listenerCount }}L · {{ s.pendingTasks }}T · {{ s.reportCount }}R</span>
          <span class="src" :title="s.source">{{ shortSource(s.source) }}</span>
          <button class="rm" @click.stop="unload(s.id)">×</button>
        </li>
      </ul>
      <p v-else class="none">none</p>
    </div>
    <details v-if="lastReport">
      <summary>last report</summary>
      <pre>{{ formatReport(lastReport) }}</pre>
    </details>
    <PlayerViewer v-if="showView" :player="player" @close="showView = false" />
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  player: { type: Object, required: true },
  selected: { type: Boolean, default: false }
})
const emit = defineEmits(['toggle', 'changed'])

const showView = ref(false)

const pos = computed(() => {
  if (!props.player.position) return '–'
  const { x, y, z } = props.player.position
  return `${x.toFixed(1)} ${y.toFixed(1)} ${z.toFixed(1)}`
})

const lastReport = computed(() => {
  const withReports = props.player.snippets.filter(s => s.lastReport !== undefined)
  if (!withReports.length) return null
  withReports.sort((a, b) => (b.lastReportAt || 0) - (a.lastReportAt || 0))
  const top = withReports[0]
  return { id: top.id, at: top.lastReportAt, payload: top.lastReport }
})

function formatReport (r) {
  return `${r.id} @ ${new Date(r.at).toLocaleTimeString()}\n${typeof r.payload === 'string' ? r.payload : JSON.stringify(r.payload, null, 2)}`
}
function shortSource (s) {
  if (!s) return ''
  if (s === '<inline>') return '<inline>'
  return s.split('/').slice(-2).join('/')
}
async function unload (id) {
  await $fetch('/api/snippets', {
    method: 'DELETE',
    body: { targets: [props.player.username], id }
  })
  emit('changed')
}
</script>

<style scoped>
.player { cursor: pointer; transition: border-color 0.1s; }
.player:hover { border-color: #3a4356; }
.player.selected { border-color: #41d27c; box-shadow: 0 0 0 1px #41d27c40; }
header { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
header .name { font-weight: 600; color: #f0f3f8; flex: 1; }
.view-btn {
  padding: 2px 8px; font-size: 13px; line-height: 1;
  background: #1a1f29; border-color: #2c3445;
}
.view-btn:hover:not(:disabled) { background: #2c3a52; border-color: #41d27c; }
.status { font-size: 11px; padding: 2px 6px; border-radius: 3px; background: #2a3140; color: #8a93a4; }
.status.spawned { background: #1a4030; color: #41d27c; }
.status.kicked, .status.ended { background: #401a26; color: #d24166; }
.stats { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 8px; font-size: 12px; margin-bottom: 10px; }
.snippets ul { list-style: none; padding: 0; margin: 0; }
.snippets li {
  display: grid; grid-template-columns: 1.4fr 1.4fr 1fr 24px;
  gap: 6px; padding: 3px 0; font-size: 12px; align-items: center;
}
.sid { color: #e8c87a; }
.meta { color: #8a93a4; font-size: 11px; }
.src { color: #5a6578; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.snippets .none { color: #5a6578; font-style: italic; font-size: 12px; margin: 0; }
button.rm { padding: 0; width: 22px; height: 22px; font-size: 14px; line-height: 1; }
details { margin-top: 8px; font-size: 12px; }
details pre { background: #0e1014; padding: 8px; border-radius: 4px; overflow-x: auto; font-size: 11px; max-height: 180px; overflow-y: auto; }
</style>
