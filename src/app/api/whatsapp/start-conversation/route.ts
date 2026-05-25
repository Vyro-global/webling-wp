import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isValidE164, sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils'

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
    const { phone, name } = body

    if (!phone?.trim()) {
      return NextResponse.json(
        { error: 'Phone number is required' },
        { status: 400 },
      )
    }

    // Validate phone — accept with or without + prefix
    const sanitized = sanitizePhoneForMeta(phone)
    if (!isValidE164(sanitized)) {
      return NextResponse.json(
        {
          error:
            'Invalid phone number. Include country code, e.g. +1 for US.',
        },
        { status: 400 },
      )
    }

    // Normalise to E.164 with + prefix for storage
    const e164Phone = `+${sanitized}`

    // --- Find or create contact ---
    const { data: existingContact } = await supabase
      .from('contacts')
      .select('*')
      .eq('user_id', user.id)
      .eq('phone', e164Phone)
      .maybeSingle()

    let contactId: string
    if (existingContact) {
      contactId = existingContact.id
      // Update name if provided and contact has no name yet
      if (name?.trim() && !existingContact.name) {
        await supabase
          .from('contacts')
          .update({ name: name.trim(), updated_at: new Date().toISOString() })
          .eq('id', contactId)
      }
    } else {
      const { data: newContact, error: createError } = await supabase
        .from('contacts')
        .insert({
          user_id: user.id,
          phone: e164Phone,
          name: name?.trim() || null,
        })
        .select()
        .single()

      if (createError) {
        console.error('Failed to create contact:', createError)
        return NextResponse.json(
          { error: 'Failed to create contact' },
          { status: 500 },
        )
      }
      contactId = newContact.id
    }

    // --- Find or create conversation ---
    const { data: existingConversation } = await supabase
      .from('conversations')
      .select('*, contact:contacts(*)')
      .eq('user_id', user.id)
      .eq('contact_id', contactId)
      .maybeSingle()

    if (existingConversation) {
      return NextResponse.json({ conversation: existingConversation })
    }

    const { data: newConversation, error: convError } = await supabase
      .from('conversations')
      .insert({
        user_id: user.id,
        contact_id: contactId,
        status: 'open',
      })
      .select('*, contact:contacts(*)')
      .single()

    if (convError) {
      console.error('Failed to create conversation:', convError)
      return NextResponse.json(
        { error: 'Failed to create conversation' },
        { status: 500 },
      )
    }

    return NextResponse.json({ conversation: newConversation })
  } catch (error) {
    console.error('Error in start-conversation:', error)
    return NextResponse.json(
      { error: 'Failed to start conversation' },
      { status: 500 },
    )
  }
}
