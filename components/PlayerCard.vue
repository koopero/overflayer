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

    <!-- Player-level state -->
    <div v-if="hasState" class="state-section" @click.stop>
      <div class="state-rows">
        <div v-for="[k, s] in exportedState" :key="k" class="state-row">
          <label :title="s.declaredBy.join(', ')">{{ k }}</label>
          <select v-if="k === 'currentTask'"
                  :value="s.value ?? ''"
                  @change="setState(k, $event.target.value || null)">
            <option value="">(idle)</option>
            <option v-for="t in s.declaredBy" :key="t" :value="t">{{ t }}</option>
          </select>
          <select v-else-if="s.type === 'player'"
                  :value="s.value ?? ''"
                  @change="setState(k, $event.target.value || null)">
            <option value="">(none)</option>
            <option v-for="u in player.knownPlayers || []" :key="u" :value="u">{{ u }}</option>
          </select>
          <input v-else-if="s.type === 'boolean'"
                 type="checkbox"
                 :checked="!!s.value"
                 @change="setState(k, $event.target.checked)" />
          <input v-else-if="s.type === 'number'"
                 type="number"
                 :value="s.value ?? ''"
                 @change="setState(k, Number($event.target.value))" />
          <input v-else
                 type="text"
                 :value="drafts[k] ?? formatValue(s)"
                 @focus="drafts[k] = formatValue(s)"
                 @input="drafts[k] = $event.target.value"
                 @change="setFromText(k, s.type, $event.target.value)"
                 @blur="delete drafts[k]" />
          <span v-if="stStatus[k]" :class="['st', stStatus[k].kind]">{{ stStatus[k].msg }}</span>
        </div>
      </div>
      <details v-if="internalState.length" class="internal">
        <summary>internal ({{ internalState.length }})</summary>
        <div class="state-rows">
          <div v-for="[k, s] in internalState" :key="k" class="state-row read-only">
            <label>{{ k }}</label>
            <span class="val">{{ formatValue(s) || '–' }}</span>
          </div>
        </div>
      </details>
    </div>

    <!-- Loaded behaviors -->
    <div class="snippets">
      <label>Behaviors ({{ player.snippets.length }})</label>
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
    <details v-if="player.inventory && player.inventory.length">
      <summary>inventory ({{ player.inventory.length }} stacks)</summary>
      <ul class="inv-list">
        <li v-for="item in sortedInventory" :key="item.slot">
          <span class="inv-name">{{ item.name }}</span>
          <span class="inv-count">×{{ item.count }}</span>
        </li>
      </ul>
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
const stStatus = ref({})
const drafts = ref({})

const exportedState = computed(() =>
  Object.entries(props.player.state || {}).filter(([, v]) => v.exported)
)

const internalState = computed(() =>
  Object.entries(props.player.state || {}).filter(([, v]) => !v.exported)
)

const hasState = computed(() =>
  Object.keys(props.player.state || {}).length > 0
)

function formatValue (s) {
  if (s.value === undefined || s.value === null) return ''
  if (s.type === 'vec3' && s.value) return `${s.value.x},${s.value.y},${s.value.z}`
  return String(s.value)
}

function flash (key, kind, msg) {
  stStatus.value = { ...stStatus.value, [key]: { kind, msg } }
  setTimeout(() => {
    const next = { ...stStatus.value }
    delete next[key]
    stStatus.value = next
  }, 1500)
}

async function setState (key, value) {
  try {
    await $fetch('/api/state', {
      method: 'POST',
      body: { targets: [props.player.username], key, value }
    })
    flash(key, 'ok', '✓')
    emit('changed')
  } catch (err) {
    flash(key, 'err', err.data?.message || err.message)
  }
}

function setFromText (key, type, text) {
  if (type === 'vec3') {
    const parts = text.split(',').map(s => Number(s.trim()))
    if (parts.length !== 3 || parts.some(n => Number.isNaN(n))) {
      flash(key, 'err', 'expected x,y,z')
      return
    }
    setState(key, { x: parts[0], y: parts[1], z: parts[2] })
  } else {
    setState(key, text)
  }
}

const sortedInventory = computed(() =>
  [...(props.player.inventory || [])].sort((a, b) => b.count - a.count)
)

