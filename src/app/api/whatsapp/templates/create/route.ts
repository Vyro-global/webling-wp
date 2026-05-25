import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import { createTemplateOnMeta } from '@/lib/whatsapp/meta-api'

/**
 * Create a new message template: submit to Meta for approval, then
 * save locally. Previously templates were only saved as Draft locally
 * and never reached Meta — users would try to send them and hit
 * error #132001 "Template name does not exist in the translation".
 *
 * This route bridges the gap: the user fills the form once, we submit
 * to Meta (which validates the structure), and store the result.
 */

const META_CATEGORIES: Record<string, 'MARKETING' | 'UTILITY' | 'AUTHENTICATION'> =
  {
    Marketing: 'MARKETING',
    Utility: 'UTILITY',
    Authentication: 'AUTHENTICATION',
  }

/**
 * Validate template name per Meta's rules:
 * - 1-512 characters
 * - Only lowercase letters, numbers, underscores
 * - Must start with a letter
 */
function isValidTemplateName(name: string): boolean {
  return /^[a-z][a-z0-9_]{0,511}$/.test(name)
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { name, category, language, body_text, header_type, header_content, footer_text } =
      body

    // --- Validate inputs ---
    if (!name?.trim()) {
      return NextResponse.json(
        { error: 'Template name is required' },
        { status: 400 },
      )
    }

    if (!isValidTemplateName(name.trim())) {
      return NextResponse.json(
        {
          error:
            'Template name must start with a letter and contain only ' +
            'lowercase letters, numbers, and underscores.',
        },
        { status: 400 },
      )
    }

    if (!body_text?.trim()) {
      return NextResponse.json(
        { error: 'Body text is required' },
        { status: 400 },
      )
    }

    const metaCategory = META_CATEGORIES[category]
    if (!metaCategory) {
      return NextResponse.json(
        { error: 'Invalid category. Must be Marketing, Utility, or Authentication.' },
        { status: 400 },
      )
    }

    const lang = language?.trim() || 'en_US'

    // --- Fetch WhatsApp config (needs waba_id + access token) ---
    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('user_id', user.id)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        {
          error:
            'WhatsApp not configured. Connect your WhatsApp Business account in Settings first.',
        },
        { status: 400 },
      )
    }

    if (!config.waba_id) {
      return NextResponse.json(
        {
          error:
            'WABA (WhatsApp Business Account) ID missing. Re-connect your account in Settings.',
        },
        { status: 400 },
      )
    }

    const accessToken = decrypt(config.access_token)

    // --- Submit to Meta ---
    let metaResult: { id: string; status: string }
    try {
      metaResult = await createTemplateOnMeta({
        wabaId: config.waba_id,
        accessToken,
        name: name.trim(),
        category: metaCategory,
        language: lang,
        bodyText: body_text.trim(),
        headerType: header_type ? header_type.toUpperCase() : undefined,
        headerContent: header_content?.trim() || undefined,
        footerText: footer_text?.trim() || undefined,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      console.error('Meta template creation failed:', message)
      return NextResponse.json(
        { error: `Meta rejected the template: ${message}` },
        { status: 502 },
      )
    }

    // --- Save locally ---
    // Meta returns "PENDING" or "APPROVED" for templates that pass validation
    const localStatus =
      metaResult.status === 'APPROVED'
        ? 'Approved'
        : metaResult.status === 'PENDING'
          ? 'Pending'
          : 'Pending'

    const { data: saved, error: saveError } = await supabase
      .from('message_templates')
      .insert({
        user_id: user.id,
        name: name.trim(),
        category,
        language: lang,
        header_type: header_type || null,
        header_content: header_content?.trim() || null,
        body_text: body_text.trim(),
        footer_text: footer_text?.trim() || null,
        status: localStatus,
      })
      .select()
      .single()

    if (saveError) {
      console.error('Template saved to Meta but failed to save locally:', saveError)
      return NextResponse.json(
        {
          warning:
            'Template was created on Meta but could not be saved locally. ' +
            'Use "Sync from Meta" to pull it.',
          meta_id: metaResult.id,
          meta_status: metaResult.status,
        },
        { status: 500 },
      )
    }

    return NextResponse.json({
      success: true,
      template: saved,
      meta_id: metaResult.id,
      meta_status: metaResult.status,
    })
  } catch (error) {
    console.error('Error creating template:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to create template',
      },
      { status: 500 },
    )
  }
}
