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
          <div class="row1">
            <span class="sid">{{ s.id }}</span>
            <span class="meta">{{ s.listenerCount }}L · {{ s.pendingTasks }}T · {{ s.reportCount }}R</span>
            <span class="src" :title="s.source">{{ shortSource(s.source) }}</span>
            <button class="rm" @click.stop="unload(s.id)">×</button>
          </div>
          <div v-if="exportedKeys(s).length" class="state">
            <div v-for="k in exportedKeys(s)" :key="k" class="state-row" @click.stop>
              <label>{{ k }}</label>
              <select v-if="s.state[k].type === 'player'"
                      :value="s.state[k].value ?? ''"
                      @change="setState(s.id, k, $event.target.value)">
                <option value="">(none)</option>
                <option v-for="u in player.knownPlayers || []" :key="u" :value="u">{{ u }}</option>
              </select>
              <input v-else-if="s.state[k].type === 'boolean'"
                     type="checkbox"
                     :checked="!!s.state[k].value"
                     @change="setState(s.id, k, $event.target.checked)" />
              <input v-else-if="s.state[k].type === 'number'"
                     type="number"
                     :value="s.state[k].value ?? ''"
                     @change="setState(s.id, k, Number($event.target.value))" />
              <input v-else
                     type="text"
                     :value="stateInputDrafts[s.id + ':' + k] ?? formatStateValue(s.state[k])"
                     @focus="stateInputDrafts[s.id + ':' + k] = formatStateValue(s.state[k])"
                     @input="stateInputDrafts[s.id + ':' + k] = $event.target.value"
                     @change="setStateFromText(s.id, k, s.state[k].type, $event.target.value)"
                     @blur="delete stateInputDrafts[s.id + ':' + k]" />
              <span v-if="stateStatus[s.id + ':' + k]" :class="['state-status', stateStatus[s.id + ':' + k].kind]">
                {{ stateStatus[s.id + ':' + k].msg }}
              </span>
            </div>
          </div>
        </li>
      </ul>
      <p v-else class="none">none</p>
    </div>
    <details class="preconfigure-details">
      <summary>Pre-configure</summary>
      <div class="preconfigure" @click.stop>
        <!-- Pending state: snippets that have pre-configured values but aren't loaded -->
        <template v-if="pendingSnippetIds.length">
          <div v-for="snippetId in pendingSnippetIds" :key="snippetId" class="pending-group">
            <div class="pending-header">
              <span class="pending-id">{{ snippetId }}</span>
              <span class="pending-label">pre-configured</span>
            </div>
            <div class="state">
              <div
                v-for="(val, key) in player.pendingState[snippetId]"
                :key="key"
                class="state-row"
              >
                <label>{{ key }}</label>
                <input
                  type="text"
                  :value="stateInputDrafts[snippetId + ':' + key] ?? formatPendingValue(val)"
                  @focus="stateInputDrafts[snippetId + ':' + key] = formatPendingValue(val)"
                  @input="stateInputDrafts[snippetId + ':' + key] = $event.target.value"
                  @change="setStateFromText(snippetId, key, guessPendingType(val), $event.target.value)"
                  @blur="delete stateInputDrafts[snippetId + ':' + key]"
                />
                <span v-if="stateStatus[snippetId + ':' + key]" :class="['state-status', stateStatus[snippetId + ':' + key].kind]">
                  {{ stateStatus[snippetId + ':' + key].msg }}
                </span>
              </div>
            </div>
          </div>
        </template>

        <!-- New pre-configuration form -->
        <div class="new-preconfig">
          <div class="preconfig-row">
            <label>Snippet</label>
            <select v-model="preconfigSnippetId" @click.stop>
              <option value="">(select snippet)</option>
              <option v-for="entry in configurableSnippets" :key="entry.id" :value="entry.id">
                {{ entry.id }}
              </option>
            </select>
          </div>
          <template v-if="preconfigSnippetId && preconfigSchema">
            <div
              v-for="(type, key) in preconfigSchema"
              :key="key"
              class="state-row"
            >
              <label>{{ key }}</label>
              <select v-if="type === 'player'"
                      :value="preconfigDrafts[key] ?? ''"
                      @change="preconfigDrafts[key] = $event.target.value">
                <option value="">(none)</option>
                <option v-for="u in player.knownPlayers || []" :key="u" :value="u">{{ u }}</option>
              </select>
              <input v-else-if="type === 'boolean'"
                     type="checkbox"
                     :checked="!!preconfigDrafts[key]"
                     @change="preconfigDrafts[key] = $event.target.checked" />
              <input v-else-if="type === 'number'"
                     type="number"
                     :value="preconfigDrafts[key] ?? ''"
                     @input="preconfigDrafts[key] = $event.target.value" />
              <input v-else
                     type="text"
                     :value="preconfigDrafts[key] ?? ''"
                     @input="preconfigDrafts[key] = $event.target.value" />
              <span v-if="stateStatus['preconfig:' + key]" :class="['state-status', stateStatus['preconfig:' + key].kind]">
                {{ stateStatus['preconfig:' + key].msg }}
              </span>
            </div>
            <button class="apply-btn" @click.stop="applyPreconfig">Apply</button>
          </template>
        </div>
      </div>
    </details>

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
import { computed, ref, watch } from 'vue'

