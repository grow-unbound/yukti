'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Link2,
  Plus,
  ShieldCheck,
  Sparkles,
  Zap,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DatePicker } from '@/components/ui/date-picker';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useFlagState } from '@/hooks/useFeatureFlag';
import {
  type IntegrationCatalogItem,
  type IntegrationFamilyFlag,
  useIntegrationsSettings,
} from '@/hooks/useIntegrationsSettings';
import { useRole } from '@/hooks/useRole';
import { classifyIntegrationMappingMode, getIntegrationTopologyDefinition } from '@/lib/integrations/definitions';
import { getMetaAppIdPublic, getWhatsAppEmbeddedSignupConfigIdPublic } from '@/lib/integrations/whatsapp-oauth';
import { cn } from '@/lib/utils';
import type { IntegrationSettingsPayload } from '@/types/integrations';

import { ConnectedIntegrationCard } from './ConnectedIntegrationCard';
import { IntegrationPickerDialog } from './IntegrationPickerDialog';
import type { SyncConfirmOptions } from './SyncWindowDialog';
import { IntegrationsSettingsContentSkeleton } from './IntegrationsSettingsSkeleton';
import { WhatsAppConnectedCard } from './WhatsAppConnectedCard';
import { WhatsAppEmbeddedSignupDialog } from './WhatsAppEmbeddedSignupDialog';

type WizardState = {
  open: boolean;
  integrationId: string | null;
  step: number;
  credentials: Record<string, string>;
  importStartDate: string;
};

type MaintenanceDialogState = {
  integrationId: string;
  mode: 'repair' | 'analysis';
};

const WIZARD_STEPS = ['What you get', 'Connect', 'Start syncing'] as const;

interface IntegrationsSettingsClientProps {
  initialData?: IntegrationSettingsPayload | null;
}

