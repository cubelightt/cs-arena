// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/winui.css'
import App from './App.tsx'
import { applyStoredTheme } from '@/components/winui/theme'

// 首帧前落主题类，避免浅色闪烁
applyStoredTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
