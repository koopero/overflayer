<template>
  <li :class="{ open: isOpen }">
    <header @click="$emit('toggle')">
      <span class="sid">{{ item.id }}</span>
      <span class="src">{{ shortSource(item.source) }}</span>
      <span class="on">on {{ item.loadedOn.length }} bot{{ item.loadedOn.length === 1 ? '' : 's' }}</span>
    </header>
    <div v-if="isOpen" class="detail">
      <div v-if="item.loadedOn.length" class="meta">
        <span v-for="u in item.loadedOn" :key="u" class="chip">{{ u }}</span>
      </div>
      <pre>{{ item.code }}</pre>
      <div class="actions">
        <button @click="$emit('edit')">Edit in form</button>
        <button :disabled="!selected.length" @click="$emit('apply', item, 'selected')">
          Apply to selected ({{ selected.length }})
        </button>
        <button @click="$emit('apply', item, 'all')">Apply to all</button>
        <button v-if="item.loadedOn.length" class="danger" @click="$emit('unload-all', item)">Unload everywhere</button>
        <span v-if="item.status" :class="['status-line', item.statusKind]">{{ item.status }}</span>
      </div>
      <div v-if="item.kind === 'inline' && writableDirs.length" class="save-row">
        <label>Save to:</label>
        <select v-model="item.saveDir">
          <option v-for="d in writableDirs" :key="d.path" :value="d.path">{{ d.path }}</option>
        </select>
        <button @click="$emit('save', item)" :disabled="!item.saveDir">Save</button>
      </div>
    </div>
  </li>
</template>

<script setup>
const props = defineProps({
  item: { type: Object, required: true },
  selected: { type: Array, required: true },
  writableDirs: { type: Array, required: true },
  isOpen: { type: Boolean, default: false }
})
defineEmits(['toggle', 'edit', 'apply', 'unload-all', 'save'])

function shortSource (s) {
  if (!s) return ''
  if (s === '<inline>') return '<inline>'
  return s.split('/').slice(-2).join('/')
}
</script>

<style scoped>
li { border: 1px solid #232833; border-radius: 4px; margin-bottom: 6px; overflow: hidden; }
header { display: grid; grid-template-columns: 1.5fr 1.2fr 80px; gap: 8px; align-items: center; padding: 6px 10px; margin: 0; cursor: pointer; user-select: none; }
header:hover { background: #1a1f29; }
li.open > header { background: #1a1f29; }
.sid { color: #e8c87a; font-size: 12px; }
.src { color: #5a6578; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.on { color: #8a93a4; font-size: 11px; text-align: right; }
.detail { padding: 10px; border-top: 1px solid #232833; background: #0e1014; }
.meta { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 8px; }
.chip { font-size: 10px; padding: 2px 6px; border-radius: 10px; background: #1a4030; color: #41d27c; }
pre { background: #14171d; padding: 8px; border-radius: 4px; font-size: 11px; max-height: 160px; overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #d8e0ea; margin: 0 0 8px 0; }
.actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.actions button { font-size: 11px; padding: 4px 8px; }
.actions .danger { background: #401a26; border-color: #d24166; color: #d24166; }
.save-row { display: flex; gap: 6px; align-items: center; margin-top: 8px; padding-top: 6px; border-top: 1px dashed #232833; }
.save-row label { font-size: 11px; color: #8a93a4; margin: 0; text-transform: none; letter-spacing: 0; }
.save-row select { font-size: 11px; padding: 2px 6px; flex: 1; }
.save-row button { font-size: 11px; padding: 4px 8px; }
.status-line { font-size: 11px; }
.status-line.ok { color: #41d27c; }
.status-line.warn { color: #e8c87a; }
.status-line.err { color: #d24166; }
</style>