const pos = computed(() => {
  if (!props.player.position) return '–'
  const { x, y, z } = props.player.position
  return `${x.toFixed(1)} ${y.toFixed(1)} ${z.toFixed(1)}`
})

const lastReport = computed(() => {
  const with_ = props.player.snippets.filter(s => s.lastReport !== undefined)
  if (!with_.length) return null
  with_.sort((a, b) => (b.lastReportAt || 0) - (a.lastReportAt || 0))
  const top = with_[0]
  return { id: top.id, at: top.lastReportAt, payload: top.lastReport }
})

function formatReport (r) {
  return `${r.id} @ ${new Date(r.at).toLocaleTimeString()}\n${typeof r.payload === 'string' ? r.payload : JSON.stringify(r.payload, null, 2)}`
}
function shortSource (s) {
  if (!s || s === '<inline>') return s || ''
  return s.split('/').slice(-2).join('/')
}
async function unload (id) {
  await $fetch('/api/snippets', { method: 'DELETE', body: { targets: [props.player.username], id } })
  emit('changed')
}
</script>

<style scoped>
.player { cursor: pointer; transition: border-color 0.1s; }
.player:hover { border-color: #3a4356; }
.player.selected { border-color: #41d27c; box-shadow: 0 0 0 1px #41d27c40; }
header { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
header .name { font-weight: 600; color: #f0f3f8; flex: 1; }
.view-btn { padding: 2px 8px; font-size: 13px; line-height: 1; background: #1a1f29; border-color: #2c3445; }
.view-btn:hover:not(:disabled) { background: #2c3a52; border-color: #41d27c; }
.status { font-size: 11px; padding: 2px 6px; border-radius: 3px; background: #2a3140; color: #8a93a4; }
.status.spawned { background: #1a4030; color: #41d27c; }
.status.kicked, .status.ended { background: #401a26; color: #d24166; }
.stats { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 8px; font-size: 12px; margin-bottom: 10px; }

.state-section { margin-bottom: 10px; }
.state-rows { display: flex; flex-direction: column; gap: 3px; }
.state-row {
  display: grid; grid-template-columns: 90px 1fr 36px;
  gap: 6px; align-items: center; font-size: 12px;
}
.state-row label { font-size: 11px; color: #8a93a4; margin: 0; cursor: help; }
.state-row input[type="text"],
.state-row input[type="number"],
.state-row select { font-size: 11px; padding: 2px 6px; }
.state-row input[type="checkbox"] { justify-self: start; }
.state-row.read-only label { color: #5a6578; }
.state-row .val { font-size: 11px; color: #5a6578; font-family: monospace; }
.st { font-size: 11px; }
.st.ok { color: #41d27c; }
.st.err { color: #d24166; }
details.internal { margin-top: 4px; font-size: 11px; color: #5a6578; }
details.internal summary { cursor: pointer; user-select: none; }
details.internal .state-rows { margin-top: 4px; }

.snippets { margin-top: 2px; }
.snippets ul { list-style: none; padding: 0; margin: 0; }
.snippets li {
  display: grid; grid-template-columns: 1.2fr 1.4fr 1fr 24px;
  gap: 6px; align-items: center; padding: 3px 0; font-size: 12px;
}
.snippets .none { color: #5a6578; font-style: italic; font-size: 12px; margin: 0; }
.sid { color: #e8c87a; }
.meta { color: #8a93a4; font-size: 11px; }
.src { color: #5a6578; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button.rm { padding: 0; width: 22px; height: 22px; font-size: 14px; line-height: 1; }
details { margin-top: 8px; font-size: 12px; }
details pre { background: #0e1014; padding: 8px; border-radius: 4px; overflow-x: auto; font-size: 11px; max-height: 180px; overflow-y: auto; }
.inv-list { list-style: none; padding: 4px 0 0; margin: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 2px 12px; max-height: 180px; overflow-y: auto; }
.inv-list li { display: flex; justify-content: space-between; font-size: 11px; padding: 1px 0; }
.inv-name { color: #b8c2d2; }
.inv-count { color: #e8c87a; font-variant-numeric: tabular-nums; }
</style>
