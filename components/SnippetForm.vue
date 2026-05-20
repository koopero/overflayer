<template>
  <div class="card form">
    <h3>Load snippet</h3>
    <div class="target">
      <label>Target</label>
      <div class="row">
        <button :class="{ active: mode === 'selected' }" @click="mode = 'selected'">
          Selected ({{ selected.length }})
        </button>
        <button :class="{ active: mode === 'all' }" @click="mode = 'all'">
          All ({{ players.length }})
        </button>
      </div>
    </div>

    <div class="field">
      <label>Snippet ID</label>
      <input v-model="snippetId" placeholder="e.g. goto-spawn" />
    </div>

    <div class="field">
      <label>Code</label>
      <textarea v-model="code" placeholder="// snippet code — bot, sleep, run, report, signal, Vec3, GoalNear, ..." />
    </div>

    <div class="examples">
      <label>Quick presets</label>
      <div class="row">
        <button v-for="ex in examples" :key="ex.name" @click="loadExample(ex)">{{ ex.name }}</button>
      </div>
    </div>

    <div class="actions">
      <button class="primary" :disabled="!canSubmit" @click="submit">Load</button>
      <button :disabled="!snippetId" @click="unloadAll">Unload by ID</button>
      <span v-if="status" :class="['status-line', statusKind]">{{ status }}</span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'

const props = defineProps({
  players: { type: Array, required: true },
  selected: { type: Array, required: true }
})
const emit = defineEmits(['loaded', 'unloaded'])

const mode = ref('selected')
const snippetId = ref('')
const code = ref('')
const status = ref('')
const statusKind = ref('')

const canSubmit = computed(() => {
  if (!snippetId.value || !code.value.trim()) return false
  if (mode.value === 'selected' && props.selected.length === 0) return false
  return true
})

const examples = [
  {
    name: 'announce',
    id: 'web-announce',
    code: `bot.chat('hello from web')\nreport({ kind: 'greeting', at: bot.entity.position })`
  },
  {
    name: 'heartbeat',
    id: 'web-heartbeat',
    code: `interval(5000, () => {\n  report({ kind: 'heartbeat', pos: bot.entity.position, food: bot.food })\n})`
  },
  {
    name: 'goto-spawn',
    id: 'web-goto-spawn',
    code: `run(async () => {\n  if (!bot.pathfinder || !GoalNear) { report('no pathfinder'); return }\n  const sp = bot.spawnPoint || new Vec3(0, 64, 0)\n  await bot.pathfinder.goto(new GoalNear(sp.x, sp.y, sp.z, 2))\n  report({ kind: 'arrived', at: bot.entity.position })\n})`
  },
  {
    name: 'follow-me',
    id: 'web-follow',
    code: `bot.on('chat', (u, m) => {\n  if (m !== 'follow') return\n  run(async () => {\n    const p = bot.players[u]; if (!p?.entity) return bot.chat("can't see you")\n    if (!bot.pathfinder || !GoalFollow) return bot.chat('no pathfinder')\n    bot.pathfinder.setGoal(new GoalFollow(p.entity, 2), true)\n    report({ kind: 'following', who: u })\n  })\n})`
  }
]

function loadExample (ex) { snippetId.value = ex.id; code.value = ex.code }

function fill (id, codeText) {
  snippetId.value = id
  code.value = codeText
  status.value = ''
}
defineExpose({ fill })

async function submit () {
  const targets = mode.value === 'all' ? 'all' : props.selected
  status.value = ''
  try {
    const res = await $fetch('/api/snippets', {
      method: 'POST',
      body: { targets, id: snippetId.value, code: code.value }
    })
    const ok = res.results.filter(r => r.ok).length
    const bad = res.results.length - ok
    statusKind.value = bad ? 'warn' : 'ok'
    status.value = `loaded on ${ok}/${res.results.length}${bad ? ' — ' + res.results.filter(r => !r.ok).map(r => r.username + ': ' + r.error).join('; ') : ''}`
    emit('loaded')
  } catch (err) {
    statusKind.value = 'err'
    status.value = `error: ${err.data?.message || err.message}`
  }
}

async function unloadAll () {
  const targets = mode.value === 'all' ? 'all' : props.selected
  try {
    const res = await $fetch('/api/snippets', {
      method: 'DELETE',
      body: { targets, id: snippetId.value }
    })
    const ok = res.results.filter(r => r.ok).length
    statusKind.value = ok ? 'ok' : 'warn'
    status.value = `unloaded on ${ok}/${res.results.length}`
    emit('unloaded')
  } catch (err) {
    statusKind.value = 'err'
    status.value = `error: ${err.data?.message || err.message}`
  }
}
</script>

<style scoped>
h3 { margin: 0 0 12px 0; color: #f0f3f8; font-size: 14px; }
.field { margin-bottom: 12px; }
.field input, .field textarea { width: 100%; }
.target { margin-bottom: 12px; }
.target button { background: #1a1f29; }
.target button.active { background: #2c3a52; border-color: #41d27c; color: #f0f3f8; }
.examples { margin-bottom: 12px; }
.examples button { background: #1a1f29; font-size: 12px; }
.actions { display: flex; align-items: center; gap: 12px; }
button.primary { background: #2c5a3a; border-color: #41d27c; color: #f0f3f8; }
button.primary:hover { background: #346e48; }
button.primary:disabled { background: #2a3140; border-color: #3a4356; color: #5a6578; }
.status-line { font-size: 12px; }
.status-line.ok { color: #41d27c; }
.status-line.warn { color: #e8c87a; }
.status-line.err { color: #d24166; }
textarea {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px; line-height: 1.5;
}
</style>
