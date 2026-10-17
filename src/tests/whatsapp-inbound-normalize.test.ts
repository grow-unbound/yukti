import { describe, expect, it } from 'vitest';

import { normalizeInboundMessage } from '../../supabase/functions/_shared/whatsapp-inbound-normalize';

describe('normalizeInboundMessage', () => {
  it('keeps text and button replies as before', () => {
    expect(normalizeInboundMessage({ type: 'text', text: { body: 'hi' } })).toMatchObject({ type: 'text', text: 'hi' });
    expect(normalizeInboundMessage({ type: 'button', button: { text: 'Stop' } })).toMatchObject({
      type: 'button',
      text: 'Stop',
    });
  });

  it('maps interactive replies to a button message using the chosen title', () => {
    const result = normalizeInboundMessage({
      type: 'interactive',
      interactive: { type: 'list_reply', list_reply: { title: 'Catalog' } },
    });
    expect(result).toMatchObject({ type: 'button', text: 'Catalog' });
  });

  it.each(['image', 'audio', 'video', 'document', 'sticker'] as const)(
    'captures %s with media id and caption but never stores the caption in metadata',
    (type) => {
      const result = normalizeInboundMessage({
        type,
        [type]: { id: 'media-1', mime_type: 'x/y', sha256: 'abc', filename: 'f.pdf', caption: 'see this' },
      });
      expect(result?.type).toBe(type);
      expect(result?.text).toBe('see this');
      expect(result?.extra).toEqual({
        media: { id: 'media-1', mime_type: 'x/y', sha256: 'abc', filename: 'f.pdf' },
      });
      expect(JSON.stringify(result?.extra)).not.toContain('see this');
    },
  );

  it('captures media without a caption', () => {
    const result = normalizeInboundMessage({ type: 'image', image: { id: 'm' } });
    expect(result).toMatchObject({ type: 'image', text: null });
  });

  it('captures location and contacts without coordinates or card details', () => {
    const loc = normalizeInboundMessage({ type: 'location', location: { name: 'Shop', address: 'MG Road' } });
    expect(loc).toMatchObject({ type: 'location', text: null, extra: { location: { name: 'Shop', address: 'MG Road' } } });
    const contacts = normalizeInboundMessage({ type: 'contacts', contacts: [{}, {}] });
    expect(contacts).toMatchObject({ type: 'contacts', extra: { contact_count: 2 } });
  });

  it.each(['reaction', 'system', 'order', 'unsupported', undefined])('ignores %s messages', (type) => {
    expect(normalizeInboundMessage({ type })).toBeNull();
  });
});
