<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Check, ChevronLeft, ChevronRight, Search, X } from '@lucide/vue'
import type { GameItem, MatchState, RoomRole, Seat } from '../types'
import { canSelectNinja, canSelectTimedItem, playerName } from '../bp'
import { sortNinjas } from '../catalog'
import ItemPortrait from './ItemPortrait.vue'
import NinjaArtwork from './NinjaArtwork.vue'

const props = defineProps<{ match: MatchState; seconds: number; online: boolean; seat: RoomRole; wins: Record<Seat, number>; artworks: GameItem[]; portrait: boolean; landscape: boolean }>()
const emit = defineEmits<{ choose: [id: string, seat: Seat, timed: boolean]; batch: [ids: string[], seat: Seat, phase: 'scroll' | 'summon', round: number] }>()
const search = ref('')
const rank = ref('')
const page = ref(0)
const preview = ref<GameItem | undefined>()
const activeSeat = ref<Seat>('blue')
const searchOpen = ref(false)
const searchInput = ref<HTMLInputElement | null>(null)
const devicePortrait = ref(matchMedia('(orientation: portrait)').matches)
const orientationQuery = matchMedia('(orientation: portrait)')
const updateOrientation = () => { devicePortrait.value = orientationQuery.matches }
onMounted(() => orientationQuery.addEventListener('change', updateOrientation))
onBeforeUnmount(() => orientationQuery.removeEventListener('change', updateOrientation))
const rotated = computed(() => props.landscape && devicePortrait.value)
const spectating = computed(() => props.online && props.seat === 'host')
const drafts = ref<Record<Seat, (string | null)[]>>({ blue: [null, null, null], red: [null, null, null] })
const phase = computed(() => props.match.current.phase)
const timed = computed(() => phase.value.kind === 'scroll' || phase.value.kind === 'summon')
const operator = computed<Seat>(() => timed.value ? props.online ? props.seat === 'red' ? 'red' : 'blue' : activeSeat.value : phase.value.turn ?? 'blue')
const pool = computed(() => phase.value.kind === 'scroll' ? props.match.data.scrolls : phase.value.kind === 'summon' ? props.match.data.summons : sortNinjas(props.match.data.ninjas))
const filtered = computed(() => pool.value.filter(item => (!search.value.trim() || [item.name, ...(item.aliases ?? [])].some(name => name.toLowerCase().includes(search.value.trim().toLowerCase()))) && (timed.value || !rank.value || item.rank === rank.value)))
const perPage = computed(() => props.portrait ? 12 : 20)
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / perPage.value)))
const visible = computed(() => filtered.value.slice(page.value * perPage.value, (page.value + 1) * perPage.value))
const stageTitle = computed(() => ({ ban: '禁用忍者', pick: '选择忍者', scroll: '选择秘卷', summon: '选择通灵', complete: '阵容完成' })[phase.value.kind])
const canConfirm = computed(() => !spectating.value && (timed.value
  ? selection(operator.value).length === 0 && drafts.value[operator.value].every(id => id && available(pool.value.find(item => item.id === id)!))
  : !!preview.value && available(preview.value)))
watch([search, rank, perPage], () => { page.value = 0 })
watch(() => props.match.current.number + ':' + phase.value.kind, () => { drafts.value = { blue: [null, null, null], red: [null, null, null] }; activeSeat.value = 'blue' })
watch(() => props.match.current.phase.kind, () => { search.value = ''; rank.value = ''; page.value = 0 })
watch(() => [props.match.current.number, phase.value.kind, phase.value.index, props.seat, activeSeat.value], () => { preview.value = undefined })
watch(() => props.match.current, () => { if (preview.value && !available(preview.value)) preview.value = undefined })

