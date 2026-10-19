
import { Common } from '../common.ts'

import type { RouterMiddleware } from '@oak/oak'

const BASE_URL = 'https://zgdypf.zgdypw.cn/box'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'

export interface ZgMovieItem {
  rank: number
  name: string
  release_days: number
  /** 今日综合票房（万元） */
  today_box_wan: string
  /** 综合票房占比 */
  today_box_rate: string
  /** 排片占比 */
  session_rate: string
  /** 上座率 */
  seat_rate: string
  /** 网售占比 */
  online_rate: string
  /** 今日分账票房（万元） */
  split_box_wan: string
  /** 累计综合票房 */
  sum_box: string
}

export interface ZgData {
  /** 数据日期 YYYY-MM-DD */
  date: string
  /** 北京时间更新时间 */
  updated: string
  /** 毫秒时间戳 */
  updated_at: number
  /** 今日实时总票房（含服务费，万元） */
  national_box_wan: string | null
  /** 今日实时总票房（分账，万元） */
  national_box_split_wan: string | null
  movie_count: number
  movies: ZgMovieItem[]
}

class ServiceZgdypf {
  private cache: { ts: number; data: ZgData } | null = null

  /** 15 秒缓存，避免频繁请求 */
  private readonly TTL = 15 * 1000

  /**
   * 提供给其他模块使用的数据方法。
   * 与 handle() 共用缓存，避免重复请求上游。
   */
  async getData(force = false): Promise<ZgData> {
    return this.fetch(force)
  }

  /**
   * 原有接口保持不变：
   * /v2/zgdypf/box
   */
  handle(): RouterMiddleware<'/zgdypf/box'> {
    return async (ctx) => {
      try {
        const forceValue = ctx.request.url.searchParams.get('force-update')
        const force = forceValue === '1' || forceValue === 'true'
        const data = await this.fetch(force)

        switch (ctx.state.encoding) {
          case 'text':
            ctx.response.body = this.toText(data)
            break

          case 'markdown':
            ctx.response.body = this.toMarkdown(data)
            break

          case 'json':
          default:
            ctx.response.body = Common.buildJson(data)
            break
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : '未知错误'

        ctx.response.status = 502
        ctx.response.body = Common.buildJson(null, 502, message)
      }
    }
  }

  private async fetch(force = false): Promise<ZgData> {
    if (!force && this.cache && Date.now() - this.cache.ts < this.TTL) {
      return this.cache.data
    }

    const response = await fetch(BASE_URL, {
      headers: {
        'User-Agent': UA,
        Referer: 'https://zgdypf.zgdypw.cn/',
      },
    })

    if (!response.ok) {
      throw new Error(`中国电影票房数据源请求失败：HTTP ${response.status}`)
    }

    const html = await response.text()
    const state = this.extractState(html)

    const bd = state?.boxData ?? {}
    const national = bd.nationalSales ?? {}

    // 兼容秒级和毫秒级时间戳。
    const rawTimestamp = Number(
      bd.updateTimestamp ?? national.updateTimestamp ?? Date.now(),
    )

    const timestamp =
      Number.isFinite(rawTimestamp) && rawTimestamp > 0
        ? rawTimestamp < 1_000_000_000_000
          ? rawTimestamp * 1000
          : rawTimestamp
        : Date.now()

    const rawMovies = Array.isArray(bd.list) ? bd.list : []

    const movies: ZgMovieItem[] = rawMovies.map(
      (item: Record<string, unknown>, index: number) => ({
        rank: index + 1,
        name: String(item.name ?? ''),
        release_days: this.toNumber(item.releaseDays),
        today_box_wan: this.toTextValue(item.salesInWanDesc),
        today_box_rate: this.toTextValue(item.salesRateDesc),
        session_rate: this.toTextValue(item.sessionRateDesc),
        seat_rate: this.toTextValue(item.seatRateDesc),
        online_rate: this.toTextValue(item.onlineSalesRateDesc),
        split_box_wan: this.toTextValue(item.splitSalesInWanDesc),
        sum_box: this.toTextValue(item.sumSalesDesc),
      }),
    )

    const dateRange = state?.dateRange ?? {}

    const data: ZgData = {
      date: String(dateRange.endDate ?? dateRange.startDate ?? ''),
      updated: Common.localeTime(timestamp),
      updated_at: timestamp,
      national_box_wan: this.toNullableText(national.salesDesc?.value),
      national_box_split_wan: this.toNullableText(
        national.splitSalesDesc?.value,
      ),
      movie_count: movies.length,
      movies,
    }

    this.cache = {
      ts: Date.now(),
      data,
    }

    return data
  }

  /**
   * 从 SSR 页面中提取 window.__INITIAL_STATE__ 的 JSON。
   * 支持字符串转义，并通过括号配平定位完整 JSON 对象。
   */
  private extractState(html: string): Record<string, any> {
    const match = html.match(/window\.__INITIAL_STATE__\s*=\s*/)

    if (!match || match.index === undefined) {
      throw new Error('页面结构已变更：未找到 __INITIAL_STATE__')
    }

    let source = html.slice(match.index + match[0].length)

    const scriptEnd = source.indexOf('</script>')
    if (scriptEnd !== -1) {
      source = source.slice(0, scriptEnd)
    }

    source = source.trim()

    const openIndex = source.indexOf('{')

    if (openIndex === -1) {
      throw new Error('页面结构异常：未找到 JSON 对象')
    }

    source = source.slice(openIndex)

    let depth = 0
    let inString = false
    let escaped = false
    let endIndex = -1

    for (let i = 0; i < source.length; i++) {
      const char = source[i]

      if (inString) {
        if (escaped) {
          escaped = false
        } else if (char === '\\') {
          escaped = true
        } else if (char === '"') {
          inString = false
        }
      } else if (char === '"') {
        inString = true
      } else if (char === '{') {
        depth++
      } else if (char === '}') {
        depth--

        if (depth === 0) {
          endIndex = i + 1
          break
        }
      }
    }

    if (endIndex === -1) {
      throw new Error('页面结构异常：JSON 对象不完整')
    }

    const jsonString = source.slice(0, endIndex)

    try {
      return JSON.parse(jsonString)
    } catch {
      throw new Error('页面结构异常：解析票房数据失败')
    }
  }

  private toNumber(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }

    if (typeof value === 'string') {
      const number = Number(value.replace(/,/g, '').trim())

      if (Number.isFinite(number)) {
        return number
      }
    }

    return 0
  }

