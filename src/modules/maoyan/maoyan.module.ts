import { Common, dayjs } from '../../common.ts'
import { serviceZgdypf } from '../zgdypf.module.ts'

import type { RouterMiddleware } from '@oak/oak'

type ChartType = 'movie' | 'tv' | 'web'

interface DoubanItem {
  rank: number
  title: string
  id: string
  rating: number
  rating_count: number
  good_rate: number
  card_subtitle: string
  description: string
  cover: string
  url: string
  tags: string[]
}

interface DoubanRawItem {
  rank?: number
  title?: string
  id?: string | number
  rating?: { value?: number; count?: number }
  card_subtitle?: string
  description?: string
  cover_url?: string
  url?: string
  good_rating_stats?: number
  tags?: Array<{ name?: string }>
}

const DOUBAN_BASE_URL = 'https://m.douban.com/rexxar/api/v2/subject_collection'
const DOUBAN_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

const DOUBAN_CONFIG = {
  tv: {
    collection: 'tv_chinese_best_weekly',
    title: '豆瓣国内剧集周榜',
  },
  web: {
    collection: 'tv_global_best_weekly',
    title: '豆瓣全球剧集周榜',
  },
} as const

class ServiceMaoyan {
  private doubanCache = new Map<
    ChartType,
    { data: DoubanItem[]; timestamp: number }
  >()

  private readonly CACHE_TTL = 60 * 60 * 1000

  /**
   * 保留原接口：
   * /v2/maoyan/all/movie
   *
   * 改为使用新票房源的电影列表，并按累计票房排序。
   * 这不是历史全球总票房榜。
   */
  handleAllMovie(): RouterMiddleware<string> {
    return async (ctx) => {
      try {
        const source = await serviceZgdypf.getData()
        const movies = [...(source.movies ?? [])].sort(
          (a, b) => this.toNumber(b.sum_box) - this.toNumber(a.sum_box),
        )

        const data = {
          list: movies.map((movie, index) => ({
            rank: index + 1,
            maoyan_id: String(movie.rank ?? index + 1),
            movie_name: movie.name,
            release_year: movie.release_days
              ? `上映${movie.release_days}天`
              : '',
            box_office: this.toNumber(movie.sum_box),
            box_office_desc: `${movie.sum_box ?? 0}`,
            today_box_office: movie.today_box_wan,
            today_box_office_desc: `${movie.today_box_wan ?? 0}万元`,
          })),
          tip: '数据来源：中国电影票房数据源；按当前返回数据中的累计票房排序，不代表历史全球总票房榜。',
          update_time: source.updated ?? Common.localeTime(),
          update_time_at: Date.now(),
        }

        switch (ctx.state.encoding) {
          case 'text':
            ctx.response.body = `电影累计票房排行\n\n${data.list
              .slice(0, 20)
              .map(
                (movie) =>
                  `${movie.rank}. ${movie.movie_name} - ${movie.box_office_desc}`,
              )
              .join('\n')}\n\n${data.tip}`
            break

          case 'markdown':
            ctx.response.body = `# 🎬 电影累计票房排行\n\n| 排名 | 电影名称 | 累计票房 | 今日票房 |\n|---|---|---|---|\n${data.list
              .slice(0, 20)
              .map(
                (movie) =>
                  `| ${movie.rank} | ${movie.movie_name} | ${movie.box_office_desc} | ${movie.today_box_office_desc} |`,
              )
              .join('\n')}\n\n${data.tip}\n\n*更新时间：${data.update_time}*`
            break

          default:
            ctx.response.body = Common.buildJson(data)
        }
      } catch (error) {
        this.fail(ctx, error)
      }
    }
  }

  /**
   * 保留原接口：
   * /v2/maoyan/realtime/movie
   * /v2/maoyan/realtime/tv
   * /v2/maoyan/realtime/web
   */
  handleRealtime(type: ChartType): RouterMiddleware<string> {
    return async (ctx) => {
      try {
        if (type === 'movie') {
          const source = await serviceZgdypf.getData()
          const data = {
            title: '实时电影票房排行',
            updated: source.updated ?? Common.localeTime(),
            updated_at: source.updated_at ?? Date.now(),
            date: source.date,
            national_box_wan: source.national_box_wan,
            national_box_split_wan: source.national_box_split_wan,
            movie_count: source.movie_count ?? source.movies?.length ?? 0,
            list: (source.movies ?? []).map((movie, index) => ({
              rank: movie.rank ?? index + 1,
              movie_id: movie.rank ?? index + 1,
              movie_name: movie.name,
              release_info: movie.release_days
                ? `上映${movie.release_days}天`
                : '',
              box_office: this.toNumber(movie.today_box_wan),
              box_office_desc: `${movie.today_box_wan ?? 0}万元`,
              box_office_rate: this.toNumber(movie.today_box_rate),
              box_office_rate_desc: `${movie.today_box_rate ?? 0}%`,
              show_count_rate: this.toNumber(movie.session_rate),
              show_count_rate_desc: `${movie.session_rate ?? 0}%`,
              avg_seat_view: this.toNumber(movie.seat_rate),
              avg_seat_view_desc: `${movie.seat_rate ?? 0}%`,
              split_box_office: this.toNumber(movie.split_box_wan),
              split_box_office_desc: `${movie.split_box_wan ?? 0}万元`,
              sum_box: this.toNumber(movie.sum_box),
              sum_box_desc: `${movie.sum_box ?? 0}`,
              online_rate: this.toNumber(movie.online_rate),
            })),
            data_source: '中国电影票房数据源',
          }

          this.respond(ctx, type, data)
          return
        }

        const list = await this.fetchDouban(type)
        const data =
          type === 'tv'
            ? {
                title: DOUBAN_CONFIG.tv.title,
                updated: Common.localeTime(),
                updated_at: Date.now(),
                list: list.map((item, index) => ({
                  rank: item.rank || index + 1,
                  programme_name: item.title,
                  channel_name: item.tags.join('、') || item.card_subtitle,
                  market_rate: item.rating,
                  market_rate_desc: item.rating
                    ? `${item.rating}/10`
                    : '暂无评分',
                  rating_count: item.rating_count,
                  attention_rate: item.good_rate,
                  description: item.description,
                  cover: item.cover,
                  url: item.url,
                })),
                data_source: '豆瓣国内剧集周榜',
              }
            : {
                title: DOUBAN_CONFIG.web.title,
                updated: Common.localeTime(),
                updated_at: Date.now(),
                list: list.map((item, index) => ({
                  rank: item.rank || index + 1,
                  series_name: item.title,
                  curr_heat: item.rating,
                  curr_heat_desc: item.rating
                    ? `豆瓣评分 ${item.rating}/10`
                    : '暂无评分',
                  release_info: item.card_subtitle,
                  rating_count: item.rating_count,
                  attention_rate: item.good_rate,
                  description: item.description,
                  cover: item.cover,
                  url: item.url,
                })),
                data_source: '豆瓣全球剧集周榜',
              }

        this.respond(ctx, type, data)
      } catch (error) {
        this.fail(ctx, error)
      }
    }
  }