const props = defineProps({
  player: { type: Object, required: true },
  selected: { type: Boolean, default: false },
  catalog: { type: Array, default: () => [] }
})
const emit = defineEmits(['toggle', 'changed'])

const showView = ref(false)
const stateStatus = ref({})
const stateInputDrafts = ref({})

// Pre-configure state
const preconfigSnippetId = ref('')
const preconfigDrafts = ref({})

// Reset drafts when the selected snippet changes
watch(preconfigSnippetId, () => { preconfigDrafts.value = {} })

// Parse stateConfigure calls from snippet source code to discover state keys and types
function parseSnippetState (code) {
  const schema = {}
  const re = /stateConfigure\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*\{([^}]+)\}/g
  for (const m of (code || '').matchAll(re)) {
    const typeMatch = m[2].match(/type\s*:\s*['"`]([^'"`]+)['"`]/)
    schema[m[1]] = typeMatch ? typeMatch[1] : 'string'
  }
  return schema
}

// Catalog entries that have at least one stateConfigure declaration
const configurableSnippets = computed(() => {
  return props.catalog.filter(entry => {
    const schema = parseSnippetState(entry.code)
    return Object.keys(schema).length > 0
  })
})

// Schema for the currently selected pre-configure snippet
const preconfigSchema = computed(() => {
  if (!preconfigSnippetId.value) return null
  const entry = props.catalog.find(e => e.id === preconfigSnippetId.value)
  if (!entry) return null
  const schema = parseSnippetState(entry.code)
  return Object.keys(schema).length ? schema : null
})

// Snippet IDs that have pending (pre-configured but not loaded) state
const pendingSnippetIds = computed(() => {
  const ps = props.player.pendingState
  if (!ps) return []
  return Object.keys(ps).filter(id => Object.keys(ps[id]).length > 0)
})

function formatPendingValue (val) {
  if (val === undefined || val === null) return ''
  if (val && typeof val === 'object' && 'x' in val && 'y' in val && 'z' in val) {
    return `${val.x},${val.y},${val.z}`
  }
  return String(val)
}

function guessPendingType (val) {
  if (val && typeof val === 'object' && 'x' in val) return 'vec3'
  if (typeof val === 'boolean') return 'boolean'
  if (typeof val === 'number') return 'number'
  return 'string'
}

async function applyPreconfig () {
  const id = preconfigSnippetId.value
  const schema = preconfigSchema.value
  if (!id || !schema) return
  for (const [key, type] of Object.entries(schema)) {
    const raw = preconfigDrafts.value[key]
    if (raw === undefined || raw === '') continue
    const statusKey = 'preconfig:' + key
    try {
      let value = raw
      if (type === 'vec3') {
        const parts = String(raw).split(',').map(s => Number(s.trim()))
        if (parts.length !== 3 || parts.some(n => Number.isNaN(n))) {
          flash(statusKey, 'err', 'expected x,y,z')
          continue
        }
        value = { x: parts[0], y: parts[1], z: parts[2] }
      } else if (type === 'number') {
        value = Number(raw)
      } else if (type === 'boolean') {
        value = !!raw
      }
      await $fetch('/api/state', {
        method: 'POST',
        body: { targets: [props.player.username], id, key, value }
      })
      flash(statusKey, 'ok', '✓')
    } catch (err) {
      flash(statusKey, 'err', err.data?.message || err.message)
    }
  }
  emit('changed')
}

function exportedKeys (snip) {
  if (!snip.state) return []
  return Object.keys(snip.state).filter(k => snip.state[k].exported)
}

function formatStateValue (s) {
  if (s.value === undefined || s.value === null) return ''
  if (s.type === 'vec3' && s.value) return `${s.value.x},${s.value.y},${s.value.z}`
  return String(s.value)
}

function flash (key, kind, msg) {
  stateStatus.value = { ...stateStatus.value, [key]: { kind, msg } }
  setTimeout(() => {
    const next = { ...stateStatus.value }
    delete next[key]
    stateStatus.value = next
  }, 1500)
}

async function setState (snippetId, key, value) {
  const k = `${snippetId}:${key}`
  try {
    await $fetch('/api/state', {
      method: 'POST',
      body: { targets: [props.player.username], id: snippetId, key, value }
    })
    flash(k, 'ok', '✓')
    emit('changed')
  } catch (err) {
    flash(k, 'err', err.data?.message || err.message)
  }
}

function setStateFromText (snippetId, key, type, text) {
  let value = text
  if (type === 'vec3') {
    const parts = text.split(',').map(s => Number(s.trim()))
    if (parts.length !== 3 || parts.some(n => Number.isNaN(n))) {
      flash(`${snippetId}:${key}`, 'err', 'expected x,y,z')
      return
    }
    value = { x: parts[0], y: parts[1], z: parts[2] }
  }
  setState(snippetId, key, value)
}

const sortedInventory = computed(() => {
  const items = props.player.inventory || []
  return [...items].sort((a, b) => b.count - a.count)
})

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
  padding: 3px 0; font-size: 12px;
}
.row1 {
  display: grid; grid-template-columns: 1.4fr 1.4fr 1fr 24px;
  gap: 6px; align-items: center;
}
.state {
  display: flex; flex-direction: column; gap: 4px;
  margin: 4px 0 6px 12px; padding: 6px 8px;
  background: #0e1014; border-left: 2px solid #2c3a52; border-radius: 0 3px 3px 0;
}
.state-row { display: grid; grid-template-columns: 80px 1fr 40px; gap: 6px; align-items: center; }
.state-row label { font-size: 11px; color: #8a93a4; text-transform: none; letter-spacing: 0; margin: 0; }
.state-row input[type="text"], .state-row input[type="number"], .state-row select {
  font-size: 11px; padding: 2px 6px;
}
.state-row input[type="checkbox"] { justify-self: start; }
.state-status { font-size: 11px; }
.state-status.ok { color: #41d27c; }
.state-status.err { color: #d24166; }
.sid { color: #e8c87a; }
.meta { color: #8a93a4; font-size: 11px; }
.src { color: #5a6578; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.snippets .none { color: #5a6578; font-style: italic; font-size: 12px; margin: 0; }
button.rm { padding: 0; width: 22px; height: 22px; font-size: 14px; line-height: 1; }
details { margin-top: 8px; font-size: 12px; }
details pre { background: #0e1014; padding: 8px; border-radius: 4px; overflow-x: auto; font-size: 11px; max-height: 180px; overflow-y: auto; }
.inv-list { list-style: none; padding: 4px 0 0; margin: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 2px 12px; max-height: 180px; overflow-y: auto; }
.inv-list li { display: flex; justify-content: space-between; font-size: 11px; padding: 1px 0; }
.inv-name { color: #b8c2d2; }
.inv-count { color: #e8c87a; font-variant-numeric: tabular-nums; }
.preconfigure-details { margin-top: 8px; font-size: 12px; }
.preconfigure { padding: 6px 0 2px 0; display: flex; flex-direction: column; gap: 8px; }
.pending-group { display: flex; flex-direction: column; gap: 2px; }
.pending-header { display: flex; align-items: center; gap: 8px; padding: 2px 0; }
.pending-id { color: #e8c87a; font-size: 12px; }
.pending-label { font-size: 10px; color: #5a6578; font-style: italic; }
.new-preconfig { display: flex; flex-direction: column; gap: 4px; }
.preconfig-row { display: grid; grid-template-columns: 80px 1fr; gap: 6px; align-items: center; }
.preconfig-row label { font-size: 11px; color: #8a93a4; text-transform: none; letter-spacing: 0; margin: 0; }
.preconfig-row select { font-size: 11px; padding: 2px 6px; }
.apply-btn { align-self: flex-start; margin-top: 4px; font-size: 11px; padding: 3px 10px; }
</style>
