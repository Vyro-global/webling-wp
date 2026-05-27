import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { uploadMedia } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import type { MediaMessageType } from '@/lib/whatsapp/meta-api'

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
    const fileBuffer = Buffer.from(await file.arrayBuffer())

    // Chrome's MediaRecorder only supports audio/webm via MediaRecorder, but
    // Meta rejects audio/webm (accepted: audio/ogg, aac, mp4, mpeg, amr, opus).
    // The underlying Opus bitstream is identical regardless of container label,
    // so remapping the MIME type before upload is safe — we're just relabelling.
    const uploadMimeType = file.type.startsWith('audio/webm')
      ? 'audio/ogg;codecs=opus'
      : file.type
    const uploadFileName = file.type.startsWith('audio/webm')
      ? file.name.replace(/\.webm$/i, '.ogg')
      : file.name

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
