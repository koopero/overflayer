<template>
  <div class="card library">
    <header>
      <h3>Library ({{ items.length }})</h3>
      <button class="refresh" @click="load" title="Refresh">↻</button>
    </header>
    <p v-if="!items.length" class="empty">No snippets loaded yet.</p>
    <ul v-else>
      <li v-for="item in items" :key="item.id" :class="{ open: open === item.id }">
        <header @click="toggle(item)">
          <span class="sid">{{ item.id }}</span>
          <span class="src">{{ shortSource(item.source) }}</span>
          <span class="on">on {{ item.loadedOn.length }} bot{{ item.loadedOn.length === 1 ? '' : 's' }}</span>
        </header>
        <div v-if="open === item.id" class="detail">
          <div class="meta">
            <span v-for="u in item.loadedOn" :key="u" class="chip">{{ u }}</span>
          </div>
          <pre>{{ item.code }}</pre>
          <div class="actions">
            <button @click="$emit('edit', item)">Edit in form</button>
            <button :disabled="!selected.length" @click="apply(item, 'selected')">
              Reuse on selected ({{ selected.length }})
            </button>
            <button @click="apply(item, 'all')">Reuse on all</button>
            <button class="danger" @click="unloadAll(item)">Unload everywhere</button>
            <span v-if="item.status" :class="['status-line', item.statusKind]">{{ item.status }}</span>
          </div>
        </div>
      </li>
    </ul>
  </div>
</template>

<script setup>
import { ref, onMounted, watch, inject } from 'vue'

const props = defineProps({
  selected: { type: Array, required: true }
})
const emit = defineEmits(['edit', 'changed'])

const events = inject('events')
const items = ref([])
const open = ref(null)

async function load () {
  try {
    items.value = await $fetch('/api/library')
  } catch (_) {}
}

onMounted(load)

// Refresh whenever a load/unload/reload event arrives on the SSE stream.
watch(events, (arr) => {
  const last = arr[arr.length - 1]
  if (!last) return
  if (['load', 'unload', 'reload'].includes(last.type)) load()
}, { deep: true, flush: 'post' })

function toggle (item) { open.value = open.value === item.id ? null : item.id }
function shortSource (s) {
  if (!s) return ''
  if (s === '<inline>') return '<inline>'
  return s.split('/').slice(-2).join('/')
}

async function apply (item, mode) {
  item.status = ''
  const targets = mode === 'all' ? 'all' : props.selected
  try {
    const res = await $fetch('/api/snippets', {
      method: 'POST',
      body: { targets, id: item.id, code: item.code }
    })
    const ok = res.results.filter(r => r.ok).length
    item.statusKind = ok === res.results.length ? 'ok' : 'warn'
    item.status = `loaded on ${ok}/${res.results.length}`
    emit('changed')
    load()
  } catch (err) {
    item.statusKind = 'err'
    item.status = `error: ${err.data?.message || err.message}`
  }
}

async function unloadAll (item) {
  item.status = ''
  try {
    const res = await $fetch('/api/snippets', {
      method: 'DELETE',
      body: { targets: 'all', id: item.id }
    })
    const ok = res.results.filter(r => r.ok).length
    item.statusKind = ok ? 'ok' : 'warn'
    item.status = `unloaded on ${ok}/${res.results.length}`
    emit('changed')
    load()
  } catch (err) {
    item.statusKind = 'err'
    item.status = `error: ${err.data?.message || err.message}`
  }
}
</script>

<style scoped>
header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
h3 { margin: 0; color: #f0f3f8; font-size: 14px; }
.refresh { padding: 2px 8px; font-size: 12px; }
.empty { color: #5a6578; font-style: italic; font-size: 12px; margin: 0; }
ul { list-style: none; padding: 0; margin: 0; }
li {
  border: 1px solid #232833; border-radius: 4px; margin-bottom: 6px; overflow: hidden;
}
li > header {
  display: grid; grid-template-columns: 1.5fr 1.2fr 80px; gap: 8px; align-items: center;
  padding: 6px 10px; margin: 0; cursor: pointer; user-select: none;
}
li > header:hover { background: #1a1f29; }
li.open > header { background: #1a1f29; }
.sid { color: #e8c87a; font-size: 12px; }
.src { color: #5a6578; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.on { color: #8a93a4; font-size: 11px; text-align: right; }
.detail { padding: 10px; border-top: 1px solid #232833; background: #0e1014; }
.meta { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 8px; }
.chip {
  font-size: 10px; padding: 2px 6px; border-radius: 10px;
  background: #1a4030; color: #41d27c;
}
pre {
  background: #14171d; padding: 8px; border-radius: 4px;
  font-size: 11px; max-height: 160px; overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #d8e0ea; margin: 0 0 8px 0;
}
.actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.actions button { font-size: 11px; padding: 4px 8px; }
.actions .danger { background: #401a26; border-color: #d24166; color: #d24166; }
.status-line { font-size: 11px; }
.status-line.ok { color: #41d27c; }
.status-line.warn { color: #e8c87a; }
.status-line.err { color: #d24166; }
</style>
