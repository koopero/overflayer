<template>
  <div class="card library">
    <header>
      <h3>Catalog ({{ items.length }})</h3>
      <button class="refresh" @click="load" title="Refresh">↻</button>
    </header>
    <p v-if="!items.length" class="empty">Catalog is empty. Add a `.js` file to a configured snippet_dir, or POST an inline snippet.</p>

    <template v-else>
      <section v-if="fileItems.length">
        <h4>From disk ({{ fileItems.length }})</h4>
        <ul>
          <CatalogEntry
            v-for="item in fileItems"
            :key="item.id"
            :item="item"
            :selected="selected"
            :writable-dirs="writableDirs"
            :is-open="open === item.id"
            @toggle="toggle(item)"
            @edit="$emit('edit', item)"
            @apply="apply"
            @unload-all="unloadAll"
            @save="save"
          />
        </ul>
      </section>

      <section v-if="inlineItems.length">
        <h4>Inline ({{ inlineItems.length }})</h4>
        <ul>
          <CatalogEntry
            v-for="item in inlineItems"
            :key="item.id"
            :item="item"
            :selected="selected"
            :writable-dirs="writableDirs"
            :is-open="open === item.id"
            @toggle="toggle(item)"
            @edit="$emit('edit', item)"
            @apply="apply"
            @unload-all="unloadAll"
            @save="save"
          />
        </ul>
      </section>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch, inject } from 'vue'

const props = defineProps({
  selected: { type: Array, required: true }
})
const emit = defineEmits(['edit', 'changed'])

const events = inject('events')
const items = ref([])
const open = ref(null)
const snippetDirs = ref([])

const writableDirs = computed(() => snippetDirs.value.filter(d => d.writable))
const fileItems = computed(() => items.value.filter(i => i.kind === 'file'))
const inlineItems = computed(() => items.value.filter(i => i.kind === 'inline'))

async function load () {
  try { items.value = await $fetch('/api/catalog') } catch (_) {}
}
async function loadDirs () {
  try { snippetDirs.value = await $fetch('/api/snippet-dirs') } catch (_) {}
}

onMounted(() => { load(); loadDirs() })

const REFRESH_TYPES = new Set([
  'load', 'unload', 'reload',
  'catalog:add', 'catalog:change', 'catalog:remove', 'catalog:conflict'
])
watch(events, (arr) => {
  const last = arr[arr.length - 1]
  if (last && REFRESH_TYPES.has(last.type)) load()
}, { deep: true, flush: 'post' })

function toggle (item) { open.value = open.value === item.id ? null : item.id }

async function apply (item, mode) {
  item.status = ''
  const targets = mode === 'all' ? 'all' : props.selected
  // For file-backed catalog entries, pass the file path so the loaded snippet
  // stays associated with its source (and survives watcher hot-reloads cleanly).
  // For inline entries, send the code blob.
  const code = item.kind === 'file' ? item.source : item.code
  try {
    const res = await $fetch('/api/snippets', {
      method: 'POST',
      body: { targets, id: item.id, code }
    })
    const ok = res.results.filter(r => r.ok).length
    item.statusKind = ok === res.results.length ? 'ok' : 'warn'
    item.status = `applied to ${ok}/${res.results.length}`
    emit('changed'); load()
  } catch (err) {
    item.statusKind = 'err'
    item.status = `error: ${err.data?.message || err.message}`
  }
}

async function save (item) {
  item.status = ''
  try {
    const res = await $fetch('/api/snippets/save', {
      method: 'POST',
      body: { id: item.id, code: item.code, dir: item.saveDir }
    })
    item.statusKind = 'ok'
    item.status = `saved to ${res.path}`
    emit('changed'); load()
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
    emit('changed'); load()
  } catch (err) {
    item.statusKind = 'err'
    item.status = `error: ${err.data?.message || err.message}`
  }
}
</script>

<style scoped>
header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
h3 { margin: 0; color: #f0f3f8; font-size: 14px; }
h4 { margin: 14px 0 6px 0; color: #8a93a4; font-size: 11px; text-transform: uppercase; letter-spacing: 0.6px; font-weight: 600; }
section:first-of-type h4 { margin-top: 0; }
.refresh { padding: 2px 8px; font-size: 12px; }
.empty { color: #5a6578; font-style: italic; font-size: 12px; margin: 0; }
ul { list-style: none; padding: 0; margin: 0; }
</style>
