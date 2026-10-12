export async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const previous = document.activeElement as HTMLElement | null
    const input = document.createElement('textarea')
    input.value = text
    input.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
    input.readOnly = true
    document.body.append(input)
    input.focus(); input.select(); input.setSelectionRange(0, text.length)
    try { return document.execCommand('copy') } catch { return false }
    finally { input.remove(); previous?.focus() }
  }
}
