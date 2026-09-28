// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Send } from 'lucide-react'
import { Badge } from '@/components/winui/badge'
import { Button } from '@/components/winui/button'
import { Input } from '@/components/winui/input'
import { Ring } from '@/components/winui/progress'
import { getSocket } from '@/lib/api'
import { useArena } from '@/stores/arena'

interface HistoryResult {
  instance: string
  path?: string
  offset?: number
  lines?: string[]
}

interface CommandResult {
  instance: string
  ok: boolean
  data?: { error?: string } | string
}

const MAX_LINES = 5000

/**
 * 实例控制台：终端惯例优先于整体浅色主题，日志区固定深底（与 v2 的有意例外一致），
 * 其余外壳（标题栏/徽章/输入行）走 WinUI 控件。
 */
export function AdminConsolePage() {
  const { name = '' } = useParams<{ name: string }>()
  const toast = useArena((s) => s.toast)

  const [lines, setLines] = useState<string[]>([])
  const [running, setRunning] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [command, setCommand] = useState('')
  const [sending, setSending] = useState(false)
  const [history, setHistory] = useState<string[]>([])
  const [historyIdx, setHistoryIdx] = useState(-1)

  const scrollRef = useRef<HTMLDivElement>(null)
  const autoScrollRef = useRef(true)
  const lastLineRef = useRef('')
  const lastCmdRef = useRef('')

  // 自动滚动：用户上滚暂停，回到底部恢复
  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

  useEffect(() => {
    if (autoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [lines])

  const appendLines = useCallback((newLines: string[]) => {
    if (newLines.length === 0) return
    setLines((prev) => {
      let batch = newLines
      if (prev.length > 0 && batch[0] === lastLineRef.current) {
        batch = batch.slice(1)
      }
      lastLineRef.current = batch[batch.length - 1] ?? lastLineRef.current
      const merged = [...prev, ...batch]
      return merged.length > MAX_LINES ? merged.slice(merged.length - MAX_LINES) : merged
    })
  }, [])

  useEffect(() => {
    if (!name) return
    const socket = getSocket()

    // 历史拉取（socket 通道）
    const onHistoryResult = (p: HistoryResult) => {
      if (p.instance !== name) return
      const batch = p.lines ?? []
      lastLineRef.current = batch[batch.length - 1] ?? ''
      setLines(batch)
      setRunning(true)
      setLoadError('')
      setLoading(false)
      socket.emit('console:subscribe', { instance: name, offset: p.offset != null ? p.offset : undefined })
    }
    // 命令执行结果
    const onCommandResult = (p: CommandResult) => {
      if (p.instance !== name) return
      setSending(false)
      if (p.ok) {
        const cmd = lastCmdRef.current
        if (cmd) {
          setHistory((prev) => (prev[prev.length - 1] === cmd ? prev : [...prev, cmd]))
          setHistoryIdx(-1)
          setCommand('')
        }
        toast('命令已发送', cmd, 'success')
      } else {
        const err = typeof p.data === 'string' ? p.data : p.data?.error
        toast('命令执行失败', err || '未知错误', 'error')
      }
    }
    const onOutput = (p: { instance: string; lines: string[] }) => {
      if (p.instance !== name) return
      appendLines(p.lines ?? [])
    }
    const onReset = (p: { instance: string }) => {
      if (p.instance !== name) return
      setLoading(true)
      socket.emit('console:history', { instance: name, lines: 200 })
    }
    const onState = (p: { instance: string; running: boolean }) => {
      if (p.instance !== name) return
      setRunning(p.running)
    }
    const onError = (p: { instance: string; error: string }) => {
      if (p.instance !== name) return
      setLoading(false)
      if (p.error.includes('未运行')) setRunning(false)
      setLoadError(p.error)
      toast('控制台错误', p.error, 'error')
    }

    socket.on('console:history_result', onHistoryResult)
    socket.on('console:command_result', onCommandResult)
    socket.on('console:output', onOutput)
    socket.on('console:reset', onReset)
    socket.on('console:state', onState)
    socket.on('console:error', onError)

    // 初始拉取历史
    setLoading(true)
    socket.emit('console:history', { instance: name, lines: 200 })

    return () => {
      socket.emit('console:unsubscribe', { instance: name })
      socket.off('console:history_result', onHistoryResult)
      socket.off('console:command_result', onCommandResult)
      socket.off('console:output', onOutput)
      socket.off('console:reset', onReset)
      socket.off('console:state', onState)
      socket.off('console:error', onError)
    }
  }, [name, appendLines, toast])

  const sendCommand = () => {
    const cmd = command.trim()
    if (!cmd || sending) return
    lastCmdRef.current = cmd
    setSending(true)
    getSocket().emit('console:command', { instance: name, command: cmd })
  }

  // 命令历史导航（↑/↓）
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      sendCommand()
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (history.length === 0) return
      const idx = historyIdx === -1 ? history.length - 1 : Math.max(0, historyIdx - 1)
      setHistoryIdx(idx)
      setCommand(history[idx])
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (historyIdx === -1) return
      const idx = historyIdx + 1
      if (idx >= history.length) {
        setHistoryIdx(-1)
        setCommand('')
      } else {
        setHistoryIdx(idx)
        setCommand(history[idx])
      }
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link
            to="/admin"
            aria-label="返回管理面板"
            className="win-btn win-btn-subtle size-8 justify-center p-0 text-muted-foreground"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="win-title">实例控制台</h1>
              <span className="win-body font-mono text-muted-foreground">{name}</span>
              <Badge variant={running === false ? 'destructive' : running ? 'success' : 'secondary'}>
                {running === false ? '未运行' : running ? '运行中' : '检测中…'}
              </Badge>
            </div>
            <p className="win-caption mt-1 text-muted-foreground">
              实时日志 · 单行命令 ≤2000 字符 · 命令输出将出现在日志中 · ↑/↓ 浏览命令历史
            </p>
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setLines([])
            lastLineRef.current = ''
          }}
        >
          清屏
        </Button>
      </div>

      <div className="overflow-hidden rounded-lg border border-[var(--card-stroke)]">
        {loadError && (
          <div className="win-body border-b border-[var(--card-stroke)] bg-[var(--critical-bg)] px-4 py-3 text-[var(--critical)]">
            {loadError}
            {running === false && '—— 实例未运行，无法读取控制台'}
          </div>
        )}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-[480px] overflow-y-auto bg-[#0a0a0a] p-4 font-mono text-xs leading-relaxed text-[#6ccb5f]"
        >
          {loading && lines.length === 0 ? (
            <div className="flex items-center gap-2 text-[#9d9d9d]">
              <Ring size={14} />
              正在读取历史日志…
            </div>
          ) : lines.length === 0 ? (
            <p className="text-[#9d9d9d]">{running === false ? '实例未运行' : '暂无日志输出'}</p>
          ) : (
            lines.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap break-all">
                {line || '\u00A0'}
              </div>
            ))
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="win-body shrink-0 font-mono text-muted-foreground select-none">$</span>
        <Input
          className="flex-1 font-mono"
          placeholder="输入控制台命令，Enter 发送"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={sending || running === false}
        />
        <Button onClick={sendCommand} disabled={sending || !command.trim() || running === false}>
          {sending ? <Ring size={16} /> : <Send className="size-4" />}
          发送
        </Button>
      </div>
      {running === false && (
        <p className="win-caption text-muted-foreground">实例未运行，无法执行命令。可返回管理面板启动该实例。</p>
      )}
      {history.length > 0 && (
        <p className="win-caption break-all text-muted-foreground">最近命令：{history.slice(-3).join(' · ')}</p>
      )}
    </div>
  )
}
