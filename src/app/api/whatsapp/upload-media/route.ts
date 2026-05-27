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

/**
 * Convert audio/webm → audio/mp4 (AAC in MP4 container) via ffmpeg.
 * Chrome's MediaRecorder only outputs WebM (Opus in WebM container),
 * but Meta rejects audio/webm. AAC in MP4 is universally accepted by
 * WhatsApp and plays natively on all devices.
 *
 * Re-encodes at 64 kbps mono — more than enough for voice, and the
 * file stays small. Takes ~200ms for a typical voice note.
 */
async function convertWebmToMp4(inputBuffer: Buffer, originalName: string): Promise<{
  buffer: Buffer
  fileName: string
}> {
  const id = randomUUID()
  const inputPath = path.join(tmpdir(), `${id}.webm`)
  const outputPath = path.join(tmpdir(), `${id}.mp4`)

  try {
    await writeFile(inputPath, inputBuffer)

    await execFileAsync('ffmpeg', [
      '-i', inputPath,
      '-c:a', 'aac',         // AAC encoder
      '-b:a', '64k',         // 64 kbps — fine for voice
      '-ac', '1',            // mono
      '-map_metadata', '-1', // strip metadata
      '-movflags', '+faststart', // streaming-friendly MP4
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

    // Chrome's MediaRecorder only outputs WebM, but Meta rejects audio/webm.
    // Re-encode to AAC-in-MP4, the most widely supported audio format on
    // WhatsApp (plays on all devices, no container-compatibility issues).
    if (file.type.startsWith('audio/webm')) {
      try {
        const converted = await convertWebmToMp4(fileBuffer, file.name)
        fileBuffer = converted.buffer
        uploadMimeType = 'audio/mp4'
        uploadFileName = converted.fileName
      } catch (err) {
        console.error('WebM→MP4 conversion failed:', err)
        // Fall back to the original bytes with a MIME label swap.
        // Meta may accept the upload but delivery to the recipient is
        // unreliable (WhatsApp may reject the WebM container).
        uploadMimeType = 'audio/mp4'
        uploadFileName = file.name.replace(/\.webm$/i, '.mp4')
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
