import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { uploadMedia } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import type { MediaMessageType } from '@/lib/whatsapp/meta-api'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { writeFile, readFile, unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import path from 'path'
import { existsSync } from 'fs'

const execFileAsync = promisify(execFile)

const MAX_BYTES: Record<MediaMessageType, number> = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  document: 100 * 1024 * 1024,
}

function mimeToMediaType(mimeType: string): MediaMessageType {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  return 'document'
}

function ffmpegPath(): string {
  // Static binary downloaded during Vercel build (see vercel.json)
  const bundledPath = path.resolve(process.cwd(), 'ffmpeg')
  if (existsSync(bundledPath)) return bundledPath
  // System ffmpeg (macOS Homebrew / Linux)
  return 'ffmpeg'
}

async function convertWebmToMp4(inputBuffer: Buffer, originalName: string): Promise<{
  buffer: Buffer
  fileName: string
}> {
  const id = randomUUID()
  const inputPath = path.join(tmpdir(), `${id}.webm`)
  const outputPath = path.join(tmpdir(), `${id}.mp4`)

  try {
    await writeFile(inputPath, inputBuffer)
    await execFileAsync(ffmpegPath(), [
      '-i', inputPath,
      '-c:a', 'aac',
      '-b:a', '64k',
      '-ac', '1',
      '-map_metadata', '-1',
      '-movflags', '+faststart',
      '-y',
      outputPath,
    ])
    const buffer = await readFile(outputPath)
    const fileName = originalName.replace(/\.webm$/i, '.mp4')
    return { buffer, fileName }
  } finally {
    unlink(inputPath).catch(() => {})
    unlink(outputPath).catch(() => {})
  }
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const limit = checkRateLimit(`send:${user.id}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const formData = await request.formData()
    const file = formData.get('file') as File | null
    if (!file) {
      return NextResponse.json({ error: 'file is required' }, { status: 400 })
    }

    const mediaType = mimeToMediaType(file.type)
    const maxBytes = MAX_BYTES[mediaType]
    if (file.size > maxBytes) {
      return NextResponse.json(
        { error: `File too large. Max for ${mediaType}: ${maxBytes / 1024 / 1024} MB` },
        { status: 400 },
      )
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('user_id', user.id)
      .single()

    if (configError || !config) {
      return NextResponse.json({ error: 'WhatsApp not configured' }, { status: 400 })
    }

    const accessToken = decrypt(config.access_token)
    let fileBuffer: Buffer = Buffer.from(await file.arrayBuffer())
    let uploadMimeType = file.type
    let uploadFileName = file.name

    if (file.type.startsWith('audio/webm')) {
      try {
        const converted = await convertWebmToMp4(fileBuffer, file.name)
        fileBuffer = converted.buffer
        uploadMimeType = 'audio/mp4'
        uploadFileName = converted.fileName
      } catch (err) {
        console.error('WebM→MP4 conversion failed:', err)
        return NextResponse.json(
          { error: 'Voice encoding failed. Please try again.' },
          { status: 500 },
        )
      }
    }

    const { mediaId } = await uploadMedia({
      phoneNumberId: config.phone_number_id,
      accessToken,
      fileBuffer,
      mimeType: uploadMimeType,
      fileName: uploadFileName,
    })

    return NextResponse.json({ media_id: mediaId, media_type: mediaType })
  } catch (error) {
    console.error('Error in WhatsApp upload-media POST:', error)
    const message = error instanceof Error ? error.message : 'Upload failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
