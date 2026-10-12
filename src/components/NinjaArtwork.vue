<script lang="ts">
const croppedArtworks = new Map<string, Promise<string>>()

function cropArtwork(src: string): Promise<string> {
  const cached = croppedArtworks.get(src)
  if (cached) return cached
  if (croppedArtworks.size >= 32) croppedArtworks.delete(croppedArtworks.keys().next().value!)
  const result = new Promise<string>(resolve => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
        const context = canvas.getContext('2d')!
        context.drawImage(image, 0, 0)
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
        let left = canvas.width, top = canvas.height, right = -1, bottom = -1
        // Official artwork canvases include transparent margins around the character.
        for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
          if (pixels[(y * canvas.width + x) * 4 + 3]! > 16) {
            left = Math.min(left, x); right = Math.max(right, x)
            top = Math.min(top, y); bottom = Math.max(bottom, y)
          }
        }
        if (right < left || bottom < top) { resolve(src); return }
        canvas.width = right - left + 1; canvas.height = bottom - top + 1
        context.drawImage(image, left, top, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL('image/png'))
      } catch { resolve(src) }
    }
    image.onerror = () => { croppedArtworks.delete(src); resolve(src) }
    image.src = src
  })
  croppedArtworks.set(src, result)
  return result
}
</script>

<script setup lang="ts">
import { ref, watch } from 'vue'
const props = defineProps<{ src: string; name?: string }>()
const source = ref(props.src)
watch(() => props.src, async src => {
  source.value = src
  const cropped = await cropArtwork(src)
  if (props.src === src) source.value = cropped
}, { immediate: true })
</script>

<template><img class="ninja-artwork" :src="source" :alt="name" /></template>