function selection(seat: Seat): string[] {
  const round = props.match.current
  return phase.value.kind === 'ban' ? round.bans[seat] : phase.value.kind === 'scroll' ? round.scrolls[seat] : phase.value.kind === 'summon' ? round.summons[seat] : round.picks[seat]
}
function available(item?: GameItem) {
  if (spectating.value || !item || (!props.match.settings.noTimer && props.seconds <= 0)) return false
  if (timed.value) return selection(operator.value).length === 0 && canSelectTimedItem(props.match, item.id, operator.value)
  return (!props.online || props.seat === phase.value.turn) && canSelectNinja(props.match, item.id)
}
function state(item: GameItem): string {
  const round = props.match.current
  if (!timed.value) {
    if ([...round.bans.blue, ...round.bans.red].includes(item.id)) return '已禁'
    if (round.picks.blue.includes(item.id)) return '1P'
    if (round.picks.red.includes(item.id)) return '2P'
    if (!canSelectNinja(props.match, item.id)) return '已用'
  } else {
    if (selection(operator.value).includes(item.id)) return '已确认'
    const position = drafts.value[operator.value].indexOf(item.id)
    if (position >= 0) return (position + 1) + '号位'
    if (!canSelectTimedItem(props.match, item.id, operator.value)) return '已用'
  }
  return ''
}
function slotItem(seat: Seat, index: number) {
  if (timed.value) return props.match.data.ninjas.find(item => item.id === props.match.current.picks[seat][index])
  const id = selection(seat)[index]
  if (id) return pool.value.find(item => item.id === id)
  if (seat === operator.value && selection(seat).length === index) return preview.value
}
function timedItem(seat: Seat, index: number) {
  const id = selection(seat)[index] ?? drafts.value[seat][index]
  return pool.value.find(item => item.id === id)
}
function count(seat: Seat) {
  return selection(seat).length || drafts.value[seat].filter(Boolean).length
}
function select(item: GameItem) {
  if (!available(item)) return
  if (!timed.value) { preview.value = item; return }
  const draft = drafts.value[operator.value]
  const selected = draft.indexOf(item.id)
  const position = selected >= 0 ? selected : draft.indexOf(null)
  if (position >= 0) draft[position] = selected >= 0 ? null : item.id
}
function cancelSlot(seat: Seat, index: number) {
  if (!spectating.value && seat === operator.value && !selection(seat).length && (props.match.settings.noTimer || props.seconds > 0)) drafts.value[seat][index] = null
}
async function openSearch() {
  if (!rotated.value) return
  searchOpen.value = true
  await nextTick()
  searchInput.value?.focus()
}
function closeSearch() { searchInput.value?.blur(); searchOpen.value = false }
function artwork(item?: GameItem): string | undefined {
  if (!item) return undefined
  return item.artwork ?? (item.officialId ? props.artworks.find(other => other.officialId === item.officialId)?.artwork : undefined)
}
function confirm() {
  if (!canConfirm.value) return
  if (timed.value) emit('batch', [...drafts.value[operator.value]] as string[], operator.value, phase.value.kind as 'scroll' | 'summon', props.match.current.number)
  else if (preview.value) { emit('choose', preview.value.id, operator.value, false); preview.value = undefined }
}
</script>

