// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ScrollText } from 'lucide-react'
import { InfoBar } from '@/components/winui/info-bar'
import { MarkdownCard, type ContentState } from '@/components/layout/markdown-card'
import { api } from '@/lib/api'
import type { HomeContent } from '@/lib/types'

export function HomePage() {
  const navigate = useNavigate()
  const [content, setContent] = useState<HomeContent | null>(null)
  const [failed, setFailed] = useState(false)

  const load = useCallback(() => {
    setFailed(false)
    api
      .get<HomeContent>('/api/settings/home-content')
      .then(setContent)
      .catch(() => setFailed(true))
  }, [])
  useEffect(load, [load])

  const stateOf = (pick: (c: HomeContent) => string): ContentState => {
    if (failed) return { status: 'error' }
    if (!content) return { status: 'loading' }
    return { status: 'ok', markdown: pick(content) }
  }

  return (
    // lg 下整页恰好占满一屏（标题栏 48 + main 上下 padding 48 = 6rem）：
    // 卡片区吃掉剩余高度，底边停在 main 的 24px 下内距上（视口最下方偏上）
    <div className="flex flex-col gap-4 py-10 lg:h-[calc(100vh-6rem)] lg:pb-0">
      <InfoBar className="shrink-0" severity="info" title="注意" message="这是CS Arena的测试版本！测试版本不代表最终品质——BSG(x)  遇到BUG请向管理员反馈" />

      <section className="w-full shrink-0">
        <button
          type="button"
          onClick={() => navigate('/lobby')}
          className="win-card flex w-full cursor-pointer items-center justify-between px-6 py-4 text-left transition-colors hover:bg-[var(--subtle-secondary)]"
        >
          <div>
            <p className="win-body font-medium">已有房间码？</p>
            <p className="win-caption mt-0.5 text-muted-foreground">前往大厅浏览公开房间，或输入房间码直达</p>
          </div>
          <span className="win-body font-medium text-[var(--accent-text)]">房间大厅 →</span>
        </button>
      </section>

      <section className="grid min-h-0 flex-1 gap-4 lg:grid-cols-3">
        {/* 左卡（2/3 宽）：内容由管理面板「首页内容」在线编辑（暂为空 = 留白） */}
        <MarkdownCard className="min-h-32 lg:col-span-2 lg:min-h-0" state={stateOf((c) => c.leftCard)} onRetry={load} />
        {/* 右卡（1/3 宽）：更新日志；内容超出时卡片内部滚动 */}
        <MarkdownCard title="更新日志" icon={ScrollText} state={stateOf((c) => c.changelog)} onRetry={load} />
      </section>
    </div>
  )
}
