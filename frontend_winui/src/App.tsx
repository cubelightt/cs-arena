// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { TooltipProvider } from '@/components/winui/tooltip'
import { Ring } from '@/components/winui/progress'
import { AppLayout } from '@/components/layout/app-layout'
import { RequireAuth } from '@/components/layout/require-auth'
import { RequireAdmin } from '@/components/layout/require-admin'
import { Toaster } from '@/components/layout/toaster'
import { HomePage } from '@/pages/home'
import { LobbyPage } from '@/pages/lobby'
import { RoomPage } from '@/pages/room'
import { MatchPage } from '@/pages/match'
import { RecordsPage } from '@/pages/records'
import { ServersPage } from '@/pages/servers'
import { AdminPage } from '@/pages/admin'
import { AdminConsolePage } from '@/pages/admin-console'
import { LoginPage } from '@/pages/login'
import { useArena } from '@/stores/arena'

function Bootstrapping() {
  const bootstrap = useArena((s) => s.bootstrap)
  const bootstrapped = useArena((s) => s.bootstrapped)

  useEffect(() => {
    bootstrap()
  }, [bootstrap])

  if (!bootstrapped) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Ring size={28} />
      </div>
    )
  }

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAdmin />}>
        <Route element={<AppLayout />}>
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/admin/console/:name" element={<AdminConsolePage />} />
        </Route>
      </Route>
      <Route element={<RequireAuth />}>
        <Route element={<AppLayout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/lobby" element={<LobbyPage />} />
          <Route path="/room/:id" element={<RoomPage />} />
          <Route path="/match/:id" element={<MatchPage />} />
          <Route path="/records" element={<RecordsPage />} />
          <Route path="/servers" element={<ServersPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <TooltipProvider delayDuration={300}>
      <BrowserRouter>
        <Bootstrapping />
      </BrowserRouter>
      <Toaster />
    </TooltipProvider>
  )
}
