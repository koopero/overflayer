<template>
  <div class="app">
    <header class="topbar">
      <h1>Overflayer</h1>
      <div class="status">
        <span :class="['dot', connected ? 'ok' : 'bad']" /> {{ connected ? 'live' : 'disconnected' }}
      </div>
    </header>
    <main>
      <NuxtPage />
    </main>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, provide } from 'vue'

const players = ref([])
const events = ref([])
const connected = ref(false)
let es = null
let pollTimer = null

async function refresh () {
  try {
    const data = await $fetch('/api/players')
    players.value = data
  } catch (_) {}
}

function connectEvents () {
  es = new EventSource('/api/events')
  es.onopen = () => { connected.value = true }
  es.onerror = () => { connected.value = false }
  es.onmessage = (m) => {
    try {
      const evt = JSON.parse(m.data)
      events.value.push(evt)
      if (events.value.length > 300) events.value.splice(0, events.value.length - 300)
      refresh()
    } catch (_) {}
  }
}

onMounted(() => {
  refresh()
  connectEvents()
  pollTimer = setInterval(refresh, 3000)
})
onBeforeUnmount(() => {
  if (es) es.close()
  if (pollTimer) clearInterval(pollTimer)
})

provide('players', players)
provide('events', events)
provide('refresh', refresh)
</script>

<style>
* { box-sizing: border-box; }
html, body, #__nuxt { margin: 0; padding: 0; height: 100%; }
body {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: #0e1014;
  color: #d8e0ea;
}
.app { display: flex; flex-direction: column; min-height: 100vh; }
.topbar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 20px; background: #14171d; border-bottom: 1px solid #232833;
}
.topbar h1 { font-size: 18px; margin: 0; letter-spacing: 1px; color: #f0f3f8; }
.status { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #8a93a4; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: #555; }
.dot.ok { background: #41d27c; }
.dot.bad { background: #d24166; }
main { padding: 18px 20px; flex: 1; }
button {
  font-family: inherit; font-size: 13px;
  background: #2a3140; color: #d8e0ea; border: 1px solid #3a4356;
  padding: 6px 12px; border-radius: 4px; cursor: pointer;
}
button:hover { background: #34405a; }
button:disabled { opacity: 0.4; cursor: not-allowed; }
input, select, textarea {
  font-family: inherit; font-size: 13px;
  background: #1a1f29; color: #d8e0ea; border: 1px solid #2c3445;
  padding: 6px 10px; border-radius: 4px;
}
textarea { width: 100%; min-height: 140px; resize: vertical; }
label { display: block; font-size: 11px; color: #8a93a4; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
.row { display: flex; gap: 12px; flex-wrap: wrap; }
.card { background: #14171d; border: 1px solid #232833; border-radius: 6px; padding: 14px; }
</style>
