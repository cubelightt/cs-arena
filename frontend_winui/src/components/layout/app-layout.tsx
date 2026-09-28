// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { useState } from 'react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import {
  ArrowRightToLine,
  Gamepad2,
  History,
  House,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Plus,
  Server,
  ShieldCheck,
  Sun,
  Swords,
  X,
} from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/winui/avatar'
import { Button } from '@/components/winui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/winui/dropdown-menu'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/winui/dialog'
import { NavigationHeader, NavigationItem } from '@/components/winui/navigation-view'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/winui/tooltip'
import { CreateRoomDialog } from '@/components/match/create-room-dialog'
import { JoinCodeForm } from '@/components/layout/quick-join'
import { useTheme, type ThemeMode } from '@/components/winui/theme'
import { useArena } from '@/stores/arena'
import { cn } from '@/lib/utils'

/**
 * WinUI 布局外壳：TitleBar + NavigationView。
 * 桌面端 = 展开的导航窗格（lg，280px）+ 紧凑图标栏（md，48px）；
 * 窄屏（<md）= LeftMinimal：汉堡按钮 + 抽屉式覆盖窗格（取代 v2 的底部导航）。
 * 创建房间 / 房间码加入（原「命令坞」）保留在窗格底部，任何断点均可达。
 */
const NAV_ITEMS = [
  { to: '/', label: '首页', icon: House },
  { to: '/lobby', label: '房间大厅', icon: Gamepad2 },
  { to: '/records', label: '比赛记录', icon: History },
  { to: '/servers', label: '服务器状态', icon: Server },
]

const THEME_ORDER: ThemeMode[] = ['system', 'light', 'dark']
const THEME_META = {
  system: { icon: Monitor, label: '主题：跟随系统' },
  light: { icon: Sun, label: '主题：浅色' },
  dark: { icon: Moon, label: '主题：深色' },
} as const

