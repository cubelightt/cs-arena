// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { Navigate, Outlet } from 'react-router-dom'
import { useArena } from '@/stores/arena'

export function RequireAdmin() {
  const user = useArena((s) => s.currentUser)
  if (!user) {
    return <Navigate to="/login" replace />
  }
  if (!user.isAdmin) {
    return <Navigate to="/" replace />
  }
  return <Outlet />
}
