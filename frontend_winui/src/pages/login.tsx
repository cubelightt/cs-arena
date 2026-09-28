// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Loader2, Swords } from 'lucide-react'
import { Button } from '@/components/winui/button'
import { Card, CardContent } from '@/components/winui/card'
import { Input } from '@/components/winui/input'
import { Label } from '@/components/winui/label'
import { Separator } from '@/components/winui/separator'
import { useArena } from '@/stores/arena'
import { ApiError } from '@/lib/api'
import { DEMO_USER, fetchSteamProfile, parseSteamInput } from '@/lib/steam'

type Step = 'input' | 'admin_password' | 'admin_setup'

export function LoginPage() {
  const login = useArena((s) => s.login)
  const loginWithPassword = useArena((s) => s.loginWithPassword)
  const setupPassword = useArena((s) => s.setupPassword)
  const navigate = useNavigate()
  const location = useLocation()
  const [input, setInput] = useState('')
  const [step, setStep] = useState<Step>('input')
  const [steamId, setSteamId] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const from = (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? '/'

  // OpenID 回调：管理员由后端引导回来（?admin_login=1&admin_setup=0|1&admin_steam_id=...）
  const adminQuery = useMemo(() => {
    const q = new URLSearchParams(location.search)
    if (q.get('admin_login') !== '1') return null
    return {
      setup: q.get('admin_setup') === '1',
      steamId: q.get('admin_steam_id') ?? '',
    }
  }, [location.search])

  // 首次渲染：若带管理员参数直接进入对应步骤（仅应用一次，防止输入被覆盖）
  const appliedAdmin = useRef(false)
  useEffect(() => {
    if (adminQuery && !appliedAdmin.current) {
      appliedAdmin.current = true
      setSteamId(adminQuery.steamId)
      setStep(adminQuery.setup ? 'admin_setup' : 'admin_password')
    }
  }, [adminQuery])

  const clearQuery = () => {
    history.replaceState(null, '', location.pathname + location.search.replace(/[?&]admin_login=[^&]*(&|$)/, '$1').replace(/[?&]admin_setup=[^&]*(&|$)/, '$1').replace(/[?&]admin_steam_id=[^&]*(&|$)/, '$1').replace(/[?&]$/, ''))
  }

  const finish = (target = from) => {
    clearQuery()
    navigate(target, { replace: true })
  }

  // 手动输入：先尝试免密登录，管理员则被后端引导进入密码步骤
  const handleManual = async () => {
    const parsed = parseSteamInput(input)
    if (!parsed) {
      setError('请输入 Steam ID（17 位）、个人资料链接或自定义 URL')
      return
    }
    setLoading(true)
    setError('')
    try {
      let profile: { steamId: string; name: string; avatarUrl: string }
      try {
        profile = await fetchSteamProfile(parsed)
      } catch (e) {
        const isPureId = /^\d{17}$/.test(parsed)
        if (!isPureId) throw e
        // 降级：仅提交 steamId，由后端自行解析真实资料（避免 SteamUser 占位）
        profile = { steamId: parsed, name: '', avatarUrl: '' }
      }
      await login(profile)
      finish()
    } catch (e) {
      const parsedFallback = parseSteamInput(input) ?? ''
      if (e instanceof ApiError) {
        if (e.status === 403 && e.code === 'PASSWORD_SETUP_REQUIRED') {
          setSteamId(parsedFallback)
          setStep('admin_setup')
          setError('该账号为管理员，首次登录请先设置密码')
        } else if (e.status === 401) {
          setSteamId(parsedFallback)
          setStep('admin_password')
          setError('该账号为管理员，请输入密码登录')
        } else {
          setError(e.message)
        }
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
      setLoading(false)
    }
  }

  // 演示账号：与其它登录路径一致地给反馈（失败必须可见——后端不可达时
  // 静默失败会表现为“点了没反应”，排查成本极高）
  const handleDemo = async () => {
    setLoading(true)
    setError('')
    try {
      await login(DEMO_USER)
      finish()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setLoading(false)
    }
  }

  // 管理员输入密码登录
  const handlePasswordLogin = async () => {
    if (!password) {
      setError('请输入密码')
      return
    }
    setLoading(true)
    setError('')
    try {
      await loginWithPassword(steamId, password)
      finish()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setLoading(false)
    }
  }

  // 管理员首次设置密码
  const handleSetupPassword = async () => {
    if (!steamId) {
      setError('缺少 Steam ID')
      return
    }
    if (password.length < 6) {
      setError('密码长度至少 6 位')
      return
    }
    if (password !== confirmPassword) {
      setError('两次输入的密码不一致')
      return
    }
    setLoading(true)
    setError('')
    try {
      await setupPassword(steamId, password)
      finish()
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setError('密码已设置，请直接登录')
        setStep('admin_password')
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
      setLoading(false)
    }
  }

  const backToInput = () => {
    setStep('input')
    setPassword('')
    setConfirmPassword('')
    setError('')
    clearQuery()
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <span className="flex size-12 items-center justify-center rounded-lg bg-[var(--accent)] text-[var(--on-accent)]">
            <Swords className="size-6" />
          </span>
          <div>
            <h1 className="win-title">
              CS <span className="text-[var(--accent-text)]">ARENA</span>
            </h1>
            <p className="win-body mt-1 text-muted-foreground">使用 Steam 账号登录</p>
          </div>
        </div>

        <Card>
          <CardContent className="flex flex-col gap-4 p-6">
            {step === 'input' ? (
              <>
                <Button
                  size="lg"
                  className="w-full bg-[#171a21] text-white hover:bg-[#2a475e]"
                  onClick={() => {
                    const returnTo = encodeURIComponent(location.pathname + location.search)
                    window.location.href = `/api/auth/steam/login?returnTo=${returnTo}`
                  }}
                  disabled={loading}
                >
                  通过 Steam 登录
                </Button>

                <div className="flex items-center gap-3">
                  <Separator className="flex-1" />
                  <span className="win-caption text-muted-foreground">或手动输入</span>
                  <Separator className="flex-1" />
                </div>

                <div className="flex flex-col gap-2">
                  <Input
                    placeholder="SteamID / 资料链接 / 自定义URL"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleManual()}
                    disabled={loading}
                  />
                  {error && <p className="win-caption text-[var(--critical)]">{error}</p>}
                  <Button variant="outline" onClick={handleManual} disabled={loading || !input.trim()}>
                    {loading && <Loader2 className="size-4 animate-spin" />}
                    获取 Steam 资料
                  </Button>
                </div>

                <div className="flex items-center justify-between border-t border-[var(--divider)] pt-4">
                  <span className="win-caption text-muted-foreground">登录后记录将以 Steam ID 识别</span>
                  <Button variant="ghost" size="sm" onClick={handleDemo} disabled={loading}>
                    {loading && <Loader2 className="size-4 animate-spin" />}
                    使用演示账号
                  </Button>
                </div>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  variant="subtle"
                  size="sm"
                  onClick={backToInput}
                  disabled={loading}
                  className="-ml-1 self-start"
                >
                  返回上一步
                </Button>
                <div>
                  <p className="win-body-strong">{step === 'admin_setup' ? '设置管理员密码' : '管理员登录'}</p>
                  <p className="win-caption mt-0.5 text-muted-foreground">
                    {step === 'admin_setup' ? '首次登录需设置密码（至少 6 位）' : '请输入管理员密码'}
                  </p>
                </div>

                <div className="grid gap-2">
                  <Label>Steam ID</Label>
                  <Input value={steamId} readOnly disabled className="font-mono" />
                </div>

                <div className="grid gap-2">
                  <Label>{step === 'admin_setup' ? '设置密码（至少 6 位）' : '密码'}</Label>
                  <Input
                    type="password"
                    placeholder="********"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) =>
                      e.key === 'Enter' && (step === 'admin_setup' ? handleSetupPassword() : handlePasswordLogin())
                    }
                    disabled={loading}
                    autoFocus
                  />
                </div>

                {step === 'admin_setup' && (
                  <div className="grid gap-2">
                    <Label>确认密码</Label>
                    <Input
                      type="password"
                      placeholder="再次输入密码"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSetupPassword()}
                      disabled={loading}
                    />
                  </div>
                )}

                {error && <p className="win-caption text-[var(--critical)]">{error}</p>}

                <Button
                  onClick={step === 'admin_setup' ? handleSetupPassword : handlePasswordLogin}
                  disabled={loading}
                >
                  {loading && <Loader2 className="size-4 animate-spin" />}
                  {step === 'admin_setup' ? '设置密码并登录' : '登录'}
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        <p className="win-caption mt-4 text-center leading-relaxed text-muted-foreground">
          开发环境：演示账号与手动输入直接调用后端登录接口，
          <br />
          Steam OpenID 需后端配置 PUBLIC_BASE_URL 后方可跳转。
        </p>
      </div>
    </div>
  )
}
