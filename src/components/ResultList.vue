<script setup lang="ts">
import { computed } from 'vue'
import type { GameItem } from '../types'
import ItemPortrait from './ItemPortrait.vue'

const props = defineProps<{ title: string; items: (string | undefined)[]; source: GameItem[] }>()
const entries = computed(() => props.items.map((id) => props.source.find((item) => item.id === id)))
</script>

<template>
  <div class="result-list">
    <span>{{ title }}</span>
    <div class="result-entries">
      <div v-for="(item, index) in entries" :key="item?.id || index" class="result-entry">
        <ItemPortrait :item="item" eager />
        <strong>{{ item?.name || '未选择' }}</strong>
      </div>
      <span v-if="!entries.length">未选择</span>
    </div>
  </div>
</template>
