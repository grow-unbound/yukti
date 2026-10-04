import { formatWhatsappDestination } from '@/lib/phone';

export const AUTH_LOGIN_COPY = {
  login: {
    welcomeTitle: 'Login to Yukti',
    welcomeSubtitle:
      'Manage catalog, pricing, customer access, and orders from your Supplier workspace',
    sellerTitle: 'Login to your Supplier workspace',
    sellerSubtitle: 'Manage catalog, pricing, customer access, and orders in one place.',
    buyerTitle: 'Login to your supplier catalog',
    buyerSubtitle: 'Browse products, place orders, and track your account with your supplier.',
    tenantBuyerTitle: ({ tenantName }: { tenantName?: string | null }) =>
      tenantName?.trim() ? `Login to ${tenantName.trim()} catalog` : 'Login to your supplier catalog',
    tenantBuyerSubtitle: 'Use your WhatsApp number to continue.',
    landingBody: 'Enter your registered WhatsApp number to get an OTP',
    emailBody: 'Login with your email and password',
    loginWithEmail: 'Login with Email',
    loginWithMobileOtp: 'Login with mobile OTP',
    whatsappOtp: 'WhatsApp OTP',
    emailPassword: 'Email + Password',
    sendOtp: 'Send OTP',
    sendingOtp: 'Sending OTP…',
    verifyOtp: 'Verify OTP',
    verifyingOtp: 'Verifying…',
    signIn: 'Login',
    signInLoading: 'Logging in…',
    forgotPassword: 'Forgot password?',
    createSellerAccount: 'Create workspace',
    createSellerAccountCalloutTitle: 'New supplier?',
    createSellerAccountCalloutBody: 'Create a Supplier workspace for your catalog, buyers, pricing, and orders.',
    buyerOnSellerPrefix: 'Retailer or dealer trying to order?',
    buyerOnSellerCta: 'Go to supplier catalog',
    sellerOnBuyerPrefix: 'Supplier or distributor?',
    sellerOnBuyerCta: 'Login to Supplier workspace',
    tryDifferentNumber: 'Try a different number',
    requestAccess: 'Request Access',
    informSeller: 'Inform your Seller',
    changeNumber: 'Change number',
    resendOtp: 'Resend OTP',
    backToLogin: 'Back to login',
    homeHref: 'https://useyukti.in',
    supportWhatsAppDisplay: '+91-9490744841',
    supportWhatsAppHref: 'https://wa.me/919490744841',
    supportHelpPrefix: 'Need help logging in? WhatsApp Support:',
    buyerInsteadPrefix: 'Buying from a distributor instead?',
    buyerInsteadCta: 'Let them know about Yukti',
  },
  resolution: {
    unregistered: {
      title: "We couldn't find your number",
      lines: [
        'Yukti works through a registered seller',
        'If you sell to other businesses, create your Supplier workspace below',
        "If you're trying to order from a business you work with, ask them to add you as a buyer",
      ],
      buyerLines: [
        'Use the WhatsApp number your supplier added to their catalog.',
        'If this number should have access, ask your supplier to add or enable you as a buyer.',
      ],
    },
    // Catalog host, no return_to: we don't know which distributor this person is buying from, so we
    // can't onboard them. Point them at the two ways forward instead of a dead end.
    unregisteredCatalog: {
      title: "We couldn't find a buyer account for this number",
      lines: [
        'Buying from a distributor? Open the catalog link they shared and log in from there. You can request access in a minute.',
        'Distributor? Sign in to the seller app.',
      ],
      supportPrefix: 'Still stuck? WhatsApp us:',
      sellerLogin: "I'm a distributor: go to seller login",
    },
    sellerDisabled: {
      title: ({ sellerName }: { sellerName: string }) =>
        `Your account is not enabled by ${sellerName} for catalog access and ordering`,
      body: 'Ask them to enable your access.',
    },
    buyerDisabled: {
      title: ({ sellerName }: { sellerName: string }) =>
        `Your buyer profile with ${sellerName} is not enabled for catalog access and ordering`,
      body: 'Ask them to enable your access.',
    },
    chooseAccount: {
      title: 'Choose an account',
      body: ({ sellerName }: { sellerName: string }) =>
        `This number is linked to multiple buyer profiles with ${sellerName}. Pick one to continue.`,
    },
    chooseBusiness: {
      title: 'Choose a business',
      body: 'This number is linked to buyer accounts with multiple sellers. Select which one you’d like to open.',
    },
    previewMode: {
      title: 'Preview mode',
      body:
        "You don't have a buyer account here yet. You can browse the catalog, but won't be able to place orders until a seller adds you as a buyer.",
      continue: 'Continue',
      cancel: 'Cancel',
    },
  },
} as const;