function defaultImportStartDate(): string {
  const now = new Date();
  const month = now.getMonth();
  if (month >= 3 && month <= 5) {
    return `${now.getFullYear()}-01-01`;
  }
  const fyStartYear = month >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${fyStartYear}-04-01`;
}

function defaultMetricsMaintenanceRange() {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 89);

  return {
    start_date: start.toISOString().slice(0, 10),
    end_date: end.toISOString().slice(0, 10),
  };
}

function labelize(value: string) {
  return value
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatDate(value?: string | null, withTime = false) {
  if (!value) return withTime ? 'Not yet' : 'Not set';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return withTime ? 'Not yet' : 'Not set';
  return new Intl.DateTimeFormat('en-IN', withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }).format(date);
}

function getImportScopes(integration: IntegrationCatalogItem) {
  return [
    ...(integration.capabilities?.inbound_reference ?? []),
    ...(integration.capabilities?.inbound_transactional ?? []),
  ];
}

function buildWizardState(integration: IntegrationCatalogItem | null): WizardState {
  const config = integration?.tenant_integration?.config ?? {};
  const fields = integration?.auth_schema?.fields ?? [];
  const credentials = fields.reduce<Record<string, string>>((acc, field) => {
    const raw = config[field.key];
    acc[field.key] = typeof raw === 'string' ? raw : '';
    return acc;
  }, {});

  return {
    open: false,
    integrationId: integration?.id ?? null,
    step: 0,
    credentials,
    importStartDate: defaultImportStartDate(),
  };
}

export function IntegrationsSettingsClient({ initialData }: IntegrationsSettingsClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isSellerAdmin } = useRole();
  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    connectIntegration,
    startSync,
    syncNowIntegration,
    stopSyncIntegration,
    disconnectIntegration,
    isConnecting,
    isStartingSync,
    isDisconnecting,
    isSyncingNow,
    isStoppingSync,
    retryWebhookSetup,
    isRetryingWebhookSetup,
    repairAggregates,
    runAnalysis,
    isRepairingAggregates,
    isRunningAnalysis,
  } = useIntegrationsSettings(initialData);

  const [isOAuthRedirecting, setIsOAuthRedirecting] = useState(false);
  const [oauthNotice, setOauthNotice] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [disconnectDialogIntegration, setDisconnectDialogIntegration] = useState<IntegrationCatalogItem | null>(null);
  const [stopSyncDialogIntegration, setStopSyncDialogIntegration] = useState<IntegrationCatalogItem | null>(null);
  const [syncingPhaseTarget, setSyncingPhaseTarget] = useState<string | null>(null);
  const [maintenanceTarget, setMaintenanceTarget] = useState<MaintenanceDialogState | null>(null);
  const [repairRange, setRepairRange] = useState(defaultMetricsMaintenanceRange());
  const [repairIncludeSnapshots, setRepairIncludeSnapshots] = useState(true);
  const [repairIncludeKpis, setRepairIncludeKpis] = useState(true);
  const [analysisDays, setAnalysisDays] = useState('90');

  const zohoEnabled = useFlagState('ZOHO_INTEGRATION');
  const tallyEnabled = useFlagState('TALLY_INTEGRATION');
  const busyEnabled = useFlagState('BUSY_INTEGRATION');
  const whatsappEnabled = useFlagState('WHATSAPP_INTEGRATION');

  const familyAvailability: Record<IntegrationFamilyFlag, boolean> = {
    ZOHO_INTEGRATION: zohoEnabled !== false,
    TALLY_INTEGRATION: tallyEnabled !== false,
    BUSY_INTEGRATION: busyEnabled !== false,
    WHATSAPP_INTEGRATION: whatsappEnabled !== false,
  };

  const [whatsappDialogOpen, setWhatsappDialogOpen] = useState(false);

  const integrations = data?.integrations ?? [];
  const [wizard, setWizard] = useState<WizardState>(buildWizardState(null));
  const [pendingOAuthConnectedId, setPendingOAuthConnectedId] = useState<string | null>(null);
  const oauthStorageListenerRef = useRef<((e: StorageEvent) => void) | null>(null);
  const oauthPopupRef = useRef<Window | null>(null);
  const oauthPopupWatchRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (oauthStorageListenerRef.current) {
        window.removeEventListener('storage', oauthStorageListenerRef.current);
      }
      if (oauthPopupWatchRef.current) {
        window.clearInterval(oauthPopupWatchRef.current);
      }
    };
  }, []);

  // Advance wizard when fresh integration data arrives after OAuth cross-tab signal.
  // Must wait for tenant_integration.status to actually read 'connected' — the
  // pre-refetch `integrations` array still contains this id from before OAuth
  // completed (disconnected/no credentials), and matching on id alone clears
  // pendingOAuthConnectedId immediately on that stale data, so this effect never
  // gets a second chance to run once the real refetch lands. That left the wizard
  // permanently on the stale snapshot, whose blank `credentials` then flowed into
  // runStartImport's connect fallback and failed schema validation on org_id.
  useEffect(() => {
    if (!pendingOAuthConnectedId || integrations.length === 0) return;
    const target = integrations.find((i) => i.id === pendingOAuthConnectedId);
    if (!target || target.tenant_integration?.status !== 'connected') return;
    setPendingOAuthConnectedId(null);
    setWizard({ ...buildWizardState(target), open: true, integrationId: target.id, step: 2 });
  }, [pendingOAuthConnectedId, integrations]);

  // Handle Zoho OAuth return params
  useEffect(() => {
    const connectedTypeId = searchParams.get('connected');
    const oauthError = searchParams.get('oauth_error');

    if (oauthError) {
      console.error('[Zoho OAuth] Error returned from consent screen:', oauthError);
      router.replace('/settings/integrations');
      return;
    }

    if (connectedTypeId) {
      localStorage.setItem('df_zoho_oauth_complete', connectedTypeId);
      router.replace('/settings/integrations');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const wizardIntegration = useMemo(
    () => integrations.find((integration) => integration.id === wizard.integrationId) ?? null,
    [integrations, wizard.integrationId],
  );
  const maintenanceIntegration = useMemo(
    () =>
      maintenanceTarget
        ? integrations.find((integration) => integration.id === maintenanceTarget.integrationId) ?? null
        : null,
    [integrations, maintenanceTarget],
  );
  const wizardTopology = useMemo(() => {
    if (!wizardIntegration) return null;
    try {
      return getIntegrationTopologyDefinition(wizardIntegration.id as Parameters<typeof getIntegrationTopologyDefinition>[0]);
    } catch {
      return null;
    }
  }, [wizardIntegration]);

  function openWizard(integration: IntegrationCatalogItem) {
    const isConnected = integration.tenant_integration?.status === 'connected';
    setWizard({ ...buildWizardState(integration), open: true, integrationId: integration.id, step: isConnected ? 2 : 0 });
  }

  function updateCredential(key: string, value: string) {
    setWizard((current) => ({
      ...current,
      credentials: { ...current.credentials, [key]: value },
    }));
  }

  function openMaintenanceDialog(integration: IntegrationCatalogItem, mode: MaintenanceDialogState['mode']) {
    setRepairRange(defaultMetricsMaintenanceRange());
    setRepairIncludeSnapshots(true);
    setRepairIncludeKpis(true);
    setAnalysisDays('90');
    setMaintenanceTarget({ integrationId: integration.id, mode });
  }

  function closeMaintenanceDialog() {
    setMaintenanceTarget(null);
  }

  async function runStartImport() {
    if (!wizardIntegration) return;

    let tenantIntegrationId = wizardIntegration.tenant_integration?.id ?? null;

    if (!tenantIntegrationId || wizardIntegration.tenant_integration?.status !== 'connected') {
      // OAuth integrations never populate wizard.credentials (step 1's manual
      // credential form is hidden for them) — sending it here always fails
      // schema validation on an empty required field. If status isn't
      // 'connected' yet for an OAuth integration, the connect flow itself
      // (Zoho popup + callback) hasn't finished — ask the user to retry rather
      // than attempting a manual connect that's guaranteed to fail.
      if (wizardIntegration.auth_schema?.oauth === true) {
        throw new Error('Zoho connection is still finishing. Please wait a moment and try again.');
      }
      const connectedView = await connectIntegration({
        integration_type_id: wizardIntegration.id,
        credentials: wizard.credentials,
        config: { connectivity_mode: wizardIntegration.connectivity_mode },
      });

      const connectedIntegration =
        connectedView.integrations.find((i) => i.id === wizardIntegration.id)?.tenant_integration ?? null;

      if (!connectedIntegration?.id) {
        throw new Error('Integration connected, but no tenant integration record was returned.');
      }
      tenantIntegrationId = connectedIntegration.id;
    }

    setWizard((current) => ({ ...current, open: false }));

    void startSync({
      integration_type_id: wizardIntegration.id,
      tenant_integration_id: tenantIntegrationId,
      credentials: wizard.credentials,
      import_start_date: wizard.importStartDate,
    }).catch(() => undefined);
  }

  async function runDisconnectIntegration(integration: IntegrationCatalogItem) {
    if (isDisconnecting) return;
    setDisconnectDialogIntegration(integration);
  }

  async function runStopSyncIntegration(integration: IntegrationCatalogItem) {
    const tenantIntegrationId = integration.tenant_integration?.id;
    if (!tenantIntegrationId) return;
    setStopSyncDialogIntegration(integration);
  }

  async function confirmDisconnectIntegration() {
    if (!disconnectDialogIntegration) return;
    const tenantIntegrationId = disconnectDialogIntegration.tenant_integration?.id;
    if (!tenantIntegrationId) return;

    await disconnectIntegration({
      tenant_integration_id: tenantIntegrationId,
    });
    setDisconnectDialogIntegration(null);
  }

  async function confirmStopSyncIntegration() {
    if (!stopSyncDialogIntegration) return;
    const tenantIntegrationId = stopSyncDialogIntegration.tenant_integration?.id;
    if (!tenantIntegrationId) return;

    await stopSyncIntegration({
      tenant_integration_id: tenantIntegrationId,
    });
    setStopSyncDialogIntegration(null);
  }

  async function runSyncNowIntegration(integration: IntegrationCatalogItem, options: SyncConfirmOptions) {
    const tenantIntegrationId = integration.tenant_integration?.id;
    if (!tenantIntegrationId) return;
    setSyncingPhaseTarget(null);
    try {
      await syncNowIntegration({
        tenant_integration_id: tenantIntegrationId,
        ...(options.since ? { since: options.since } : {}),
        force_full_refresh: options.forceFullRefresh,
      });
    } finally {
      setSyncingPhaseTarget((current) => (current === null ? null : current));
    }
  }

  async function runSyncPhaseIntegration(integration: IntegrationCatalogItem, phase: string, options: SyncConfirmOptions) {
    const tenantIntegrationId = integration.tenant_integration?.id;
    if (!tenantIntegrationId) return;
    setSyncingPhaseTarget(phase);
    try {
      await syncNowIntegration({
        tenant_integration_id: tenantIntegrationId,
        phase,
        ...(options.since ? { since: options.since } : {}),
        force_full_refresh: options.forceFullRefresh,
      });
    } finally {
      setSyncingPhaseTarget((current) => (current === phase ? null : current));
    }
  }

  async function runRetryWebhooks(integration: IntegrationCatalogItem) {
    const tenantIntegrationId = integration.tenant_integration?.id;
    if (!tenantIntegrationId) return;
    await retryWebhookSetup({
      tenant_integration_id: tenantIntegrationId,
    });
  }

  async function runRepairAggregates(integration: IntegrationCatalogItem, options: {
    start_date: string;
    end_date: string;
    include_snapshots: boolean;
    include_kpis: boolean;
  }) {
    const tenantIntegrationId = integration.tenant_integration?.id;
    if (!tenantIntegrationId) return;
    setMaintenanceTarget({ integrationId: integration.id, mode: 'repair' });
    try {
      await repairAggregates({
        tenant_integration_id: tenantIntegrationId,
        start_date: options.start_date,
        end_date: options.end_date,
        include_snapshots: options.include_snapshots,
        include_kpis: options.include_kpis,
      });
      closeMaintenanceDialog();
    } finally {
      setMaintenanceTarget((current) =>
        current?.integrationId === integration.id && current.mode === 'repair' ? null : current,
      );
    }
  }

  async function runAdHocAnalysis(integration: IntegrationCatalogItem, days: number) {
    const tenantIntegrationId = integration.tenant_integration?.id;
    if (!tenantIntegrationId) return;
    setMaintenanceTarget({ integrationId: integration.id, mode: 'analysis' });
    try {
      await runAnalysis({
        tenant_integration_id: tenantIntegrationId,
        days,
      });
      closeMaintenanceDialog();
    } finally {
      setMaintenanceTarget((current) =>
        current?.integrationId === integration.id && current.mode === 'analysis' ? null : current,
      );
    }
  }

  async function confirmMaintenanceAction() {
    if (!maintenanceTarget || !maintenanceIntegration) return;

    if (maintenanceTarget.mode === 'repair') {
      await runRepairAggregates(maintenanceIntegration, {
        start_date: repairRange.start_date,
        end_date: repairRange.end_date,
        include_snapshots: repairIncludeSnapshots,
        include_kpis: repairIncludeKpis,
      });
      return;
    }

    const parsedDays = Number.parseInt(analysisDays, 10);
    const safeDays = Number.isFinite(parsedDays) ? Math.min(Math.max(parsedDays, 1), 365) : 90;
    await runAdHocAnalysis(maintenanceIntegration, safeDays);
  }

  async function startZohoOAuth() {
    if (!wizardIntegration) return;
    const orgId = wizard.credentials['org_id'] ?? '';
    if (!orgId.trim()) return;

    setIsOAuthRedirecting(true);
    setOauthNotice(null);
    try {
      const response = await fetch('/api/settings/integrations/zoho/oauth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ integration_type_id: wizardIntegration.id, org_id: orgId }),
      });
      const json = (await response.json()) as {
        data?: { redirect_url?: string };
        error?: { message?: string };
      };
      if (!response.ok || !json.data?.redirect_url) {
        throw new Error(json.error?.message ?? 'Failed to start OAuth flow');
      }
      const popup = window.open(json.data.redirect_url, 'zoho-oauth', 'width=880,height=840');
      oauthPopupRef.current = popup;
      if (!popup) {
        setIsOAuthRedirecting(false);
        setOauthNotice({ kind: 'error', message: 'Your browser blocked the Zoho login window.' });
        return;
      }

      if (oauthStorageListenerRef.current) {
        window.removeEventListener('storage', oauthStorageListenerRef.current);
      }
      const handleStorage = (e: StorageEvent) => {
        if (e.key === 'df_zoho_oauth_complete' && e.newValue) {
          window.removeEventListener('storage', handleStorage);
          oauthStorageListenerRef.current = null;
          if (oauthPopupWatchRef.current) {
            window.clearInterval(oauthPopupWatchRef.current);
            oauthPopupWatchRef.current = null;
          }
          oauthPopupRef.current = null;
          const connectedId = e.newValue;
          localStorage.removeItem('df_zoho_oauth_complete');
          localStorage.removeItem('df_zoho_oauth_error');
          setIsOAuthRedirecting(false);
          // setOauthNotice({ kind: 'success', message: 'Zoho connection is set up. You can close the other tab.' });
          // Don't snapshot the wizard from `integrations` here — it's the
          // pre-refetch array and still shows this integration as disconnected
          // with no credentials. The pendingOAuthConnectedId effect above rebuilds
          // the wizard once refetch() lands and status actually reads 'connected'.
          setPendingOAuthConnectedId(connectedId);
          void refetch();
          return;
        }
        if (e.key === 'df_zoho_oauth_error' && e.newValue) {
          window.removeEventListener('storage', handleStorage);
          oauthStorageListenerRef.current = null;
          if (oauthPopupWatchRef.current) {
            window.clearInterval(oauthPopupWatchRef.current);
            oauthPopupWatchRef.current = null;
          }
          oauthPopupRef.current = null;
          localStorage.removeItem('df_zoho_oauth_error');
          setIsOAuthRedirecting(false);
          try {
            const parsed = JSON.parse(e.newValue) as { message?: string; detail?: string };
            setOauthNotice({
              kind: 'error',
              message: parsed.message ?? 'Zoho connection failed. Please try again.',
            });
          } catch {
            setOauthNotice({ kind: 'error', message: 'Zoho connection failed. Please try again.' });
          }
          void refetch();
        }
      };
      oauthStorageListenerRef.current = handleStorage;
      window.addEventListener('storage', handleStorage);

      if (oauthPopupWatchRef.current) {
        window.clearInterval(oauthPopupWatchRef.current);
      }
      oauthPopupWatchRef.current = window.setInterval(() => {
        if (oauthPopupRef.current && oauthPopupRef.current.closed) {
          if (oauthPopupWatchRef.current) {
            window.clearInterval(oauthPopupWatchRef.current);
          }
          oauthPopupWatchRef.current = null;
          oauthPopupRef.current = null;
          if (oauthStorageListenerRef.current) {
            window.removeEventListener('storage', oauthStorageListenerRef.current);
            oauthStorageListenerRef.current = null;
          }
          setIsOAuthRedirecting(false);
          setOauthNotice((current) =>
            current ?? { kind: 'error', message: 'Zoho window closed before the connection finished.' },
          );
          void refetch();
        }
      }, 1000);
    } catch {
      setIsOAuthRedirecting(false);
      setOauthNotice({ kind: 'error', message: 'Failed to start Zoho OAuth flow.' });
    }
  }

  // ── Derived data ────────────────────────────────────────────────────────────

  if (isLoading) return <IntegrationsSettingsContentSkeleton />;

  if (isError || !data) {
    return (
      <ErrorState
        heading="Could not load integrations"
        description={error instanceof Error ? error.message : 'Something went wrong.'}
        onRetry={() => void refetch()}
      />
    );
  }

  const connectedIntegrations = integrations.filter((i) => i.tenant_integration !== null);
  const unconnectedAvailable = integrations.filter(
    (i) => !i.tenant_integration && familyAvailability[i.family_flag],
  );

  const wizardFields = wizardIntegration?.auth_schema?.fields ?? [];
  const missingRequired = wizardFields.filter((f) => f.required && !wizard.credentials[f.key]?.trim());
  const canAdvanceFromConnect = missingRequired.length === 0;

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <>
      <div className="space-y-6">
        <div className="flex items-end justify-between gap-6">
          <div>
            <h2 className="font-display text-xl font-semibold text-cream-900">Integrations</h2>
            <p className="mt-1 max-w-[60ch] text-md leading-[1.3] text-cream-700">
              Connect accounting and ERP tools.
            </p>
          </div>
          {isSellerAdmin && (unconnectedAvailable.length > 0 || integrations.length === 0) ? (
            <Button type="button" variant="primary" size="sm" onClick={() => setPickerOpen(true)}>
              <Plus className="h-4 w-4" />
              Add integration
            </Button>
          ) : null}
        </div>

        {/* ── Connected integration cards or empty state ───────────────────────── */}
        {integrations.length === 0 ? (
          <EmptyState
            icon={<Link2 className="h-7 w-7" strokeWidth={1.5} />}
            heading="No integrations configured yet"
            description="Once the integration catalog is seeded for this workspace, setup and sync details will show up here."
            action={
              isSellerAdmin ? (
                <Button type="button" variant="accent" onClick={() => setPickerOpen(true)}>
                  <Plus className="h-4 w-4" />
                  Add Integration
                </Button>
              ) : null
            }
          />
        ) : connectedIntegrations.length > 0 ? (
          <div className="space-y-6">
            {connectedIntegrations.map((integration) =>
              integration.id === 'whatsapp_business' ? (
                <WhatsAppConnectedCard
                  key={integration.id}
                  integration={integration}
                  isSellerAdmin={isSellerAdmin}
                  onDisconnect={() => void runDisconnectIntegration(integration)}
                  onResynced={() => void refetch()}
                />
              ) : (
              <ConnectedIntegrationCard
                key={integration.id}
                integration={integration}
                available={familyAvailability[integration.family_flag]}
                isSellerAdmin={isSellerAdmin}
                onOpenWizard={() => openWizard(integration)}
                onDisconnect={() => void runDisconnectIntegration(integration)}
                onSyncNow={(since) => void runSyncNowIntegration(integration, since)}
                onSyncPhase={(phase, since) => void runSyncPhaseIntegration(integration, phase, since)}
                onStopSync={() => void runStopSyncIntegration(integration)}
                onRefresh={() => void refetch()}
                onRetryWebhooks={() => void runRetryWebhooks(integration)}
                onRepairAggregates={() => openMaintenanceDialog(integration, 'repair')}
                onRunAnalysis={() => openMaintenanceDialog(integration, 'analysis')}
                isSyncingNow={isSyncingNow}
                syncTargetPhase={syncingPhaseTarget}
                isStoppingSync={isStoppingSync}
                isRetryingWebhooks={isRetryingWebhookSetup}
                isRepairingAggregates={
                  Boolean(integration.aggregate_freshness?.repair_in_progress) ||
                  (isRepairingAggregates && maintenanceTarget?.integrationId === integration.id && maintenanceTarget.mode === 'repair')
                }
                isRunningAnalysis={isRunningAnalysis && maintenanceTarget?.integrationId === integration.id && maintenanceTarget.mode === 'analysis'}
              />
              ),
            )}
          </div>
        ) : (
          <EmptyState
            icon={<Link2 className="h-7 w-7" strokeWidth={1.5} />}
            heading="No integrations setup yet"
            description={
              isSellerAdmin
                ? 'Add your first integration to get started.'
                : 'A seller admin can set up integrations from this page.'
            }
            action={
              isSellerAdmin && (
                <Button type="button" variant="accent" onClick={() => setPickerOpen(true)}>
                  <Plus className="h-4 w-4" />
                  Add Integration
                </Button>
              )
            }
          />
        )}
      </div>

      {/* ── Integration picker dialog ─────────────────────────────────────── */}
      <IntegrationPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        integrations={unconnectedAvailable}
        onSelect={(integration) => {
          setPickerOpen(false);
          if (integration.id === 'whatsapp_business') {
            setWhatsappDialogOpen(true);
            return;
          }
          openWizard(integration);
        }}
      />

      <WhatsAppEmbeddedSignupDialog
        open={whatsappDialogOpen}
        onOpenChange={setWhatsappDialogOpen}
        metaAppId={getMetaAppIdPublic()}
        configId={getWhatsAppEmbeddedSignupConfigIdPublic()}
        onConnected={() => void refetch()}
      />

      <Dialog
        open={Boolean(disconnectDialogIntegration)}
        onOpenChange={(open) => {
          if (!open) setDisconnectDialogIntegration(null);
        }}
      >
        <DialogContent className="max-w-lg border-cream-200 bg-white">
          <DialogHeader>
            <DialogTitle className="font-display text-cream-900">Disconnect integration?</DialogTitle>
            <DialogDescription className="text-cream-700">
              This will disconnect the integration and archive its synced mappings and webhooks.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <div className="rounded-2xl border border-warning-500/30 bg-warning-50 px-4 py-4 text-sm leading-6 text-warning-700">
              {disconnectDialogIntegration ? (
                <>
                  <div className="font-semibold text-warning-950">
                    {disconnectDialogIntegration.display_name}
                  </div>
                  <div className="mt-1">
                    This action disconnects the integration for this tenant. You can reconnect later if needed.
                  </div>
                </>
              ) : null}
            </div>
          </DialogBody>
          <DialogFooter className="justify-between">
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" onClick={() => setDisconnectDialogIntegration(null)}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() => void confirmDisconnectIntegration()}
                disabled={isDisconnecting}
              >
                {isDisconnecting ? 'Disconnecting…' : 'Disconnect'}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(stopSyncDialogIntegration)}
        onOpenChange={(open) => {
          if (!open) setStopSyncDialogIntegration(null);
        }}
      >
        <DialogContent className="max-w-lg border-cream-200 bg-white">
          <DialogHeader>
            <DialogTitle className="font-display text-cream-900">Stop sync?</DialogTitle>
            <DialogDescription className="text-cream-700">
              This will stop the active sync job for this integration. You can start a new sync again after the current job is cancelled.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <div className="rounded-2xl border border-warning-500/30 bg-warning-50 px-4 py-4 text-sm leading-6 text-warning-700">
              {stopSyncDialogIntegration ? (
                <>
                  <div className="font-semibold text-warning-950">
                    {stopSyncDialogIntegration.display_name}
                  </div>
                  <div className="mt-1">
                    The worker will stop before the next page. Already imported data will remain saved.
                  </div>
                </>
              ) : null}
            </div>
          </DialogBody>
          <DialogFooter className="justify-between">
            <div className="text-sm text-cream-600">
              Use this when you want to pause an unexpectedly long sync.
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" onClick={() => setStopSyncDialogIntegration(null)}>
                Keep running
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() => void confirmStopSyncIntegration()}
                disabled={isStoppingSync}
              >
                {isStoppingSync ? 'Stopping…' : 'Stop sync'}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(maintenanceTarget)}
        onOpenChange={(open) => {
          if (!open) closeMaintenanceDialog();
        }}
      >
        <DialogContent className="max-w-xl border-cream-200 bg-white">
          <DialogHeader>
            <DialogTitle className="font-display text-cream-900">
              {maintenanceTarget?.mode === 'repair' ? 'Repair Aggregates' : 'Run Analysis'}
            </DialogTitle>
            <DialogDescription className="text-cream-700">
              {maintenanceTarget?.mode === 'repair'
                ? 'Rebuild snapshots and KPI families for a bounded tenant date range.'
                : 'Run only the aggregate analysis layer on data already available for this tenant.'}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {maintenanceIntegration ? (
              <div className="rounded-2xl border border-cream-200 bg-cream-50 px-4 py-4 text-sm leading-6 text-cream-800">
                <div className="font-semibold text-cream-950">{maintenanceIntegration.display_name}</div>
                <div className="mt-1">
                  {maintenanceTarget?.mode === 'repair'
                    ? 'Use this when aggregate freshness is stale or a post-sync rebuild failed.'
                    : 'This runs safely on current tenant data and does not wait for or require earlier sync phases to succeed.'}
                </div>
              </div>
            ) : null}

            {maintenanceTarget?.mode === 'repair' ? (
              <>
                <div className="grid gap-3 md:grid-cols-2">
                  <DatePicker
                    label="Start date"
                    value={repairRange.start_date}
                    onChange={(value) => setRepairRange((current) => ({ ...current, start_date: value }))}
                    maxDate={new Date(repairRange.end_date)}
                  />
                  <DatePicker
                    label="End date"
                    value={repairRange.end_date}
                    onChange={(value) => setRepairRange((current) => ({ ...current, end_date: value }))}
                    minDate={new Date(repairRange.start_date)}
                  />
                </div>
                <div className="grid gap-3 rounded-2xl border border-cream-200 bg-white px-4 py-4">
                  <div className="flex items-start gap-3">
                    <Checkbox
                      id="repair-include-snapshots"
                      checked={repairIncludeSnapshots}
                      onCheckedChange={(checked) => setRepairIncludeSnapshots(checked === true)}
                    />
                    <div>
                      <Label htmlFor="repair-include-snapshots" className="text-sm font-medium text-cream-900">
                        Refresh snapshots
                      </Label>
                      <p className="mt-1 text-sm text-cream-600">
                        Recompute current-state snapshot tables once for this tenant before KPI rebuilds.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <Checkbox
                      id="repair-include-kpis"
                      checked={repairIncludeKpis}
                      onCheckedChange={(checked) => setRepairIncludeKpis(checked === true)}
                    />
                    <div>
                      <Label htmlFor="repair-include-kpis" className="text-sm font-medium text-cream-900">
                        Refresh KPI tables
                      </Label>
                      <p className="mt-1 text-sm text-cream-600">
                        Rebuild daily KPI families across the selected date range.
                      </p>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="grid gap-2">
                <Label htmlFor="analysis-days" className="text-sm font-medium text-cream-900">
                  Lookback window (days)
                </Label>
                <Input
                  id="analysis-days"
                  type="number"
                  min={1}
                  max={365}
                  value={analysisDays}
                  onChange={(event) => setAnalysisDays(event.target.value)}
                />
                <p className="text-sm text-cream-600">
                  Defaults to the last 90 IST days. This runs analysis only and does not replay upstream sync jobs.
                </p>
              </div>
            )}
          </DialogBody>
          <DialogFooter className="justify-between">
            <div className="text-sm text-cream-600">
              {maintenanceTarget?.mode === 'repair'
                ? 'Bound the range to the smallest window that repairs the stale aggregates.'
                : 'Use this for ad hoc checks when raw data is present but prior orchestration was interrupted.'}
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" onClick={closeMaintenanceDialog}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="accent"
                onClick={() => void confirmMaintenanceAction()}
                disabled={
                  isRepairingAggregates ||
                  Boolean(maintenanceIntegration?.aggregate_freshness?.repair_in_progress) ||
                  isRunningAnalysis ||
                  (maintenanceTarget?.mode === 'repair'
                    ? !repairRange.start_date || !repairRange.end_date
                    : !analysisDays.trim())
                }
              >
                {maintenanceTarget?.mode === 'repair'
                  ? isRepairingAggregates
                    ? 'Repairing…'
                    : 'Run repair'
                  : isRunningAnalysis
                    ? 'Running…'
                    : 'Run analysis'}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Setup wizard dialog (unchanged) ──────────────────────────────── */}
      <Dialog open={wizard.open} onOpenChange={(open) => setWizard((current) => ({ ...current, open }))}>
        <DialogContent className="flex max-h-[90vh] max-w-3xl flex-col overflow-hidden border-cream-200 bg-white">
          <DialogHeader>
            <DialogTitle className="font-display text-cream-900">
              {wizardIntegration ? `Setup ${wizardIntegration.display_name}` : 'Setup integration'}
            </DialogTitle>
            <DialogDescription className="text-cream-700">
              Connect to your accounting or ERP tool in one click.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="min-h-0 flex-1 space-y-5 overflow-y-auto">
            <div className="grid gap-2 md:grid-cols-3">
              {WIZARD_STEPS.map((stepLabel, index) => (
                <div
                  key={stepLabel}
                  className={cn(
                    'rounded-2xl border px-3 py-3',
                    wizard.step === index
                      ? 'border-teal-200 bg-teal-50'
                      : index < wizard.step
                        ? 'border-success-50 bg-success-50'
                        : 'border-cream-200 bg-white',
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    {index < wizard.step ? <CheckCircle2 className="h-3.5 w-3.5 text-success-500" /> : null}
                    <div
                      className={cn(
                        'text-xs font-semibold uppercase tracking-[0.12em]',
                        index < wizard.step ? 'text-success-700' : 'text-cream-600',
                      )}
                    >
                      Step {index + 1}
                    </div>
                  </div>
                  <div
                    className={cn(
                      'mt-1 text-sm font-medium',
                      index < wizard.step ? 'text-success-700' : 'text-cream-900',
                    )}
                  >
                    {stepLabel}
                  </div>
                </div>
              ))}
            </div>

            {wizardIntegration ? (
              <>
                {wizard.step === 0 ? (
                  <div className="space-y-4">
                    <div className="rounded-2xl border border-cream-200 bg-cream-50 px-4 py-4">
                      <div className="flex items-center gap-2 text-sm font-semibold text-cream-900">
                        <Sparkles className="h-4 w-4 text-teal-600" />
                        What this import will cover
                      </div>
                      <p className="mt-2 text-sm leading-6 text-cream-700">
                        The first run imports core data first, then recent transactional records from the chosen date.
                      </p>
                    </div>
                    {wizardTopology ? (
                      <div className="rounded-2xl border border-cream-200 bg-white px-4 py-4">
                        <div className="text-sm font-semibold text-cream-900">Mapping preview</div>
                        <div className="mt-1 text-sm text-cream-700">
                          These Zoho entities are synced into Yukti after the connection completes.
                        </div>
                        <div className="mt-3 overflow-hidden rounded-2xl border border-cream-200">
                          <div className="grid grid-cols-[1.2fr_1.2fr_0.9fr_0.9fr] gap-3 border-b border-cream-200 bg-cream-50 px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-cream-600">
                            <div>Zoho entity</div>
                            <div>Yukti target</div>
                            <div>Capture</div>
                            <div>Status</div>
                          </div>
                          <div className="max-h-64 overflow-y-auto bg-white">
                            {wizardTopology.mappings.map((mapping) => {
                              const mode = classifyIntegrationMappingMode(mapping);
                              return (
                                <div
                                  key={`${mapping.source_entity}:${mapping.target_entity}`}
                                  className="grid grid-cols-[1.2fr_1.2fr_0.9fr_0.9fr] gap-3 border-b border-cream-100 px-3 py-2 last:border-b-0"
                                >
                                  <div className="flex items-center gap-2 text-sm font-medium text-cream-900">
                                    <CheckCircle2 className="h-4 w-4 text-success-500" />
                                    <span>{mapping.source_label}</span>
                                  </div>
                                  <div className="text-sm text-cream-700">{mapping.target_label}</div>
                                  <div className="text-sm text-cream-700">{labelize(mapping.trigger_type)}</div>
                                  <div className="flex flex-wrap items-center gap-2">
                                    <Badge variant="outline">{labelize(mode)}</Badge>
                                    <Badge variant={mapping.direction === 'bidirectional' ? 'success' : 'outline'} icon>
                                      {labelize(mapping.direction)}
                                    </Badge>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                        <div className="mt-3 text-xs leading-5 text-cream-600">
                          Checkmarks indicate the Zoho entities currently captured by this integration.
                        </div>
                      </div>
                    ) : null}
                    <div className="grid gap-3 sm:grid-cols-2">
                      {getImportScopes(wizardIntegration).map((scope) => (
                        <div key={scope} className="rounded-xl border border-cream-200 bg-white px-3 py-2">
                          <div className="flex items-center gap-2">
                            <Sparkles className="h-4 w-4 text-teal-600" />
                            <span className="text-sm font-medium text-cream-900">{labelize(scope)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {wizard.step === 1 ? (
                  <div className="space-y-4">
                    {wizardIntegration.connectivity_mode === 'local' ? (
                      <div className="rounded-2xl border border-cream-200 bg-cream-50 px-4 py-4">
                        <div className="flex items-center gap-2 text-sm font-semibold text-cream-900">
                          <ExternalLink className="h-4 w-4 text-teal-600" />
                          Local bridge flow
                        </div>
                        <p className="mt-2 text-sm leading-6 text-cream-700">
                          Keep the Yukti bridge agent online near the source system, then verify the connection before the first import.
                        </p>
                      </div>
                    ) : null}

                    {wizardIntegration.auth_schema?.oauth === true ? (
                      <div className="rounded-2xl border border-teal-100 bg-teal-50 px-4 py-4">
                        <div className="flex items-center gap-2 text-sm font-semibold text-cream-900">
                          <Zap className="h-4 w-4 text-teal-600" />
                          One-click Zoho login
                        </div>
                        <p className="mt-2 text-sm leading-6 text-cream-700">
                          Enter your Organization ID and log in with your Zoho account. You&apos;ll be redirected back here automatically.
                        </p>
                      </div>
                    ) : null}

                    {oauthNotice ? (
                      <div
                        className={cn(
                          'rounded-2xl border px-3 py-2 text-sm',
                          oauthNotice.kind === 'success'
                            ? 'border-success-50 bg-success-50 text-success-700'
                            : 'border-warning-500/30 bg-warning-50 text-warning-700',
                        )}
                      >
                        {oauthNotice.message}
                      </div>
                    ) : null}

                    <div className="grid gap-4 sm:grid-cols-2">
                      {wizardFields.map((field) => (
                        <Input
                          key={field.key}
                          label={field.label}
                          type={field.type === 'password' ? 'password' : 'text'}
                          required={field.required}
                          hint={field.help}
                          placeholder={field.placeholder}
                          value={wizard.credentials[field.key] ?? ''}
                          onChange={(event) => updateCredential(field.key, event.target.value)}
                        />
                      ))}
                    </div>

                    {wizardIntegration.auth_schema?.oauth === true ? (
                      <Button
                        type="button"
                        variant="primary"
                        disabled={!isSellerAdmin || missingRequired.length > 0 || isOAuthRedirecting}
                        onClick={() => void startZohoOAuth()}
                        className="w-full"
                      >
                        <Zap className="h-4 w-4" />
                        {isOAuthRedirecting ? 'Connecting to Zoho…' : 'Connect to Zoho'}
                      </Button>
                    ) : null}

                    {!isSellerAdmin ? (
                      <div className="rounded-2xl border border-warning-500/30 bg-warning-50 px-3 py-2 text-sm text-warning-700">
                        Seller admin access is required to connect and start syncing.
                      </div>
                    ) : null}

                    {missingRequired.length > 0 ? (
                      <div className="rounded-2xl border border-warning-500/30 bg-warning-50 px-3 py-2 text-sm text-warning-700">
                        Fill the required fields before continuing.
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {wizard.step === 2 ? (
                  <div className="space-y-4">
                    <div className="rounded-2xl border border-cream-200 bg-cream-50 px-4 py-4">
                      <div className="flex items-center gap-2 text-sm font-semibold text-cream-900">
                        <ShieldCheck className="h-4 w-4 text-teal-600" />
                        Start syncing
                      </div>
                      <p className="mt-2 text-sm leading-6 text-cream-700">
                        The connection is already saved. Starting sync will queue the Zoho import immediately using the stored secret.
                      </p>
                    </div>

                    <DatePicker
                      label="Import transactional history since"
                      value={wizard.importStartDate}
                      onChange={(value) => setWizard((current) => ({ ...current, importStartDate: value }))}
                      hint="Defaults to the start of the current financial year."
                    />

                    <div className="rounded-2xl border border-cream-200 bg-white px-4 py-4 text-sm text-cream-700">
                      <div className="font-semibold text-cream-900">Run order</div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Badge variant="outline">Reference data</Badge>
                        <ArrowRight className="h-4 w-4 text-cream-500" />
                        <Badge variant="outline">
                          Transactional backfill from {formatDate(wizard.importStartDate)}
                        </Badge>
                        <ArrowRight className="h-4 w-4 text-cream-500" />
                        <Badge variant="outline">Detail panel live updates</Badge>
                      </div>
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}
          </DialogBody>

          <DialogFooter className="justify-between">
            <div className="text-sm text-cream-600">
              {wizard.step === 2
                ? 'Sync starts in the background and updates the detail panel automatically.'
                : 'All progress returns to the detail panel.'}
            </div>
            <div className="flex items-center gap-2">
              {wizard.step > 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setWizard((current) => ({ ...current, step: Math.max(0, current.step - 1) }))}
                  disabled={isConnecting || isStartingSync}
                >
                  Back
                </Button>
              ) : null}

              {wizard.step < WIZARD_STEPS.length - 1 ? (
                wizard.step === 1 && wizardIntegration?.auth_schema?.oauth === true ? null : (
                  <Button
                    type="button"
                    onClick={() =>
                      setWizard((current) => ({
                        ...current,
                        step: Math.min(WIZARD_STEPS.length - 1, current.step + 1),
                      }))
                    }
                    disabled={
                      !wizardIntegration ||
                      !familyAvailability[wizardIntegration.family_flag] ||
                      (wizard.step === 1 && !canAdvanceFromConnect)
                    }
                  >
                    Continue
                  </Button>
                )
              ) : (
                <Button
                  type="button"
                  onClick={() => void runStartImport().catch(() => undefined)}
                  disabled={
                    !isSellerAdmin ||
                    !wizardIntegration ||
                    !familyAvailability[wizardIntegration.family_flag] ||
                    !wizard.importStartDate ||
                    isConnecting ||
                    isStartingSync
                  }
                >
                  {isConnecting || isStartingSync ? 'Starting sync…' : 'Start syncing'}
                </Button>
              )}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