<template>
  <section class="arena-board">
    <div class="arena-scoreboard">
      <div v-for="seat in (['blue', 'red'] as const)" :key="seat" class="arena-player" :class="seat"><span class="seat-badge">{{ seat === 'blue' ? '1P' : '2P' }}</span><strong :title="playerName(match, seat)">{{ playerName(match, seat) }}</strong><b>{{ wins[seat] }}</b></div>
      <div class="stage-status"><strong>{{ timed ? '' : (phase.turn === 'blue' ? '1P ' : '2P ') }}{{ stageTitle }}</strong><div class="arena-timer" :class="{ urgent: !match.settings.noTimer && seconds <= 10, untimed: match.settings.noTimer }">{{ match.settings.noTimer ? '无计时' : seconds }}<small v-if="!match.settings.noTimer">s</small></div></div>
    </div>
    <div class="artwork-stage" :class="{ 'ban-stage': phase.kind === 'ban', 'timed-stage': timed }">
      <div v-for="seat in (['blue', 'red'] as const)" :key="seat" class="artwork-side" :class="seat" :aria-label="(seat === 'blue' ? '1P' : '2P') + '阵容'">
        <div v-for="(_, index) in Array.from({ length: phase.kind === 'ban' ? 2 : 3 })" :key="index" class="artwork-slot" :data-position="index + 1" :style="{ order: seat === 'blue' ? -index : index }" :class="{ filled: !!slotItem(seat, index), previewing: !timed && !selection(seat)[index] && !!slotItem(seat, index), pending: seat === operator && selection(seat).length === index }">
          <NinjaArtwork v-if="artwork(slotItem(seat, index))" :key="slotItem(seat, index)?.id" :src="artwork(slotItem(seat, index))!" :name="slotItem(seat, index)?.name" />
          <ItemPortrait v-else-if="slotItem(seat, index)" :item="slotItem(seat, index)" eager />
          <span v-else class="empty-slot">{{ index + 1 }}</span>
          <span v-if="slotItem(seat, index)" class="slot-number">{{ index + 1 }}</span>
          <span v-if="phase.kind === 'ban' && selection(seat)[index]" class="ban-seal">封</span>
          <strong>{{ slotItem(seat, index)?.name || '待选择' }}</strong>
          <small v-if="!timed && !selection(seat)[index] && slotItem(seat, index)">预览</small>
          <button v-if="timed" class="timed-overlay" :class="{ 'previewing-item': !selection(seat)[index] && timedItem(seat, index) }" :disabled="spectating || seat !== operator || !!selection(seat).length || (!match.settings.noTimer && seconds <= 0)" :aria-label="(seat === 'blue' ? '1P' : '2P') + ' ' + (index + 1) + '号位 ' + (timedItem(seat, index)?.name || '未选择')" @click="cancelSlot(seat, index)"><b>{{ index + 1 }}</b><ItemPortrait :item="timedItem(seat, index)" eager /><span>{{ timedItem(seat, index)?.name || '未选择' }}</span></button>
        </div>
      </div>
    </div>
    <div class="arena-summary">
      <div class="roster-bans"><template v-for="seat in (['blue', 'red'] as const)" :key="seat"><span :class="seat">{{ seat === 'blue' ? '1P' : '2P' }} 禁用</span><ItemPortrait v-for="id in match.current.bans[seat]" :key="id" :item="match.data.ninjas.find(item => item.id === id)" eager /></template></div>
      <div v-if="timed && !online" class="seat-tabs" aria-label="当前操作方"><button v-for="seat in (['blue', 'red'] as const)" :key="seat" :class="{ active: activeSeat === seat, done: selection(seat).length === 3 }" @click="activeSeat = seat">{{ seat === 'blue' ? '1P' : '2P' }} {{ selection(seat).length === 3 ? '已确认' : count(seat) + '/3' }}</button></div>
      <span v-else-if="timed" class="timed-count">1P {{ selection('blue').length === 3 ? '已确认' : count('blue') + '/3' }} · 2P {{ selection('red').length === 3 ? '已确认' : count('red') + '/3' }}</span>
      <span v-else class="turn-count">第 {{ phase.index + 1 }} / {{ phase.kind === 'ban' ? 4 : 6 }} 手</span>
    </div>
    <div class="catalog-toolbar arena-toolbar"><label class="arena-search"><Search :size="15" /><input v-model="search" type="search" :readonly="rotated" :role="rotated ? 'button' : undefined" placeholder="搜索名称 / 别名" :aria-label="rotated ? '打开忍者搜索' : '搜索名称或别名'" @click="openSearch" @focus="openSearch" /></label><div v-if="!timed" class="rank-filter" role="group" aria-label="忍者评级"><button v-for="value in ['', 'S', 'A', 'B', 'C']" :key="value" type="button" :aria-pressed="rank === value" @click="rank = value">{{ value || '全部' }}</button></div><span>{{ filtered.length }} 项</span></div>
    <div class="arena-catalog">
      <button class="icon-command page-arrow" title="上一页" :disabled="page === 0" @click="page--"><ChevronLeft :size="19" /></button>
      <section class="item-grid arena-pool" :class="{ compact: timed }"><button v-for="item in visible" :key="item.id" class="item-tile" :class="{ focused: timed ? drafts[operator].includes(item.id) : preview?.id === item.id, unavailable: !available(item) }" :data-rank="item.rank" :title="item.name" :aria-label="item.name" :aria-pressed="timed ? drafts[operator].includes(item.id) : preview?.id === item.id" :disabled="!available(item)" @click="select(item)"><ItemPortrait :item="item" eager /><span v-if="item.rank && !timed" class="rank">{{ item.rank }}</span><strong>{{ item.name }}</strong><span v-if="state(item)" class="tile-state">{{ state(item) }}</span></button><span v-if="!visible.length" class="empty-pool">没有匹配的项目</span></section>
      <button class="icon-command page-arrow" title="下一页" :disabled="page >= pages - 1" @click="page++"><ChevronRight :size="19" /></button>
    </div>
    <div class="arena-confirm-row"><span class="page-indicator">{{ page + 1 }} / {{ pages }}</span><span class="preview-name">{{ spectating ? '房主观战中' : timed ? (selection(operator).length === 3 ? '已确认，等待对手' : count(operator) + '/3 待确认') : preview?.name || (online && seat !== phase.turn ? '等待对手选择' : '') }}</span><button v-if="!spectating" class="button confirm-choice" :disabled="!canConfirm" @click="confirm"><Check :size="19" />{{ phase.kind === 'ban' ? '确认禁用' : timed ? '确认三个' + (phase.kind === 'scroll' ? '秘卷' : '通灵') : '确认选择' }}</button></div>
  </section>
  <Teleport to="body"><div v-if="searchOpen" class="search-backdrop" @click.self="closeSearch" @keydown.esc="closeSearch"><section class="search-dialog" role="dialog" aria-modal="true" aria-label="忍者搜索"><header><strong>忍者搜索</strong><button class="icon-command" title="关闭搜索" @click="closeSearch"><X :size="18" /></button></header><form @submit.prevent="closeSearch"><label class="field-label">名称 / 别名<input ref="searchInput" v-model="search" type="search" class="text-input" aria-label="搜索名称或别名" enterkeyhint="search" /></label><div><span>{{ filtered.length }} 项</span><button class="button primary" type="submit"><Check :size="18" />完成搜索</button></div></form></section></div></Teleport>
</template>
