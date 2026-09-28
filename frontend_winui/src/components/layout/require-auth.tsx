// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useArena } from '@/stores/arena'

const ADMIN_PARAMS = ['admin_login', 'admin_setup', 'admin_steam_id']

export function RequireAuth() {
  const user = useArena((s) => s.currentUser)
  const location = useLocation()
  if (!user) {
    // OpenID 管理员回调落在站内页面时，透传管理员参数到登录页
    const params = new URLSearchParams(location.search)
    const admin = ADMIN_PARAMS.filter((k) => params.get(k) !== null)
    const to = admin.length > 0 ? `/login?${admin.map((k) => `${k}=${encodeURIComponent(params.get(k) ?? '')}`).join('&')}` : '/login'
    return <Navigate to={to} state={{ from: location }} replace />
  }
  return <Outlet />
}
