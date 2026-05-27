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
 * Remux audio/webm → audio/ogg (Ogg container, Opus codec) via ffmpeg.
 * Chrome's MediaRecorder only outputs WebM, but Meta rejects audio/webm.
 * Remuxing is lossless (no re-encode) and takes ~50ms for a typical voice note.
 * Returns { buffer, fileName } with the converted Ogg file.
 */
async function remuxWebmToOgg(inputBuffer: Buffer, originalName: string): Promise<{
  buffer: Buffer
  fileName: string
}> {
  const id = randomUUID()
  const inputPath = path.join(tmpdir(), `${id}.webm`)
  const outputPath = path.join(tmpdir(), `${id}.ogg`)

  try {
    await writeFile(inputPath, inputBuffer)

    const ffmpegPath = (await import('@ffmpeg-installer/ffmpeg')).path
    await execFileAsync(ffmpegPath, [
      '-i', inputPath,
      '-c:a', 'copy',   // no re-encode — just remux the container
      '-map_metadata', '-1',  // strip metadata to keep it small
      '-y',              // overwrite output
      outputPath,
    ])

    const buffer = await readFile(outputPath)
    const fileName = originalName.replace(/\.webm$/i, '.ogg')
    return { buffer, fileName }
  } finally {
    // Best-effort cleanup — temp dir, don't block the response on it
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
    // Remux to Ogg (same Opus audio, different container) before uploading.
    if (file.type.startsWith('audio/webm')) {
      try {
        const remuxed = await remuxWebmToOgg(fileBuffer, file.name)
        fileBuffer = remuxed.buffer
        uploadMimeType = 'audio/ogg'
        uploadFileName = remuxed.fileName
      } catch (err) {
        console.error('WebM→Ogg remux failed:', err)
        // Fall back to the original bytes with the MIME label swapped —
        // Meta may still accept it at upload time (it only checks the
        // label), but delivery to the recipient is unreliable.
        uploadMimeType = 'audio/ogg'
        uploadFileName = file.name.replace(/\.webm$/i, '.ogg')
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