export function buildRequestAccessMessage({
  sellerName,
  buyerName,
}: {
  sellerName: string;
  buyerName?: string | null;
}): string {
  const buyerLabel = buyerName?.trim() || 'the buyer';
  return [
    `Hi ${sellerName}, I'd like to get access to the Yukti buyer-app to view your catalog and place orders.`,
    "Can you please confirm once you've enabled my access.",
    `- ${buyerLabel}`,
  ].join(' ');
}

export function buildInformSellerMessage({
  signupLink,
}: {
  signupLink: string;
  /** @deprecated unused — kept for call-site compatibility */
  sellerName?: string;
  /** @deprecated unused — kept for call-site compatibility */
  buyerName?: string | null;
}): string {
  return [
    'Hi,',
    '',
    "I'd like to order from you through Yukti, but I don't have access yet.",
    'Yukti is a simple app for managing your catalog, pricing, and orders with buyers like me.',
    '',
    'Could you create your Supplier workspace and add me as a buyer, so I can browse your catalog and order?',
    '',
    `Seller signup: ${signupLink}`,
    '',
    "Let me know once it's ready!",
  ].join('\n');
}

/**
 * Build a WhatsApp click-to-chat / share URL.
 *
 * IMPORTANT: Do not use encodeURIComponent alone for the text param — it leaves
 * apostrophes (`'`) unescaped. Many mobile OS / WhatsApp intent parsers truncate
 * the query at the first raw `'`. URLSearchParams encodes `'` as %27.
 */
function buildWhatsAppSendUrl(params: { phone?: string; text: string }): string {
  const url = new URL(params.phone ? 'https://api.whatsapp.com/send' : 'https://wa.me/');
  if (params.phone) {
    url.searchParams.set('phone', params.phone);
  }
  url.searchParams.set('text', params.text);
  return url.toString();
}

export function buildWhatsAppChatUrl(phoneNumber: string, message: string): string {
  return buildWhatsAppSendUrl({
    phone: formatWhatsappDestination(phoneNumber),
    text: message,
  });
}

export function buildWhatsAppShareUrl(message: string): string {
  return buildWhatsAppSendUrl({ text: message });
}

/**
 * WhatsApp's no-recipient share path (contact picker) collapses any `text` that
 * contains an `https://` URL down to that URL alone — which is why Inform Seller
 * only showed the signup link. Strip schemes for the prefill; keep the real
 * https URL on the clipboard for paste.
 */
export function toWhatsAppSharePrefill(message: string): string {
  return message.replace(/https?:\/\//gi, '');
}

export function openWhatsAppShare(message: string): void {
  void navigator.clipboard?.writeText(message).catch(() => undefined);

  const href = buildWhatsAppShareUrl(toWhatsAppSharePrefill(message));
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  // Soft fallback if WA still strips body on some clients
  void import('sonner').then(({ toast }) => {
    toast.message('Full message copied', {
      description: 'If WhatsApp shows only the link, paste into the chat.',
      duration: 6000,
    });
  });
}
