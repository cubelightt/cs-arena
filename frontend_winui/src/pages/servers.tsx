// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Badge } from '@/components/winui/badge'
import { Button } from '@/components/winui/button'
import { Card } from '@/components/winui/card'
import { api } from '@/lib/api'
import type { MaintenanceInfo } from '@/lib/types'
import { cn } from '@/lib/utils'

interface GroupServer {
  name: string
  status: 'in_match' | 'idle' | 'stopped' | 'unknown' | string
  statusLabel: string
  health: string
  state: string
  matchId: number | null
  adminOnly?: boolean
  botCapable?: boolean
}

interface ServerGroup {
  groupId: string
  groupName: string
  hostIp: string
  region: string
  summary: { inMatch: number; idle: number; stopped: number; unknown: number }
  servers: GroupServer[]
}

interface HealthInfo {
  ok: boolean
  time: number
  /** 生效中的维护组：该组的开赛/实例启停已禁用 */
  maintenance?: MaintenanceInfo[]
}

const STATUS_META: Record<string, { label: string; variant: 'success' | 'info' | 'destructive' | 'secondary' }> = {
  in_match: { label: '比赛中', variant: 'destructive' },
  idle: { label: '空闲', variant: 'success' },
  stopped: { label: '已停止', variant: 'secondary' },
  unknown: { label: '未知', variant: 'info' },
}

const STATE_META: Record<string, { label: string; variant: 'success' | 'info' | 'destructive' | 'secondary' }> = {
  idle: { label: '锁空闲', variant: 'success' },
  booting: { label: '锁启动中', variant: 'info' },
  in_match: { label: '锁对局中', variant: 'destructive' },
  cooling: { label: '锁冷却中', variant: 'secondary' },
}

const HEALTH_META: Record<string, { label: string; variant: 'success' | 'info' | 'destructive' | 'secondary' }> = {
  RUNNING: { label: 'RUNNING', variant: 'success' },
  STOPPED: { label: 'STOPPED', variant: 'secondary' },
  BOOTING: { label: 'BOOTING', variant: 'info' },
  UNKNOWN: { label: 'UNKNOWN', variant: 'secondary' },
  unreachable: { label: '不可达', variant: 'destructive' },
}

export function ServersPage() {
  const [health, setHealth] = useState<HealthInfo | null>(null)
  const [groups, setGroups] = useState<ServerGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchAll = useCallback(async () => {
    try {
      const [h, g] = await Promise.all([
        api.get<HealthInfo>('/api/health'),
        api.get<ServerGroup[]>('/api/servers/status'),
      ])
      setHealth(h)
      setGroups(g)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchAll()
    timerRef.current = setInterval(fetchAll, 5000)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [fetchAll])

  const serverCount = groups.reduce((sum, g) => sum + g.servers.length, 0)

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="win-title">服务器状态</h1>
          <p className="win-body mt-1 text-muted-foreground">游戏服务器组与实例运行状态（每 5 秒自动刷新）</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => fetchAll()} disabled={loading}>
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
          刷新
        </Button>
      </div>

      {error && (
        <div className="win-body rounded-[4px] border border-[var(--critical)]/30 bg-[var(--critical-bg)] p-4 text-[var(--critical)]">
          加载失败：{error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <div className="p-4">
            <p className="win-meta">后端服务</p>
            <p className="win-subtitle mt-1 flex items-center gap-1.5">
              {health ? (
                <>
                  <span className={cn('size-2 rounded-full', health.ok ? 'bg-[var(--success)]' : 'bg-[var(--critical)]')} />
                  {health.ok ? '运行正常' : '异常'}
                </>
              ) : (
                '加载中…'
              )}
            </p>
          </div>
        </Card>
        <Card>
          <div className="p-4">
            <p className="win-meta">服务器组</p>
            <p className="win-subtitle mt-1 font-mono">{groups.length} 组</p>
          </div>
        </Card>
        <Card>
          <div className="p-4">
            <p className="win-meta">服务器数量</p>
            <p className="win-subtitle mt-1 font-mono">{serverCount} 台</p>
          </div>
        </Card>
        <Card>
          <div className="p-4">
            <p className="win-meta">最后更新</p>
            <p className="win-subtitle mt-1 font-mono">
              {health ? new Date(health.time).toLocaleTimeString('zh-CN', { hour12: false }) : '—'}
            </p>
          </div>
        </Card>
      </div>

      {groups.length === 0 && !loading && (
        <div className="win-body rounded-lg border border-dashed border-[var(--card-stroke)] py-16 text-center text-muted-foreground">
          暂无服务器组信息
        </div>
      )}

      {groups.map((group) => {
        const summary = group.summary ?? { inMatch: 0, idle: 0, stopped: 0, unknown: 0 }
        const maintenance = (health?.maintenance ?? []).find((m) => m.groupId === group.groupId) ?? null
        return (
          <Card key={group.groupId}>
            <div className="flex flex-col gap-4 p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="win-body-strong">{group.groupName}</span>
                  <Badge variant="outline" className="font-mono">{group.hostIp}</Badge>
                  <Badge variant="secondary">{group.region}</Badge>
                  {maintenance && (
                    <Badge variant="destructive">维护中{maintenance.reason ? `：${maintenance.reason}` : ''}</Badge>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="destructive">比赛中 {summary.inMatch}</Badge>
                  <Badge variant="success">空闲 {summary.idle}</Badge>
                  <Badge variant="secondary">已停止 {summary.stopped}</Badge>
                  <Badge variant="info">未知 {summary.unknown}</Badge>
                </div>
              </div>

              {maintenance && (
                <p className="win-caption rounded-[4px] bg-[var(--caution-bg)] px-2 py-1 text-[11px]">
                  该服务器组维护中{maintenance.reason ? `：${maintenance.reason}` : ''}
                  —— 期间不可开赛、不可启停实例（其他组不受影响），任务结束后自动恢复。
                </p>
              )}

              <div className="grid gap-3 md:grid-cols-2">
                {group.servers.map((srv) => {
                  const status = STATUS_META[srv.status] ?? { label: srv.statusLabel ?? srv.status, variant: 'secondary' as const }
                  const state = STATE_META[srv.state] ?? { label: `锁 ${srv.state}`, variant: 'secondary' as const }
                  const healthMeta = HEALTH_META[srv.health] ?? { label: srv.health, variant: 'secondary' as const }
                  return (
                    <div key={srv.name} className="rounded-[4px] bg-[var(--subtle-secondary)] p-3">
                      <div className="flex items-center gap-2">
                        <span className="win-body-strong font-mono">{srv.name}</span>
                        {srv.botCapable && <Badge variant="info" className="text-[9px]">人机</Badge>}
                        {srv.adminOnly && <Badge variant="info" className="text-[9px]">仅管理员</Badge>}
                        {(srv.health === 'UNKNOWN' || srv.status === 'unknown') && (
                          <Badge variant="info" className="text-[9px]">待同步</Badge>
                        )}
                        <Badge variant={status.variant} className="ml-auto">{status.label}</Badge>
                      </div>
                      <div className="win-caption mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
                        <span>
                          实例状态 <Badge variant={state.variant} className="ml-1">{state.label}</Badge>
                        </span>
                        <span>
                          运行状态 <Badge variant={healthMeta.variant} className="ml-1 font-mono">{healthMeta.label}</Badge>
                        </span>
                        <span>
                          对局 ID <span className="ml-1 font-mono text-foreground">{srv.matchId ?? '—'}</span>
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </Card>
        )
      })}
    </div>
  )
}
