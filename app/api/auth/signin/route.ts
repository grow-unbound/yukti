import { NextRequest, NextResponse } from 'next/server';
import { supabase, supabaseAdmin } from '@/lib/supabase';
import { LoginSchema } from '@/lib/zod';
import { getPostHogClient, seedTenantFeatureFlags } from '@/lib/posthog-server';
import { stampSellerImplicitWhatsappConsent } from '@/lib/server/whatsapp-consent';
import { isSigninLocked, recordFailedSignin, clearSigninAttempts } from '@/lib/server/auth-signin-lockout';
import { sendAccountVerificationOtpEmail } from '@/lib/server/account-verification';
import { resolveAuthSurfaceFromRequest } from '@/lib/server/auth-surface-server';

function isPhone(value: string) {
  return /^[0-9]{10}$/.test(value.trim());
}

interface WorkspaceRow {
  workspace_type: 'seller' | 'buyer';
  role: string;
  tenant_id: string | null;
  tenant_slug: string | null;
  tenant_name: string | null;
  buyer_id: string | null;
  location_ids?: string[] | null;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const validation = LoginSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid credentials', details: validation.error.flatten() },
        { status: 400 }
      );
    }

    const { identifier, password } = validation.data;
    const surface = resolveAuthSurfaceFromRequest(request).surface;

    if (surface !== 'supplier_workspace') {
      return NextResponse.json(
        { error: 'Email login is only available for Supplier workspace accounts.' },
        { status: 400 },
      );
    }

    if (isPhone(identifier)) {
      return NextResponse.json(
        { error: 'Phone login requires OTP. Use "Login with OTP" instead.' },
        { status: 400 }
      );
    }

    if (await isSigninLocked(identifier)) {
      return NextResponse.json(
        { error: 'Too many failed attempts. Try again in a few minutes.' },
        { status: 429 },
      );
    }

    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email: identifier,
      password,
    });

    if (authError || !authData.user) {
      void recordFailedSignin(identifier);
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      );
    }

    void clearSigninAttempts(identifier);

    // Resolve the current tenant from the request subdomain so the JWT hook
    // can embed the correct tenant_id claim on the very first token.
    const subdomain = request.headers.get('x-tenant-subdomain');
    let currentTenantId: string | null = null;

    if (subdomain && supabaseAdmin && subdomain !== 'app') {
      const { data: tenantRow } = await supabaseAdmin
        .schema('app')
        .from('tenants')
        .select('id')
        .eq('slug', subdomain)
        .maybeSingle();

      if (tenantRow?.id) {
        currentTenantId = tenantRow.id;
        // Store current_tenant_id in app_metadata so the JWT hook can read it
        await supabaseAdmin.auth.admin.updateUserById(authData.user.id, {
          app_metadata: { current_tenant_id: currentTenantId },
        });

      }
    }

    // Refresh session so the JWT immediately reflects the updated app_metadata
    // (the custom_access_token_hook re-runs on refresh and picks up current_tenant_id).
    let finalSession = authData.session;
    if (currentTenantId && authData.session?.refresh_token) {
      const { data: refreshData } = await supabase.auth.refreshSession({
        refresh_token: authData.session.refresh_token,
      });
      if (refreshData.session) {
        finalSession = refreshData.session;
      }
    }

    // Use SECURITY DEFINER RPC — works regardless of PostgREST schema exposure
    const db = supabaseAdmin ?? supabase;
    const { data: rows, error: wsError } = await db
      .rpc('get_user_workspace', { p_user_id: authData.user.id });

    if (wsError) {
      console.error('Workspace lookup error:', wsError);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    const workspace = (rows as WorkspaceRow[] | null)?.[0] ?? null;

    if (!workspace) {
      return NextResponse.json(
        { error: 'Account not associated with any workspace. Contact your administrator.' },
        { status: 403 }
      );
    }

    // PostHog server-side tracking — fire-and-forget, never block login
    try {
      const ph = getPostHogClient();
      const distinctId = request.headers.get('X-POSTHOG-DISTINCT-ID') ?? authData.user.id;
      ph.identify({
        distinctId: authData.user.id,
        properties: {
          email: authData.user.email,
          role: workspace.role,
          workspace_type: workspace.workspace_type,
          ...(workspace.tenant_id ? { tenant_id: workspace.tenant_id } : {}),
        },
      });
      ph.capture({
        distinctId,
        event: 'user_signed_in',
        properties: {
          user_type: workspace.workspace_type,
          role: workspace.role,
          ...(workspace.tenant_id ? { tenant_id: workspace.tenant_id } : {}),
          ...(workspace.tenant_slug ? { tenant_slug: workspace.tenant_slug } : {}),
          $session_id: request.headers.get('X-POSTHOG-SESSION-ID') ?? undefined,
        },
      });
      await ph.flush();
    } catch (phErr) {
      console.warn('PostHog tracking failed (non-blocking):', phErr);
    }

    if (workspace.workspace_type === 'seller') {
      // Check email verification — unverified sellers must verify before accessing the app
      if (workspace.tenant_id && supabaseAdmin) {
        const { data: tenantRow } = await supabaseAdmin
          .schema('app')
          .from('tenants')
          .select('email_verified_at')
          .eq('id', workspace.tenant_id)
          .single();

        if (!tenantRow?.email_verified_at) {
          // Send a fresh email OTP and redirect to verification.
          await sendAccountVerificationOtpEmail({
            user_id: authData.user.id,
            tenant_id: workspace.tenant_id,
            email: authData.user.email!,
          });

          const phone = (authData.user.user_metadata?.phone as string | null) ?? null;
          return NextResponse.json({
            pending_verification: true,
            user_id: authData.user.id,
            email: authData.user.email,
            phone,
          });
        }
      }

      // Seed feature flags on first successful login if not already seeded
      if (workspace.tenant_id) {
        try {
          await seedTenantFeatureFlags(workspace.tenant_id);
        } catch {
          // Non-fatal
        }

        // WhatsApp Broadcast Phase C (§4.8): implicit seller-side consent,
        // stamped silently alongside other first-login bookkeeping above.
        await stampSellerImplicitWhatsappConsent(workspace.tenant_id, authData.user.id);
      }

      return NextResponse.json({
        success: true,
        user: { id: authData.user.id, email: authData.user.email },
        role: workspace.role,
        redirect: '/dashboard',
        tenant: workspace.tenant_id
          ? { id: workspace.tenant_id, slug: workspace.tenant_slug, business_name: workspace.tenant_name }
          : null,
        session: finalSession,
      });
    }

    return NextResponse.json({
      success: true,
      user: { id: authData.user.id, email: authData.user.email },
      role: workspace.role,
      redirect: '/buy',
      session: finalSession,
    });
  } catch (error) {
    console.error('Sign in error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