  private respond(
    ctx: Parameters<RouterMiddleware<string>>[0],
    type: ChartType,
    data: Record<string, any>,
  ) {
    const title = data.title ?? '排行榜'
    const list = data.list ?? []

    switch (ctx.state.encoding) {
      case 'text':
        ctx.response.body = `${title}\n\n${list
          .slice(0, 20)
          .map((item: Record<string, any>, index: number) => {
            if (type === 'movie') {
              return `${item.rank ?? index + 1}. ${item.movie_name} - ${item.box_office_desc}`
            }
            if (type === 'tv') {
              return `${item.rank ?? index + 1}. ${item.programme_name} - ${item.market_rate_desc}`
            }
            return `${item.rank ?? index + 1}. ${item.series_name} - ${item.curr_heat_desc}`
          })
          .join('\n')}\n\n数据来源：${data.data_source}`
        break

      case 'markdown':
        ctx.response.body = `# ${title}\n\n| 排名 | 名称 | 数据 |\n|---|---|---|\n${list
          .slice(0, 20)
          .map((item: Record<string, any>, index: number) => {
            const name =
              type === 'movie'
                ? item.movie_name
                : type === 'tv'
                  ? item.programme_name
                  : item.series_name
            const value =
              type === 'movie'
                ? item.box_office_desc
                : type === 'tv'
                  ? item.market_rate_desc
                  : item.curr_heat_desc
            return `| ${item.rank ?? index + 1} | ${name} | ${value} |`
          })
          .join('\n')}\n\n*更新时间：${data.updated}*\n\n*数据来源：${data.data_source}*`
        break

      default:
        ctx.response.body = Common.buildJson(data)
    }
  }

  private async fetchDouban(type: 'tv' | 'web'): Promise<DoubanItem[]> {
    const cached = this.doubanCache.get(type)
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.data
    }

    const config = DOUBAN_CONFIG[type]
    const url =
      `${DOUBAN_BASE_URL}/${config.collection}/items` +
      '?start=0&count=10&items_only=1&for_mobile=1'

    const response = await fetch(url, {
      headers: {
        'User-Agent': DOUBAN_UA,
        Referer: 'https://m.douban.com/subject_collection',
      },
    })

    if (!response.ok) {
      throw new Error(`豆瓣请求失败：HTTP ${response.status}`)
    }

    const json = await response.json()
    const rawItems = (json.subject_collection_items ?? []) as DoubanRawItem[]

    const items = rawItems
      .map((raw, index): DoubanItem => ({
        rank: raw.rank ?? index + 1,
        title: raw.title ?? '',
        id: String(raw.id ?? ''),
        rating: raw.rating?.value ?? 0,
        rating_count: raw.rating?.count ?? 0,
        good_rate: raw.good_rating_stats ?? 0,
        card_subtitle: raw.card_subtitle ?? '',
        description: raw.description ?? '',
        cover: (raw.cover_url ?? '').replace(
          /https:\/\/img\w*\.doubanio\.com/,
          'https://doubanio.viki.moe',
        ),
        url: raw.url ?? '',
        tags: (raw.tags ?? []).map((tag) => tag.name ?? '').filter(Boolean),
      }))
      .sort((a, b) => a.rank - b.rank)

    if (items.length > 0) {
      this.doubanCache.set(type, { data: items, timestamp: Date.now() })
    } else if (cached) {
      // 豆瓣临时返回空列表时，优先返回已有缓存。
      return cached.data
    }

    return items
  }

  private toNumber(value: unknown): number {
    if (typeof value === 'number') return value
    if (typeof value === 'string') {
      const parsed = Number(value.replace(/,/g, '').trim())
      return Number.isFinite(parsed) ? parsed : 0
    }
    return 0
  }

  private fail(
    ctx: Parameters<RouterMiddleware<string>>[0],
    error: unknown,
  ) {
    Common.debug('新票房/豆瓣数据获取失败:', error)
    ctx.response.status = 502
    ctx.response.body = Common.buildJson(
      null,
      502,
      error instanceof Error ? error.message : '数据获取失败',
    )
  }
}

export const serviceMaoyan = new ServiceMaoyan()