// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function generateCode(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = ''
  for (let i = 0; i < len; i++) {
    out += chars[Math.floor(Math.random() * chars.length)]
  }
  return out
}

export function hashToSeed(str: string) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function pseudoIp(seed: number) {
  const a = 51 + (seed % 60)
  const b = 100 + ((seed >>> 8) % 155)
  const c = (seed >>> 16) % 255
  return `${a}.${b}.${c}.${100 + ((seed >>> 24) % 100)}`
}

export function pseudoPort(seed: number) {
  return 27000 + ((seed >>> 4) % 2000)
}
