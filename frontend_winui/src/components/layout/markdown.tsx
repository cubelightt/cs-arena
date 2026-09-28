// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { useMemo } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'

/**
 * 内容渲染：标准 Markdown（CommonMark + GFM：表格 / 围栏代码块 / 删除线 / 任务列表 / 自动链接），
 * 由 marked 解析、DOMPurify 消毒后交给 `.win-markdown` 样式（见 styles/winui.css）。
 * 卡片内容来自管理面板（管理员可写），仍然消毒一遍：脚本、事件属性、javascript: 链接一律剔除。
 */

marked.setOptions({ gfm: true, breaks: true }) // breaks：单个换行即断行（GitHub 风格，写公告更顺手）

// 链接一律新窗口打开，并补 rel 防 window.opener 泄漏；在消毒钩子里统一加，不受白名单影响
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

export function MarkdownBlocks({ source }: { source: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(source, { async: false })
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } })
  }, [source])

  return <div className="win-markdown" dangerouslySetInnerHTML={{ __html: html }} />
}