function ThemeToggle({ className }: { className?: string }) {
  const { mode, setMode } = useTheme()
  const { icon: Icon, label } = THEME_META[mode]
  const next = THEME_ORDER[(THEME_ORDER.indexOf(mode) + 1) % THEME_ORDER.length]

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="subtle"
          size="icon"
          className={className}
          aria-label={label}
          onClick={() => setMode(next)}
        >
          <Icon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function UserMenu({ compact }: { compact?: boolean }) {
  const currentUser = useArena((s) => s.currentUser)
  const logout = useArena((s) => s.logout)
  const navigate = useNavigate()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            'win-tile flex w-full cursor-pointer items-center gap-3 p-2 text-left outline-none',
            compact && 'w-auto',
          )}
        >
          <Avatar className="size-7">
            <AvatarImage src={currentUser?.avatarUrl} />
            <AvatarFallback>{currentUser?.name.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          {!compact && (
            <span className="min-w-0 flex-1">
              <span className="win-body block truncate">{currentUser?.name}</span>
              <span className="win-caption block truncate font-mono text-muted-foreground">
                {currentUser?.steamId}
              </span>
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side={compact ? 'bottom' : 'top'} align="end" className="min-w-48">
        {currentUser?.isAdmin && (
          <>
            <DropdownMenuItem onSelect={() => navigate('/admin')}>
              <ShieldCheck className="size-4" />
              管理面板
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onSelect={() => navigate('/records')}>
          <History className="size-4" />
          比赛记录
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          danger
          onSelect={async () => {
            await logout()
            navigate('/login')
          }}
        >
          <LogOut className="size-4" />
          退出登录
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** 窄屏进入房间码的方式：一个最小内容对话框 */
function JoinCodeDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[400px]">
        <DialogHeader>
          <DialogTitle>输入房间码加入</DialogTitle>
        </DialogHeader>
        <JoinCodeForm size="lg" />
      </DialogContent>
    </Dialog>
  )
}

export function AppLayout() {
  const currentUser = useArena((s) => s.currentUser)
  const [createOpen, setCreateOpen] = useState(false)
  const [joinOpen, setJoinOpen] = useState(false)
  const [paneOpen, setPaneOpen] = useState(false)

  const navItems = [
    ...NAV_ITEMS,
    ...(currentUser?.isAdmin ? [{ to: '/admin', label: '管理面板', icon: ShieldCheck }] : []),
  ]

  /** 窗格内容：展开态（full）与紧凑态（compact）共用 */
  const paneContent = (mode: 'full' | 'compact') => (
    <>
      <nav className={cn('flex flex-1 flex-col gap-0.5 overflow-y-auto pb-2', mode === 'full' ? 'px-2' : 'px-1')}>
        {mode === 'full' ? (
          navItems.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === '/'} className="block outline-none">
              {({ isActive }) => (
                <NavigationItem active={isActive} icon={<item.icon className="size-4" />} onClick={() => setPaneOpen(false)}>
                  {item.label}
                </NavigationItem>
              )}
            </NavLink>
          ))
        ) : (
          navItems.map((item) => (
            <Tooltip key={item.to}>
              <TooltipTrigger asChild>
                <NavLink to={item.to} end={item.to === '/'} className="block outline-none">
                  {({ isActive }) => (
                    <NavigationItem
                      active={isActive}
                      className="justify-center px-0"
                      icon={<item.icon className="size-4" />}
                    >
                      <span className="sr-only">{item.label}</span>
                    </NavigationItem>
                  )}
                </NavLink>
              </TooltipTrigger>
              <TooltipContent side="right">{item.label}</TooltipContent>
            </Tooltip>
          ))
        )}
      </nav>

      {/* 窗格底部：创建 / 加入命令区 + 账号 */}
      <div className={cn('border-t border-[var(--divider)]', mode === 'full' ? 'space-y-3 p-3' : 'space-y-2 p-1')}>
        {mode === 'full' ? (
          <>
            <Button className="w-full" onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              创建房间
            </Button>
            <JoinCodeForm />
          </>
        ) : (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon" className="w-full" aria-label="创建房间" onClick={() => setCreateOpen(true)}>
                  <Plus className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">创建房间</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="secondary"
                  size="icon"
                  className="w-full"
                  aria-label="房间码加入"
                  onClick={() => setJoinOpen(true)}
                >
                  <ArrowRightToLine className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">房间码加入</TooltipContent>
            </Tooltip>
          </>
        )}
        <div className={cn('border-t border-[var(--divider)] pt-2', mode === 'compact' && 'flex justify-center')}>
          <UserMenu compact={mode === 'compact'} />
        </div>
      </div>
    </>
  )

  return (
    <div className="min-h-screen">
      {/* 标题栏 */}
      <header className="win-titlebar sticky top-0 z-40 flex h-12 items-center gap-2 px-3">
        <Button
          variant="subtle"
          size="icon"
          className="md:hidden"
          aria-label="打开导航"
          onClick={() => setPaneOpen(true)}
        >
          <Menu className="size-4" />
        </Button>
        <Link to="/" className="flex items-center gap-2.5 outline-none">
          <span className="flex size-6 items-center justify-center rounded-[4px] bg-[var(--accent)] text-[var(--on-accent)]">
            <Swords className="size-3.5" />
          </span>
          <span className="win-body-strong">CS Arena</span>
        </Link>
        <div className="flex-1" />
        <ThemeToggle />
        <div className="md:hidden">
          <UserMenu compact />
        </div>
      </header>

      <div className="flex">
        {/* 桌面窗格：lg 展开 280px / md 紧凑 48px（WinUI 紧凑窗格规格：40px 条目） */}
        <aside className="win-nav-pane sticky top-12 hidden h-[calc(100vh-3rem)] shrink-0 flex-col md:flex md:w-12 lg:w-[280px]">
          <div className="hidden lg:block">
            <NavigationHeader>导航</NavigationHeader>
          </div>
          <div className="lg:hidden">
            <div className="h-2" />
          </div>
          {/* 窗格内两段（导航列表 / 底部命令区）必须纵向排列：
              少了 flex-col 会退化成行排列，导航被挤成最左侧一条细缝并与命令区重叠 */}
          <div className="hidden min-h-0 flex-1 flex-col lg:flex">{paneContent('full')}</div>
          <div className="flex min-h-0 flex-1 flex-col lg:hidden">{paneContent('compact')}</div>
        </aside>

        {/* 窄屏窗格：LeftMinimal 覆盖式 */}
        {paneOpen && (
          <div className="fixed inset-0 z-50 md:hidden">
            <div className="win-overlay absolute inset-0" onClick={() => setPaneOpen(false)} />
            <div className="win-nav-pane absolute inset-y-0 left-0 flex w-[280px] flex-col">
              <div className="flex h-12 items-center justify-between px-3">
                <span className="win-body-strong">导航</span>
                <Button variant="subtle" size="icon" aria-label="关闭导航" onClick={() => setPaneOpen(false)}>
                  <X className="size-4" />
                </Button>
              </div>
              {paneContent('full')}
            </div>
          </div>
        )}

        <main className="min-w-0 flex-1">
          <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-6">
            <Outlet />
          </div>
        </main>
      </div>

      <CreateRoomDialog open={createOpen} onOpenChange={setCreateOpen} />
      <JoinCodeDialog open={joinOpen} onOpenChange={setJoinOpen} />
    </div>
  )
}
