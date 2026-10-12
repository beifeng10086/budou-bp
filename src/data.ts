import type { DataPackage } from './types'

export async function loadOfficialPackages(): Promise<DataPackage[]> {
  const response = await fetch('/data/catalog-index.json')
  if (!response.ok) throw new Error('资料目录加载失败')
  const index = await response.json() as { packages: string[] }
  return Promise.all(index.packages.map(async (path) => {
    if (!/^\/data\/[\w.-]+\.json$/.test(path)) throw new Error('数据包地址无效')
    const result = await fetch(path)
    if (!result.ok) throw new Error('资料包加载失败')
    const value: unknown = await result.json()
    if (!validPackage(value)) throw new Error('资料包格式无效')
    return value
  }))
}

const ninjaNames: Array<[string, string, string[]]> = [
  ['疾风剑影', 'S', ['突进', '近战']], ['砂暴守卫', 'S', ['反手', '防御']],
  ['白眼侦察', 'A', ['先手', '控制']], ['雷遁行者', 'S', ['爆发', '空中']],
  ['傀儡师', 'A', ['消耗', '远程']], ['水牢使', 'A', ['控制', '抓取']],
  ['木遁护卫', 'S', ['防御', '反打']], ['幻术师', 'A', ['控制', '消耗']],
  ['炎遁追猎', 'S', ['爆发', '远程']], ['医疗忍者', 'A', ['续航', '辅助']],
  ['岩拳斗士', 'A', ['近战', '霸体']], ['纸遁飞舞', 'S', ['空中', '消耗']],
  ['风刃浪客', 'A', ['突进', '起手']], ['影缚策士', 'A', ['控制', '反手']],
  ['鲛肌使者', 'S', ['近战', '压制']], ['冰镜少女', 'A', ['灵活', '空中']],
  ['蛤蟆仙人', 'S', ['范围', '爆发']], ['赤砂之蝎', 'S', ['傀儡', '消耗']],
  ['金角银角', 'A', ['抓取', '霸体']], ['电光少年', 'A', ['突进', '爆发']],
  ['铁扇舞者', 'A', ['范围', '控制']], ['磁遁猎手', 'S', ['远程', '压制']],
  ['夜行面具', 'A', ['灵活', '突进']], ['蒸危爆威', 'S', ['爆发', '消耗']],
  ['八门斗士', 'S', ['近战', '爆发']], ['云隐剑客', 'A', ['反手', '空中']],
]

export const builtinPackages: DataPackage[] = [
  {
    id: 'demo-2026-q3',
    name: '2026 Q3 演示忍者池',
    updatedAt: '2026-08-25',
    source: '内置演示数据，不代表官方比赛池',
    ninjas: ninjaNames.map(([name, rank, tags], index) => ({ id: `q3-ninja-${index + 1}`, name, rank, tags: tags as string[] })),
    scrolls: [
      ['雷电击', ['起手', '压制']], ['解术复', ['反制', '防御']], ['冻雪', ['控制', '范围']],
      ['扦插', ['控制', '追击']], ['水遁水龙卷', ['防御', '反手']], ['查克拉', ['强化', '爆发']],
      ['风遁风杀阵', ['控制', '范围']], ['禁术阴愈伤灭', ['反制', '防御']], ['气旋', ['起手', '压制']],
      ['一字连柱', ['压制', '扫地']], ['怒气', ['强化', '爆发']], ['火遁裂炎弹', ['追击', '范围']],
    ].map(([name, tags], index) => ({ id: `q3-scroll-${index + 1}`, name: name as string, tags: tags as string[] })),
    summons: [
      ['熊猫', ['霸体', '防御']], ['蛤蟆吉', ['起手', '击飞']], ['猿魔', ['压制', '近战']],
      ['蜃', ['控制', '反手']], ['忍龟', ['范围', '防御']], ['蓝蛇', ['扫地', '追击']],
      ['梦貘', ['吸附', '控制']], ['蛞蝓', ['续航', '范围']], ['山椒鱼', ['压制', '范围']],
      ['镰鼬', ['起手', '击飞']], ['乌鸦', ['骚扰', '控制']], ['二尾', ['爆发', '扫地']],
    ].map(([name, tags], index) => ({ id: `q3-summon-${index + 1}`, name: name as string, tags: tags as string[] })),
  },
  {
    id: 'demo-classic',
    name: '经典规则演示池',
    updatedAt: '2026-05-01',
    source: '内置演示数据，不代表官方比赛池',
    ninjas: ninjaNames.slice(2).map(([name, rank, tags], index) => ({ id: `classic-ninja-${index + 1}`, name, rank, tags: tags as string[] })),
    scrolls: [
      ['风遁风杀阵', ['控制', '范围']], ['禁术阴愈伤灭', ['防御', '反制']], ['水遁水龙卷', ['反手', '防御']], ['手里剑护身', ['压制', '追击']],
      ['气旋', ['起手', '压制']], ['冻雪', ['范围', '控制']], ['查克拉', ['强化', '爆发']], ['扦插', ['控制', '追击']], ['火遁裂炎弹', ['范围', '追击']],
    ].map(([name, tags], index) => ({ id: `classic-scroll-${index + 1}`, name: name as string, tags: tags as string[] })),
    summons: [
      ['熊猫', ['防御']], ['蛤蟆吉', ['起手']], ['忍龟', ['范围']], ['蜃', ['控制']], ['猿魔', ['压制']],
      ['蓝蛇', ['扫地']], ['梦貘', ['吸附']], ['蛞蝓', ['续航']], ['镰鼬', ['击飞']],
    ].map(([name, tags], index) => ({ id: `classic-summon-${index + 1}`, name: name as string, tags: tags as string[] })),
  },
]

export function validPackage(value: unknown): value is DataPackage {
  const data = value as Partial<DataPackage>
  return Boolean(
    data && typeof data.id === 'string' && typeof data.name === 'string' && typeof data.updatedAt === 'string'
    && Array.isArray(data.ninjas) && Array.isArray(data.scrolls) && Array.isArray(data.summons)
    && data.ninjas.length >= 22 && data.scrolls.length >= 9 && data.summons.length >= 9
    && [data.ninjas, data.scrolls, data.summons].every((list) => list.every(validItem) && new Set(list.map((item) => item.id)).size === list.length),
  )
}

function validItem(value: unknown): value is { id: string; name: string; tags: string[] } {
  const item = value as Partial<import('./types').GameItem>
  return Boolean(item && typeof item.id === 'string' && item.id.trim() && typeof item.name === 'string' && item.name.trim()
    && Array.isArray(item.tags) && item.tags.every((tag) => typeof tag === 'string')
    && (item.aliases === undefined || Array.isArray(item.aliases) && item.aliases.every((name) => typeof name === 'string'))
    && [item.image, item.artwork].every(url => url === undefined || typeof url === 'string' && /^(\/assets\/[\w/.-]+|https:\/\/[^\s]+)$/.test(url)))
}
