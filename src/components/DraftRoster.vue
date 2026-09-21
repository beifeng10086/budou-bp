<script setup lang="ts">
import { computed } from 'vue'
import { Ban } from '@lucide/vue'
import ItemPortrait from './ItemPortrait.vue'
import type { DataPackage, RoundState, Seat } from '../types'

const props = defineProps<{ seat: Seat; round: RoundState; data: DataPackage; active: boolean; mine: boolean }>()
const rows = computed(() => [
  { label: '出战忍者', kind: 'ninja', ids: props.round.picks[props.seat], pool: props.data.ninjas },
  { label: '秘卷', kind: 'scroll', ids: props.round.scrolls[props.seat], pool: props.data.scrolls },
  { label: '通灵', kind: 'summon', ids: props.round.summons[props.seat], pool: props.data.summons },
])
</script>

<template>
  <aside class="draft-roster" :class="[seat, { active }]" :aria-label="`${seat === 'blue' ? '1P' : '2P'}阵容`">
    <header class="roster-heading"><strong>{{ seat === 'blue' ? '1P' : '2P' }}</strong><span>{{ mine ? '我方' : '对战方' }}</span><i>{{ active ? '选择中' : '等待' }}</i></header>
    <div class="roster-bans">
      <span>禁用</span>
      <div v-for="slot in 2" :key="slot" class="ban-slot" :title="data.ninjas.find(item => item.id === round.bans[seat][slot - 1])?.name || '待禁用'">
        <ItemPortrait v-if="round.bans[seat][slot - 1]" :item="data.ninjas.find(item => item.id === round.bans[seat][slot - 1])" eager />
        <Ban :size="16" />
      </div>
    </div>
    <section v-for="row in rows" :key="row.kind" class="roster-group" :class="row.kind">
      <h3>{{ row.label }}<span>{{ row.ids.length }}/3</span></h3>
      <ol>
        <li v-for="slot in 3" :key="slot" :class="{ filled: row.ids[slot - 1] }">
          <ItemPortrait v-if="row.ids[slot - 1]" :item="row.pool.find(item => item.id === row.ids[slot - 1])" eager />
          <span v-else class="empty-slot">{{ row.kind === 'ninja' ? slot : '+' }}</span>
          <strong>{{ row.pool.find(item => item.id === row.ids[slot - 1])?.name || '待选择' }}</strong>
        </li>
      </ol>
    </section>
  </aside>
</template>
