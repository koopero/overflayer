<template>
  <div class="backdrop" @click.self="$emit('close')">
    <div class="modal">
      <header>
        <h3>{{ player.username }} — first-person view</h3>
        <div class="actions">
          <a v-if="url" class="open-link" :href="url" target="_blank" rel="noopener">Open in new tab</a>
          <button @click="$emit('close')">×</button>
        </div>
      </header>
      <div class="frame">
        <iframe
          v-if="url"
          ref="frameRef"
          :src="url"
          frameborder="0"
          allow="autoplay; fullscreen"
        />
        <p v-else class="empty">No viewer available for this bot. Is <code>prismarine-viewer</code> installed?</p>
      </div>
      <footer>
        <p class="hint">
          Live view via <code>prismarine-viewer</code> on port {{ player.viewerPort }}.
          For a PNG, use your OS screenshot tool (⌘⇧4 / Win+Shift+S) on the frame above.
        </p>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  player: { type: Object, required: true }
})
defineEmits(['close'])

const frameRef = ref(null)

const url = computed(() => {
  if (!props.player.viewerPort) return null
  const host = window.location.hostname
  return `http://${host}:${props.player.viewerPort}/`
})
</script>

<style scoped>
.backdrop {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6);
  display: flex; align-items: center; justify-content: center; z-index: 1000;
}
.modal {
  background: #14171d; border: 1px solid #232833; border-radius: 8px;
  width: min(880px, 92vw); max-height: 90vh; display: flex; flex-direction: column;
  overflow: hidden;
}
header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px; border-bottom: 1px solid #232833;
}
header h3 { margin: 0; font-size: 14px; color: #f0f3f8; }
.actions { display: flex; align-items: center; gap: 10px; }
.open-link { color: #e8c87a; font-size: 12px; text-decoration: none; }
.open-link:hover { text-decoration: underline; }
button { padding: 2px 10px; font-size: 16px; line-height: 1; }
.frame {
  flex: 1; min-height: 0; background: #000;
  display: flex; align-items: stretch;
}
.frame iframe { width: 100%; height: 540px; max-height: 70vh; display: block; }
.empty { color: #d24166; padding: 20px; margin: 0; }
footer {
  padding: 8px 14px; border-top: 1px solid #232833;
  background: #0e1014;
}
.hint { margin: 0; color: #8a93a4; font-size: 11px; }
code { background: #1a1f29; padding: 1px 4px; border-radius: 3px; color: #e8c87a; font-size: 11px; }
</style>
