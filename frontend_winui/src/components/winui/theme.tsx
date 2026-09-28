// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { useCallback, useEffect, useState } from 'react'

export type ThemeMode = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'cs-arena-theme'
const THEME_EVENT = 'cs-arena-theme-change'

function readStored(): ThemeMode {
  const raw = localStorage.getItem(STORAGE_KEY)
  return raw === 'light' || raw === 'dark' ? raw : 'system'
}

function apply(mode: ThemeMode) {
  const root = document.documentElement
  root.classList.toggle('theme-dark', mode === 'dark')
  root.classList.toggle('theme-light', mode === 'light')
}

/** 在 <html> 上写入主题类；system 模式交给 prefers-color-scheme。 */
export function applyStoredTheme() {
  apply(readStored())
}

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(() => readStored())

  useEffect(() => {
    apply(mode)
  }, [mode])

  useEffect(() => {
    const sync = () => setMode(readStored())
    window.addEventListener(THEME_EVENT, sync)
    return () => window.removeEventListener(THEME_EVENT, sync)
  }, [])

  const update = useCallback((next: ThemeMode) => {
    if (next === 'system') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, next)
    window.dispatchEvent(new Event(THEME_EVENT))
  }, [])

  return { mode, setMode: update }
}
