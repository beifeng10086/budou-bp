<script setup lang="ts">
import { ref, watch } from 'vue'
import type { GameItem } from '../types'

const props = defineProps<{ item?: GameItem; eager?: boolean }>()
const failed = ref(false)
watch(() => props.item?.image, () => { failed.value = false })
</script>

<template>
  <span class="portrait">
    <img v-if="item?.image && !failed" :src="item.image" :alt="item.name" width="80" height="80"
      :loading="eager ? 'eager' : 'lazy'" decoding="async" @error="failed = true" />
    <span v-else class="portrait-fallback" aria-hidden="true">{{ item?.name.slice(0, 1) || '?' }}</span>
  </span>
</template>
