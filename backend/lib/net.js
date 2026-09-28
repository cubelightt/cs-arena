// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 网络辅助:host_ip 的纯 IP 判定与域名解析
// 域名保持原样存储/展示,仅在开赛(写 room.server)时解析为 IP 供玩家连接(支持动态 DNS)
import { lookup } from 'node:dns/promises'

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/

// 纯 IP(IPv4 点分 / 含冒号的 IPv6)→ 不做 DNS
export function isPlainIp(host) {
  if (!host) return false
  if (IPV4_RE.test(host)) return true
  if (host.includes(':')) return true
  return false
}

// 解析 host:纯 IP 原样返回;域名 IPv4 优先(lookup family:4);失败/仅 AAAA 回退原值
export async function resolveHostIp(host) {
  const value = String(host || '')
  if (!value || isPlainIp(value)) return value
  try {
    const { address } = await lookup(value, { family: 4 })
    return address || value
  } catch {
    return value
  }
}
