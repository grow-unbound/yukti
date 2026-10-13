// Pure (no Deno APIs) so it is unit-testable from vitest.
export interface MetaMediaPayload {
  id?: string;
  mime_type?: string;
  sha256?: string;
  filename?: string;
  caption?: string;
}

export interface MetaInboundMessage {
  id?: string;
  from?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  button?: { text?: string };
  interactive?: {
    type?: string;
    button_reply?: { title?: string };
    list_reply?: { title?: string };
  };
  image?: MetaMediaPayload;
  audio?: MetaMediaPayload;
  video?: MetaMediaPayload;
  document?: MetaMediaPayload;
  sticker?: MetaMediaPayload;
  location?: { name?: string; address?: string };
  contacts?: unknown[];
}

const MEDIA_MESSAGE_TYPES = ['image', 'audio', 'video', 'document', 'sticker'] as const;
export type MediaMessageType = (typeof MEDIA_MESSAGE_TYPES)[number];

export interface NormalizedInbound {
  /** Message type as stored in app.whatsapp_thread_messages.message_type. */
  type: 'text' | 'button' | MediaMessageType | 'location' | 'contacts';
  /** Text, button title, or media caption. Null when the message has none. */
  text: string | null;
  /** Sanitized, content-free metadata kept in raw_payload (never media bytes or captions). */
  extra: Record<string, unknown>;
}

/**
 * Maps a Meta inbound message to what the inbox stores. Returns null for
 * message kinds that need no seller action (reactions, system notices, order
 * and unsupported payloads) so they are ignored rather than creating entries.
 */
export function normalizeInboundMessage(message: MetaInboundMessage): NormalizedInbound | null {
  switch (message.type) {
    case 'text':
      return { type: 'text', text: message.text?.body ?? null, extra: {} };
    case 'button':
      return { type: 'button', text: message.button?.text ?? null, extra: {} };
    case 'interactive': {
      const title = message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title ?? null;
      return { type: 'button', text: title, extra: { interactive_type: message.interactive?.type ?? null } };
    }
    case 'image':
    case 'audio':
    case 'video':
    case 'document':
    case 'sticker': {
      const mediaByType: Record<MediaMessageType, MetaMediaPayload | undefined> = {
        image: message.image,
        audio: message.audio,
        video: message.video,
        document: message.document,
        sticker: message.sticker,
      };
      const media = mediaByType[message.type];
      return {
        type: message.type,
        text: media?.caption ?? null,
        extra: {
          media: {
            id: media?.id ?? null,
            mime_type: media?.mime_type ?? null,
            sha256: media?.sha256 ?? null,
            filename: media?.filename ?? null,
          },
        },
      };
    }
    case 'location':
      return {
        type: 'location',
        text: null,
        extra: { location: { name: message.location?.name ?? null, address: message.location?.address ?? null } },
      };
    case 'contacts':
      return { type: 'contacts', text: null, extra: { contact_count: message.contacts?.length ?? 0 } };
    default:
      return null;
  }
}