  private toTextValue(value: unknown): string {
    if (value === null || value === undefined || value === '') {
      return '0'
    }

    return String(value)
  }

  private toNullableText(value: unknown): string | null {
    if (value === null || value === undefined || value === '') {
      return null
    }

    return String(value)
  }

  private toText(data: ZgData): string {
    const lines = [
      `中国电影票房 (${data.date}) 更新于 ${data.updated}`,
      `今日实时总票房：${data.national_box_wan ?? '暂无'} 万元（含服务费） | 分账：${data.national_box_split_wan ?? '暂无'} 万元`,
      `在映影片：${data.movie_count} 部`,
      '',
      data.movies
        .slice(0, 20)
        .map(
          (movie) =>
            `${movie.rank}. ${movie.name}（上映${movie.release_days}天）- 今日${movie.today_box_wan}万 / 累计${movie.sum_box}`,
        )
        .join('\n'),
    ]

    return lines.join('\n')
  }

  private toMarkdown(data: ZgData): string {
    const rows = data.movies
      .slice(0, 20)
      .map(
        (movie) =>
          `| ${movie.rank} | ${movie.name} | ${movie.release_days} | ${movie.today_box_wan}万 | ${movie.today_box_rate} | ${movie.session_rate} | ${movie.online_rate} | ${movie.sum_box} |`,
      )
      .join('\n')

    return `# 🎬 中国电影票房 (${data.date})

**今日实时总票房**：${data.national_box_wan ?? '暂无'} 万元（含服务费） | 分账：${data.national_box_split_wan ?? '暂无'} 万元

*更新时间：${data.updated}*

| 排名 | 影片 | 上映天数 | 今日票房 | 票房占比 | 排片占比 | 网售占比 | 累计票房 |
|------|------|------|----------|------|------|------|------|
${rows}`
  }
}

export const serviceZgdypf = new ServiceZgdypf()
