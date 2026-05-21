<template>
  <div class="grid">
    <section class="left">
      <h2>Players ({{ players.length }})</h2>
      <div class="players">
        <PlayerCard
          v-for="p in players"
          :key="p.username"
          :player="p"
          :catalog="catalog"
          :selected="selected.includes(p.username)"
          @toggle="toggle"
        />
        <p v-if="players.length === 0" class="empty">No players (yet). Check config.yaml and the server log.</p>
      </div>
    </section>

    <section class="right">
      <SnippetForm
        ref="formRef"
        :players="players"
        :selected="selected"
        @loaded="onLoaded"
        @unloaded="onLoaded"
      />
      <SnippetCatalog
        :selected="selected"
        @edit="onEdit"
        @changed="onLoaded"
      />
      <div class="card events">
        <h3>Recent events</h3>
        <ol>
          <li v-for="(e, idx) in recent" :key="idx" :class="['evt', e.type.replace(':', '-')]">
            <span class="ts">{{ new Date(e.ts).toLocaleTimeString() }}</span>
            <span class="type">{{ e.type }}</span>
            <span class="who">{{ e.username || '-' }}</span>
            <span class="rest">{{ summary(e) }}</span>
          </li>
        </ol>
      </div>
    </section>
  </div>
</template>

<script setup>
import { inject, ref, computed, onMounted } from 'vue'

const players = inject('players')
const events = inject('events')
const refresh = inject('refresh')

const catalog = ref([])

async function refreshCatalog () {
  try {
    catalog.value = await $fetch('/api/catalog')
  } catch (_) {}
}

onMounted(refreshCatalog)

const selected = ref([])
const formRef = ref(null)

function onEdit (item) {
  formRef.value?.fill?.(item.id, item.code)
}

function toggle (username) {
  const i = selected.value.indexOf(username)
  if (i >= 0) selected.value.splice(i, 1)
  else selected.value.push(username)
}

function onLoaded () { refresh() }

const recent = computed(() => events.value.slice().reverse().slice(0, 50))

function summary (e) {
  if (e.type === 'report') return `${e.id}: ${typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload)}`
  if (e.type === 'load' || e.type === 'reload') return `${e.id} ← ${e.source}`
  if (e.type === 'unload') return e.id
  if (e.type === 'error' || e.type === 'bot:error') return `${e.id || ''} ${e.message || ''}`
  if (e.type === 'bot:kicked') return e.reason
  if (e.type === 'bot:end') return e.reason
  return ''
}
</script>

<style scoped>
.grid { display: grid; grid-template-columns: 1fr 1.2fr; gap: 20px; }
h2, h3 { margin: 0 0 12px 0; color: #f0f3f8; font-size: 15px; font-weight: 600; letter-spacing: 0.5px; }
.players { display: flex; flex-direction: column; gap: 10px; }
.empty { color: #8a93a4; font-style: italic; }
.right { display: flex; flex-direction: column; gap: 16px; }
.events ol { list-style: none; padding: 0; margin: 0; max-height: 420px; overflow-y: auto; }
.events li {
  display: grid; grid-template-columns: 80px 110px 140px 1fr;
  gap: 10px; padding: 4px 0; font-size: 12px; border-bottom: 1px solid #1d2230;
}
.events .ts { color: #5a6578; }
.events .type { color: #b8c2d2; }
.events .who { color: #e8c87a; }
.events .rest { color: #d8e0ea; overflow-wrap: anywhere; }
.evt.report { background: rgba(65, 210, 124, 0.05); }
.evt.error, .evt.bot-error, .evt.bot-kicked { background: rgba(210, 65, 102, 0.08); }
@media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
</style>
