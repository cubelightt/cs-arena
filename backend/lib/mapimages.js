// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 cubelightt

// 社区地图缩略图存储(仅管理员上传,公开只读)
// 展示口径与总竞技图池官方图一致:官方图缩略图为前端静态资源 public/maps/<官方名>.webp,
// 社区图 id = workshopId(数字串),后端统一转 **WebP** 存储为 <workshopId>.webp(mapImage.dir),
// 经 GET /api/settings/community-maps/:workshopId/thumbnail 提供访问(稳定 URL,前端 <img> 直连)。
// 上传接受 PNG / JPEG / WebP(魔数嗅探),经 sharp 统一重编码为 WebP。
import fs from 'node:fs'
import path from 'node:path'
import config from '../config.js'

export const MAP_IMAGE_MAX_BYTES = config.mapImage.maxBytes

const THUMB_EXT = 'webp'
const THUMB_CONTENT_TYPE = 'image/webp'

function imageDir() {
  return config.mapImage.dir
}

function thumbPath(workshopId) {
  return path.join(imageDir(), `${workshopId}.${THUMB_EXT}`)
}

// 魔数嗅探上传图片类型 → 扩展名;非识别类型返回 null(拒绝)
export function sniffImageExt(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  return null
}

export function hasThumbnail(workshopId) {
  try {
    return fs.statSync(thumbPath(String(workshopId))).isFile()
  } catch {
    return false
  }
}

export function readThumbnail(workshopId) {
  try {
    return { buf: fs.readFileSync(thumbPath(String(workshopId))), contentType: THUMB_CONTENT_TYPE }
  } catch {
    return null
  }
}

// 保存(覆盖式):统一转 WebP 后原子落盘(tmp+rename,与 demo 上传同口径)
export async function saveThumbnail(workshopId, buf) {
  const sharp = (await import('sharp')).default
  const webp = await sharp(buf).webp({ quality: 85 }).toBuffer()
  const dir = imageDir()
  fs.mkdirSync(dir, { recursive: true })
  const p = thumbPath(String(workshopId))
  const tmp = `${p}.tmp`
  fs.writeFileSync(tmp, webp)
  fs.renameSync(tmp, p)
  return p
}

export function deleteThumbnail(workshopId) {
  try {
    fs.unlinkSync(thumbPath(String(workshopId)))
    return true
  } catch {
    return false
  }
}
