import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const headersMock = vi.fn();
const getFlagMock = vi.fn();
const loadIntegrationsSettingsPayloadMock = vi.fn();
const useFlagStateMock = vi.fn();
const apiFetchMock = vi.fn();
const apiPostMock = vi.fn();
const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
const redirectMock = vi.fn();
const routerReplaceMock = vi.fn();
const useAuthMock = vi.fn();

vi.mock('next/headers', () => ({
  headers: () => headersMock(),
}));

vi.mock('next/navigation', () => ({
  redirect: (...args: unknown[]) => redirectMock(...args),
  useRouter: () => ({
    replace: (...args: unknown[]) => routerReplaceMock(...args),
    push: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
  usePathname: () => '/settings/integrations',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/flags', () => ({
  FLAGS: {
    INTEGRATIONS: 'df_integrations',
  },
  getFlag: (...args: unknown[]) => getFlagMock(...args),
}));

vi.mock('@/lib/integrations/server', () => ({
  loadIntegrationsSettingsPayload: (...args: unknown[]) => loadIntegrationsSettingsPayloadMock(...args),
}));

vi.mock('@/hooks/useFeatureFlag', () => ({
  useFlagState: (flag: string) => useFlagStateMock(flag),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => useAuthMock(),
}));

vi.mock('@/lib/server/seller-server-claims', () => ({
  requireSellerServerTenantId: async () => 'tenant-1',
}));

vi.mock('@/lib/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiPost: (...args: unknown[]) => apiPostMock(...args),
}));

vi.mock('@/lib/supabase', () => {
  const channel = {
    on: vi.fn(() => channel),
    subscribe: vi.fn(() => channel),
  };

  return {
    supabase: {
      channel: vi.fn(() => channel),
      removeChannel: vi.fn(),
    },
  };
});

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

import SettingsIntegrationsPage from '../../../app/(seller)/settings/integrations/page';
import { IntegrationsSettingsClient } from '@/components/seller/settings/IntegrationsSettingsClient';
import { ConnectedIntegrationCard } from '@/components/seller/settings/ConnectedIntegrationCard';

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify({ data, error: null }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderWithQueryClient(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function buildIntegrationsPayload(overrides?: {
  activeJobStatus?: 'queued' | 'running' | 'completed';
  includeSummary?: boolean;
}) {
  const runningJob =
    overrides?.activeJobStatus && overrides.activeJobStatus !== 'completed'
      ? {
          id: 'job-1',
          job_type: 'initial_reference',
          status: overrides.activeJobStatus,
          progress: {
            phase: 'products',
            phase_label: 'Importing products...',
            phases_total: 2,
            phase_current: 2,
            items_total: 1240,
            items_processed: overrides.activeJobStatus === 'queued' ? 0 : 812,
            items_failed: 2,
          },
          error_log: [],
          summary: null,
          started_at: '2026-06-12T09:00:00.000Z',
          completed_at: null,
          created_at: '2026-06-12T08:59:00.000Z',
        }
      : null;

  const completedHistory = {
    id: 'job-1',
    job_type: 'initial_reference',
    status: 'completed',
    progress: {
      phase: 'completed',
      phase_label: 'Imported reference and transactional data.',
      phases_total: 2,
      phase_current: 2,
      items_total: 1240,
      items_processed: 1240,
      items_failed: 2,
    },
    error_log: [],
    summary: overrides?.includeSummary
      ? {
          brands: 42,
          products: 1240,
          customers: 89,
          orders: 318,
        }
      : null,
    started_at: '2026-06-12T09:00:00.000Z',
    completed_at: '2026-06-12T09:07:00.000Z',
    created_at: '2026-06-12T08:59:00.000Z',
  };

  return {
    integrations: [
      {
        id: 'zoho_books',
        display_name: 'Zoho Books',
        description: 'Sync orders and invoices with Zoho Books.',
        family_flag: 'ZOHO_INTEGRATION',
        connectivity_mode: 'cloud',
        auth_schema: {
          fields: [
            { key: 'client_id', label: 'Client ID', type: 'text', required: true },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true },
            { key: 'refresh_token', label: 'Refresh Token', type: 'password', required: true },
            { key: 'org_id', label: 'Organization ID', type: 'text', required: true },
          ],
        },
        capabilities: {
          inbound_reference: ['brands', 'products', 'customers'],
          inbound_transactional: ['orders', 'invoices', 'estimates'],
        },
        coverage_totals: {
          locations: 5,
          customers: 89,
          products: 1240,
          brands: 42,
          categories: 18,
          pricelists: 9,
          estimates: 41,
          orders: 318,
          invoices: 220,
          transactions: 579,
        },
        recent_entity_errors: [
          {
            entity_type: 'orders',
            external_id: 'SO-404',
            error_reason: 'Unable to resolve product ITEM-404 for order SO-404.',
            updated_at: '2026-06-23T10:30:00.000Z',
          },
        ],
        webhook_telemetry: {
          status: 'active',
          total_processed_last_24h: 13,
          total_failed_last_24h: 1,
          entities: {
            locations: {
              active: false,
              create: false,
              update: false,
              delete: false,
              processed_last_24h: 0,
              failed_last_24h: 0,
              last_received_at: '2026-06-23T05:05:00.000Z',
              last_verified_at: '2026-06-22T05:05:00.000Z',
            },
            customers: {
              active: true,
              create: true,
              update: true,
              delete: false,
              processed_last_24h: 4,
              failed_last_24h: 0,
              last_received_at: '2026-06-23T08:15:00.000Z',
              last_verified_at: '2026-06-22T08:10:00.000Z',
            },
            products: {
              active: true,
              create: true,
              update: true,
              delete: true,
              processed_last_24h: 6,
              failed_last_24h: 1,
              last_received_at: '2026-06-23T09:00:00.000Z',
              last_verified_at: '2026-06-22T09:00:00.000Z',
            },
            transactions: {
              active: true,
              create: true,
              update: true,
              delete: false,
              processed_last_24h: 3,
              failed_last_24h: 0,
              last_received_at: '2026-06-23T10:00:00.000Z',
              last_verified_at: '2026-06-22T10:00:00.000Z',
            },
          },
        },
        tenant_integration:
          overrides?.activeJobStatus || overrides?.includeSummary
            ? {
                id: 'tenant-int-1',
                status: overrides?.activeJobStatus === 'completed' || overrides?.includeSummary ? 'connected' : 'syncing',
                health_status: 'ok',
                connected_at: '2026-06-10T11:00:00.000Z',
                last_health_check_at: '2026-06-12T08:50:00.000Z',
                config: { org_id: 'org-123' },
                active_job: runningJob,
                sync_history: [overrides?.activeJobStatus === 'completed' || overrides?.includeSummary ? completedHistory : runningJob].filter(Boolean),
                data_flows: [
                  {
                    id: 'flow-1',
                    entity_type: 'orders',
                    direction: 'outbound',
                    trigger_type: 'event',
                    schedule: null,
                    is_active: true,
                    last_run_at: '2026-06-12T09:10:00.000Z',
                  },
                ],
              }
            : null,
      },
      {
        id: 'zoho_inventory',
        display_name: 'Zoho Inventory',
        description: 'Keep products and stock movement aligned with Zoho Inventory.',
        family_flag: 'ZOHO_INTEGRATION',
        connectivity_mode: 'cloud',
        auth_schema: {
          fields: [],
        },
        capabilities: {
          inbound_reference: ['products'],
          inbound_transactional: [],
        },
        tenant_integration: null,
      },
      {
        id: 'tally_prime',
        display_name: 'Tally Prime',
        description: 'Bridge-based local integration for Tally Prime.',
        family_flag: 'TALLY_INTEGRATION',
        connectivity_mode: 'local',
        auth_schema: {
          fields: [],
        },
        capabilities: {
          inbound_reference: ['products'],
          inbound_transactional: ['orders'],
        },
        tenant_integration: null,
      },
      {
        id: 'busy',
        display_name: 'Busy Accounting',
        description: 'Reserve the Busy integration slot while rollout stays gated.',
        family_flag: 'BUSY_INTEGRATION',
        connectivity_mode: 'local',
        auth_schema: {
          fields: [],
        },
        capabilities: {
          inbound_reference: ['products'],
          inbound_transactional: ['orders'],
        },
        tenant_integration: null,
      },
    ],
    last_updated_at: '2026-06-12T09:11:00.000Z',
  };
}

describe('settings integrations page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    headersMock.mockResolvedValue(new Headers([['x-verified-tenant-id', 'tenant-1']]));
    getFlagMock.mockResolvedValue(true);
    loadIntegrationsSettingsPayloadMock.mockResolvedValue({ catalog: [] });
    useFlagStateMock.mockImplementation((flag: string) => {
      if (flag === 'TALLY_INTEGRATION' || flag === 'BUSY_INTEGRATION') return false;
      return true;
    });
    useAuthMock.mockReturnValue({
      currentTenantId: 'tenant-1',
      tenantProfile: { role: 'seller_admin' },
    });
    apiFetchMock.mockImplementation(async () => jsonResponse(buildIntegrationsPayload()));
    apiPostMock.mockImplementation(async () => jsonResponse({ ok: true }));
  });

  it('renders feature-off state when umbrella integrations flag is disabled', async () => {
    getFlagMock.mockResolvedValue(false);

    render(await SettingsIntegrationsPage());

    expect(screen.getByText("This feature isn't enabled yet.")).toBeInTheDocument();
  });

  it('renders integrations settings when umbrella flag is enabled', async () => {
    renderWithQueryClient(await SettingsIntegrationsPage());

    expect(await screen.findByRole('heading', { name: 'Integrations' })).toBeInTheDocument();
    expect(await screen.findByText('No integrations setup yet')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Add integration' })).toBeInTheDocument();
  });
});

describe('integrations settings client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFlagStateMock.mockImplementation((flag: string) => {
      if (flag === 'TALLY_INTEGRATION' || flag === 'BUSY_INTEGRATION') return false;
      return true;
    });
    useAuthMock.mockReturnValue({
      currentTenantId: 'tenant-1',
      tenantProfile: { role: 'seller_admin' },
    });
    apiFetchMock.mockImplementation(async () => jsonResponse(buildIntegrationsPayload()));
    apiPostMock.mockImplementation(async () => jsonResponse({ ok: true }));
  });

  it('opens the picker with only available Zoho integrations', async () => {
    renderWithQueryClient(<IntegrationsSettingsClient />);

    fireEvent.click(await screen.findByRole('button', { name: 'Add integration' }));

    expect(await screen.findByRole('heading', { name: 'Add integration' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Zoho Books/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Zoho Inventory/ })).toBeInTheDocument();
    expect(screen.queryByText('Tally Prime')).not.toBeInTheDocument();
    expect(screen.queryByText('Busy Accounting')).not.toBeInTheDocument();
  });

  it('shows recent entity sync errors on the connected integration card', () => {
    render(
      <ConnectedIntegrationCard
        integration={buildIntegrationsPayload({ includeSummary: true }).integrations[0] as never}
        available
        isSellerAdmin
        onOpenWizard={vi.fn()}
        onDisconnect={vi.fn()}
        onSyncNow={vi.fn()}
        onSyncPhase={vi.fn()}
        onStopSync={vi.fn()}
        onRefresh={vi.fn()}
        onRetryWebhooks={vi.fn()}
      />,
    );

    expect(screen.getByText('Recent entity sync errors')).toBeInTheDocument();
    expect(screen.getByText(/Orders · SO-404: Unable to resolve product ITEM-404 for order SO-404\./)).toBeInTheDocument();
  });

  it('shows a settings warning when the analysis phase fails', () => {
    render(
      <ConnectedIntegrationCard
        integration={{
          id: 'zoho_books',
          display_name: 'Zoho Books',
          description: 'Sync orders and invoices with Zoho Books.',
          family_flag: 'ZOHO_INTEGRATION',
          connectivity_mode: 'cloud',
          auth_schema: { fields: [] },
          capabilities: {
            inbound_reference: ['brands', 'products', 'customers'],
            inbound_transactional: ['estimates', 'orders', 'invoices'],
          },
          coverage_totals: {
            locations: 5,
            customers: 89,
            products: 1240,
            brands: 42,
            categories: 18,
            pricelists: 9,
            estimates: 41,
            orders: 318,
            invoices: 220,
            transactions: 579,
          },
          tenant_integration: {
            id: 'tenant-int-1',
            status: 'connected',
            health_status: 'ok',
            connected_at: '2026-06-10T11:00:00.000Z',
            last_health_check_at: '2026-06-12T08:50:00.000Z',
            config: { org_id: 'org-123' },
            active_job: null,
            sync_history: [
              {
                id: 'job-analysis-failed',
                job_type: 'manual',
                phase: 'analysis',
                status: 'failed',
                progress: {
                  phase: 'analysis',
                  phase_label: 'Aggregate freshness check failed for invoices_snapshot.',
                  phases_total: 1,
                  phase_current: 1,
                  items_total: 0,
                  items_processed: 0,
                  items_failed: 1,
                },
                error_log: [],
                summary: {
                  warnings: [
                    'Aggregate freshness check failed for invoices_snapshot.',
                  ],
                },
                started_at: '2026-07-09T05:00:00.000Z',
                completed_at: '2026-07-09T05:01:00.000Z',
                created_at: '2026-07-09T05:00:00.000Z',
              },
            ],
            data_flows: [],
          },
        }}
        available
        isSellerAdmin
        onOpenWizard={vi.fn()}
        onDisconnect={vi.fn()}
        onSyncNow={vi.fn()}
        onSyncPhase={vi.fn()}
        onStopSync={vi.fn()}
        onRefresh={vi.fn()}
        onRetryWebhooks={vi.fn()}
      />,
    );

    expect(screen.getByText('Analysis failed: Aggregate freshness check failed for invoices_snapshot.')).toBeInTheDocument();
  });

  it('shows analysis readiness rows after the analysis phase completes', () => {
    render(
      <ConnectedIntegrationCard
        integration={{
          id: 'zoho_books',
          display_name: 'Zoho Books',
          description: 'Sync orders and invoices with Zoho Books.',
          family_flag: 'ZOHO_INTEGRATION',
          connectivity_mode: 'cloud',
          auth_schema: { fields: [] },
          capabilities: {
            inbound_reference: ['brands', 'products', 'customers'],
            inbound_transactional: ['estimates', 'orders', 'invoices'],
          },
          coverage_totals: {
            locations: 5,
            customers: 89,
            products: 1240,
            brands: 42,
            categories: 18,
            pricelists: 9,
            estimates: 41,
            orders: 318,
            invoices: 220,
            transactions: 579,
          },
          tenant_integration: {
            id: 'tenant-int-1',
            status: 'connected',
            health_status: 'ok',
            connected_at: '2026-06-10T11:00:00.000Z',
            last_health_check_at: '2026-06-12T08:50:00.000Z',
            config: { org_id: 'org-123' },
            active_job: null,
            sync_history: [
              {
                id: 'job-analysis-complete',
                job_type: 'manual',
                phase: 'analysis',
                status: 'completed',
                progress: {
                  phase: 'analysis',
                  phase_label: 'Analysis complete',
                  phases_total: 1,
                  phase_current: 1,
                  items_total: 0,
                  items_processed: 0,
                  items_failed: 0,
                },
                error_log: [],
                summary: {
                  warnings: [],
                },
                started_at: '2026-07-09T05:00:00.000Z',
                completed_at: '2026-07-09T05:01:00.000Z',
                created_at: '2026-07-09T05:00:00.000Z',
              },
            ],
            data_flows: [],
          },
        }}
        available
        isSellerAdmin
        onOpenWizard={vi.fn()}
        onDisconnect={vi.fn()}
        onSyncNow={vi.fn()}
        onSyncPhase={vi.fn()}
        onStopSync={vi.fn()}
        onRefresh={vi.fn()}
        onRetryWebhooks={vi.fn()}
      />,
    );

    expect(screen.getByText('Snapshots')).toBeInTheDocument();
    expect(screen.getByText('KPI tables')).toBeInTheDocument();
    expect(screen.getByText('Recommendations')).toBeInTheDocument();
    expect(screen.getAllByText('Ready').length).toBeGreaterThan(0);
  });

  it('starts sync now without sending the legacy scope field', async () => {
    apiFetchMock.mockImplementation(async () => jsonResponse(buildIntegrationsPayload({ includeSummary: true })));

    renderWithQueryClient(<IntegrationsSettingsClient />);

    fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }));
    expect(await screen.findByText('Choose a sync window for full sync')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start sync' }));

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/api/settings/integrations/sync', expect.objectContaining({
        tenant_integration_id: 'tenant-int-1',
        job_type: 'manual',
        force_full_refresh: false,
      }));
    });
  });

  it('closes the setup wizard immediately after starting a sync', async () => {
    apiFetchMock.mockImplementation(async () => jsonResponse(buildIntegrationsPayload()));

    let resolveSyncResponse!: (value: Response) => void;
    const syncResponse = new Promise<Response>((resolve) => {
      resolveSyncResponse = resolve;
    });

    apiPostMock.mockImplementation(async (url: string) => {
      if (url === '/api/settings/integrations/connect') {
        return jsonResponse(buildIntegrationsPayload({ includeSummary: true }));
      }

      if (url === '/api/settings/integrations/sync') {
        return syncResponse;
      }

      throw new Error(`Unexpected POST ${url}`);
    });

    renderWithQueryClient(<IntegrationsSettingsClient />);

    fireEvent.click(await screen.findByRole('button', { name: 'Add integration' }));
    fireEvent.click(await screen.findByRole('button', { name: /Zoho Books/ }));

    await screen.findByRole('heading', { name: 'Setup Zoho Books' });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    fireEvent.change(await screen.findByLabelText('Client ID'), { target: { value: 'client-id' } });
    fireEvent.change(await screen.findByLabelText('Client Secret'), { target: { value: 'client-secret' } });
    fireEvent.change(await screen.findByLabelText('Refresh Token'), { target: { value: 'refresh-token' } });
    fireEvent.change(await screen.findByLabelText('Organization ID'), { target: { value: 'org-123' } });

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('button', { name: 'Start syncing' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Start syncing' }));

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Setup Zoho Books' })).not.toBeInTheDocument();
    });

    resolveSyncResponse(jsonResponse({ job_id: 'job-123' }));

    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith('Sync started');
    });
  });

  it('starts a phase-scoped sync for a single entity', async () => {
    apiFetchMock.mockImplementation(async () => jsonResponse(buildIntegrationsPayload({ includeSummary: true })));

    renderWithQueryClient(<IntegrationsSettingsClient />);

    fireEvent.click((await screen.findAllByRole('button', { name: 'Sync Again' }))[0]!);
    expect(await screen.findByText('Choose a sync window for Reference Data')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start phase sync' }));

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/api/settings/integrations/sync', expect.objectContaining({
        tenant_integration_id: 'tenant-int-1',
        job_type: 'manual',
        phase: 'reference',
        force_full_refresh: false,
      }));
    });
  });

  it('shows both reconnect and disconnect actions when an integration needs attention', () => {
    render(
      <ConnectedIntegrationCard
        integration={{
          id: 'zoho_books',
          display_name: 'Zoho Books',
          description: 'Sync orders and invoices with Zoho Books.',
          family_flag: 'ZOHO_INTEGRATION',
          connectivity_mode: 'cloud',
          auth_schema: { fields: [] },
          capabilities: {
            inbound_reference: ['brands'],
            inbound_transactional: ['orders'],
          },
          tenant_integration: {
            id: 'tenant-int-1',
            status: 'connected',
            health_status: 'invalid',
            connected_at: '2026-06-10T11:00:00.000Z',
            last_health_check_at: '2026-06-12T08:50:00.000Z',
            config: { org_id: 'org-123' },
            active_job: null,
            sync_history: [],
            data_flows: [],
          },
        }}
        available
        isSellerAdmin
        onOpenWizard={vi.fn()}
        onDisconnect={vi.fn()}
        onSyncNow={vi.fn()}
        onSyncPhase={vi.fn()}
        onStopSync={vi.fn()}
        onRefresh={vi.fn()}
        onRetryWebhooks={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Sync now' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
  });

  it('shows stop sync when a job is actively running', () => {
    render(
      <ConnectedIntegrationCard
        integration={{
          id: 'zoho_books',
          display_name: 'Zoho Books',
          description: 'Sync orders and invoices with Zoho Books.',
          family_flag: 'ZOHO_INTEGRATION',
          connectivity_mode: 'cloud',
          auth_schema: { fields: [] },
          capabilities: {
            inbound_reference: ['brands'],
            inbound_transactional: ['orders'],
          },
          tenant_integration: {
            id: 'tenant-int-1',
            status: 'syncing',
            health_status: 'ok',
            connected_at: '2026-06-10T11:00:00.000Z',
            last_health_check_at: '2026-06-12T08:50:00.000Z',
            config: { org_id: 'org-123' },
            active_job: {
              id: 'job-1',
              job_type: 'manual',
              status: 'running',
              progress: {
                phase: 'customers',
                phase_label: 'Importing customers...',
                phases_total: 4,
                phase_current: 2,
                items_total: 0,
                items_processed: 120,
                items_failed: 0,
                pages_processed: 2,
                counts: {
                  brands: { entity_type: 'brands', processed: 12, failed: 0, pages: 1 },
                  customers: { entity_type: 'customers', processed: 120, failed: 0, pages: 2 },
                },
              },
              error_log: [],
              summary: null,
              started_at: '2026-06-12T09:00:00.000Z',
              completed_at: null,
              created_at: '2026-06-12T08:59:00.000Z',
            },
            sync_history: [],
            data_flows: [],
          },
        }}
        available
        isSellerAdmin
        onOpenWizard={vi.fn()}
        onDisconnect={vi.fn()}
        onSyncNow={vi.fn()}
        onSyncPhase={vi.fn()}
        onStopSync={vi.fn()}
        onRefresh={vi.fn()}
        onRetryWebhooks={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Stop sync' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
  });

  it('surfaces Zoho schedules in flows and distinguishes scheduled runs in history', () => {
    render(
      <ConnectedIntegrationCard
        integration={{
          id: 'zoho_books',
          display_name: 'Zoho Books',
          description: 'Sync orders and invoices with Zoho Books.',
          family_flag: 'ZOHO_INTEGRATION',
          connectivity_mode: 'cloud',
          auth_schema: { fields: [] },
          capabilities: {
            inbound_reference: ['brands', 'products', 'customers'],
            inbound_transactional: ['estimates', 'orders', 'invoices'],
          },
          tenant_integration: {
            id: 'tenant-int-1',
            status: 'connected',
            health_status: 'ok',
            connected_at: '2026-06-10T11:00:00.000Z',
            last_health_check_at: '2026-06-12T08:50:00.000Z',
            config: { org_id: 'org-123' },
            active_job: null,
            sync_history: [
              {
                id: 'job-scheduled',
                job_type: 'incremental',
                phase: 'sync_run',
                status: 'completed',
                run_origin: 'scheduled',
                sync_window: 'Last 24 hours',
                progress: {
                  phase: 'orders',
                  phase_label: 'Importing sales orders from Zoho Books',
                  phases_total: 3,
                  phase_current: 3,
                  items_total: 120,
                  items_processed: 120,
                  items_failed: 0,
                  pages_processed: 1,
                  counts: {
                    orders: { entity_type: 'orders', processed: 120, failed: 0, pages: 1 },
                  },
                },
                error_log: [],
                summary: {
                  provider: 'zoho',
                  scope: 'transactional',
                  since: '2026-06-22T00:00:00.000Z',
                  run_origin: 'scheduled',
                  sync_window: 'Last 24 hours',
                  phases_completed: ['orders'],
                  counts: {
                    orders: { entity_type: 'orders', processed: 120, failed: 0, pages: 1 },
                  },
                  last_synced_at: '2026-06-23T05:05:00.000Z',
                },
                started_at: '2026-06-23T05:00:00.000Z',
                completed_at: '2026-06-23T05:05:00.000Z',
                created_at: '2026-06-23T05:00:00.000Z',
              },
              {
                id: 'job-manual',
                job_type: 'manual',
                phase: 'sync_run',
                status: 'completed',
                run_origin: 'manual',
                progress: {
                  phase: 'products',
                  phase_label: 'Importing products from Zoho Books',
                  phases_total: 3,
                  phase_current: 2,
                  items_total: 80,
                  items_processed: 80,
                  items_failed: 0,
                  pages_processed: 1,
                  counts: {
                    products: { entity_type: 'products', processed: 80, failed: 0, pages: 1 },
                  },
                },
                error_log: [],
                summary: {
                  provider: 'zoho',
                  scope: 'reference',
                  since: '2026-06-21T00:00:00.000Z',
                  run_origin: 'manual',
                  phases_completed: ['products'],
                  counts: {
                    products: { entity_type: 'products', processed: 80, failed: 0, pages: 1 },
                  },
                  last_synced_at: '2026-06-21T11:05:00.000Z',
                },
                started_at: '2026-06-21T11:00:00.000Z',
                completed_at: '2026-06-21T11:05:00.000Z',
                created_at: '2026-06-21T11:00:00.000Z',
              },
            ],
            data_flows: [
              {
                id: 'flow-locations',
                entity_type: 'locations',
                direction: 'inbound',
                trigger_type: 'event',
                schedule: '0 5 * * *',
                field_mappings: {},
                filters: {},
                is_active: true,
                last_run_at: '2026-06-23T05:05:00.000Z',
              },
              {
                id: 'flow-products',
                entity_type: 'products',
                direction: 'inbound',
                trigger_type: 'webhook',
                schedule: '0 5 * * *',
                field_mappings: {},
                filters: {},
                is_active: true,
                last_run_at: '2026-06-23T05:05:00.000Z',
              },
            ],
            webhook_telemetry: {
              status: 'active',
              total_processed_last_24h: 13,
              total_failed_last_24h: 1,
              entities: {
                locations: {
                  active: true,
                  create: false,
                  update: true,
                  delete: false,
                  processed_last_24h: 0,
                  failed_last_24h: 0,
                },
                customers: {
                  active: true,
                  create: true,
                  update: true,
                  delete: false,
                  processed_last_24h: 4,
                  failed_last_24h: 0,
                },
                products: {
                  active: true,
                  create: true,
                  update: true,
                  delete: true,
                  processed_last_24h: 6,
                  failed_last_24h: 1,
                },
                transactions: {
                  active: true,
                  create: true,
                  update: true,
                  delete: false,
                  processed_last_24h: 3,
                  failed_last_24h: 0,
                },
              },
            },
          },
        }}
        available
        isSellerAdmin
        onOpenWizard={vi.fn()}
        onDisconnect={vi.fn()}
        onSyncNow={vi.fn()}
        onSyncPhase={vi.fn()}
        onStopSync={vi.fn()}
        onRefresh={vi.fn()}
        onRetryWebhooks={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: /Data flows/ }));

    expect(screen.getByText('Schedule coverage')).toBeInTheDocument();
    expect(screen.getByText('Webhooks')).toBeInTheDocument();
    expect(screen.getAllByText('Daily 5:00 AM').length).toBeGreaterThan(0);
    expect(screen.getByTestId('webhooks-status-label')).toHaveTextContent('WEBHOOKS ACTIVE');
    expect(screen.getByText('today · 6 processed')).toBeInTheDocument();
    expect(screen.getAllByText(/Next run/i).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('tab', { name: /History/ }));

    expect(screen.getAllByText('Scheduled').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Manual').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Incremental · Since/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Manual · Since/i).length).toBeGreaterThan(0);
  });

  it('marks cancelled runs clearly in history', () => {
    render(
      <ConnectedIntegrationCard
        integration={{
          id: 'zoho_books',
          display_name: 'Zoho Books',
          description: 'Sync orders and invoices with Zoho Books.',
          family_flag: 'ZOHO_INTEGRATION',
          connectivity_mode: 'cloud',
          auth_schema: { fields: [] },
          capabilities: {
            inbound_reference: ['brands'],
            inbound_transactional: ['orders'],
          },
          tenant_integration: {
            id: 'tenant-int-1',
            status: 'connected',
            health_status: 'ok',
            connected_at: '2026-06-10T11:00:00.000Z',
            last_health_check_at: '2026-06-12T08:50:00.000Z',
            config: { org_id: 'org-123' },
            active_job: null,
            sync_history: [
              {
                id: 'job-1',
                job_type: 'manual',
                phase: 'sync_run',
                status: 'cancelled',
                progress: {
                  phase: 'cancelled',
                  phase_label: 'Sync cancelled',
                  phases_total: 4,
                  phase_current: 2,
                  items_total: 0,
                  items_processed: 120,
                  items_failed: 0,
                  pages_processed: 2,
                },
                error_log: [],
                summary: null,
                started_at: '2026-06-12T09:00:00.000Z',
                completed_at: '2026-06-12T09:03:00.000Z',
                created_at: '2026-06-12T08:59:00.000Z',
              },
            ],
            data_flows: [],
          },
        }}
        available
        isSellerAdmin
        onOpenWizard={vi.fn()}
        onDisconnect={vi.fn()}
        onSyncNow={vi.fn()}
        onSyncPhase={vi.fn()}
        onStopSync={vi.fn()}
        onRefresh={vi.fn()}
        onRetryWebhooks={vi.fn()}
      />,
    );

    expect(screen.getAllByText('Cancelled').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('tab', { name: /History/ }));
    expect(screen.getAllByText(/Cancelled by user request/i).length).toBeGreaterThan(0);
  });

  it('shows phase-scoped sync controls for Zoho integrations', () => {
    render(
      <ConnectedIntegrationCard
        integration={{
          id: 'zoho_books',
          display_name: 'Zoho Books',
          description: 'Sync orders and invoices with Zoho Books.',
          family_flag: 'ZOHO_INTEGRATION',
          connectivity_mode: 'cloud',
          auth_schema: { fields: [] },
          capabilities: {
            inbound_reference: ['brands', 'products', 'customers'],
            inbound_transactional: ['estimates', 'orders', 'invoices'],
          },
          tenant_integration: {
            id: 'tenant-int-1',
            status: 'connected',
            health_status: 'ok',
            connected_at: '2026-06-10T11:00:00.000Z',
            last_health_check_at: '2026-06-12T08:50:00.000Z',
            config: { org_id: 'org-123' },
            active_job: null,
            sync_history: [],
            data_flows: [],
          },
        }}
        available
        isSellerAdmin
        onOpenWizard={vi.fn()}
        onDisconnect={vi.fn()}
        onSyncNow={vi.fn()}
        onSyncPhase={vi.fn()}
        onStopSync={vi.fn()}
        onRefresh={vi.fn()}
        onRetryWebhooks={vi.fn()}
        syncTargetPhase={null}
      />,
    );

    expect(screen.getByText('Phase 2 — Transactions')).toBeInTheDocument();
    expect(screen.getByText('Estimates')).toBeInTheDocument();
    expect(screen.getByText('Sales Orders')).toBeInTheDocument();
    expect(screen.getByText('Invoices')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Sync Again' }).length).toBeGreaterThan(0);
  });

  it('shows Run Analysis only for seller admins when aggregate maintenance needs attention', () => {
    const integration = {
      id: 'zoho_books',
      display_name: 'Zoho Books',
      description: 'Sync orders and invoices with Zoho Books.',
      family_flag: 'ZOHO_INTEGRATION' as const,
      connectivity_mode: 'cloud' as const,
      auth_schema: { fields: [] },
      capabilities: {
        inbound_reference: ['brands', 'products', 'customers'],
        inbound_transactional: ['estimates', 'orders', 'invoices'],
      },
      tenant_integration: {
        id: 'tenant-int-1',
        status: 'connected' as const,
        health_status: 'ok' as const,
        connected_at: '2026-06-10T11:00:00.000Z',
        last_health_check_at: '2026-06-12T08:50:00.000Z',
        config: { org_id: 'org-123' },
        active_job: null,
        sync_history: [],
        data_flows: [],
        aggregate_freshness: {
          status: 'stale',
          latest_aggregate_at: '2026-07-08T05:00:00.000Z',
          latest_snapshot_refreshed_at: '2026-07-08T05:00:00.000Z',
          latest_kpi_updated_at: '2026-07-08T05:00:00.000Z',
          warning_message: 'Aggregate freshness is older than today.',
        },
      },
    };

    const { rerender } = render(
      <ConnectedIntegrationCard
        integration={integration as never}
        available
        isSellerAdmin={false}
        onOpenWizard={vi.fn()}
        onDisconnect={vi.fn()}
        onSyncNow={vi.fn()}
        onSyncPhase={vi.fn()}
        onStopSync={vi.fn()}
        onRefresh={vi.fn()}
        onRetryWebhooks={vi.fn()}
        onRepairAggregates={vi.fn()}
        onRunAnalysis={vi.fn()}
      />,
    );

    expect(screen.queryAllByRole('button', { name: 'Run Analysis' })).toHaveLength(0);

    rerender(
      <ConnectedIntegrationCard
        integration={integration as never}
        available
        isSellerAdmin
        onOpenWizard={vi.fn()}
        onDisconnect={vi.fn()}
        onSyncNow={vi.fn()}
        onSyncPhase={vi.fn()}
        onStopSync={vi.fn()}
        onRefresh={vi.fn()}
        onRetryWebhooks={vi.fn()}
        onRepairAggregates={vi.fn()}
        onRunAnalysis={vi.fn()}
      />,
    );

    expect(screen.getAllByRole('button', { name: 'Run Analysis' }).length).toBeGreaterThan(0);
  });

  it('prefers item-based progress when the worker reports item totals', () => {
    render(
      <ConnectedIntegrationCard
        integration={{
          id: 'zoho_books',
          display_name: 'Zoho Books',
          description: 'Sync orders and invoices with Zoho Books.',
          family_flag: 'ZOHO_INTEGRATION',
          connectivity_mode: 'cloud',
          auth_schema: { fields: [] },
          capabilities: {
            inbound_reference: ['brands', 'products', 'customers'],
            inbound_transactional: ['estimates', 'orders', 'invoices'],
          },
          tenant_integration: {
            id: 'tenant-int-1',
            status: 'syncing',
            health_status: 'ok',
            connected_at: '2026-06-10T11:00:00.000Z',
            last_health_check_at: '2026-06-12T08:50:00.000Z',
            config: { org_id: 'org-123' },
            active_job: {
              id: 'job-products',
              job_type: 'manual',
              status: 'running',
              progress: {
                phase: 'products',
                phase_label: 'Importing products...',
                phases_total: 3,
                phase_current: 1,
                items_total: 80,
                items_processed: 80,
                items_failed: 0,
                pages_processed: 1,
                counts: {
                  products: { entity_type: 'products', processed: 80, failed: 0, pages: 1 },
                },
              },
              error_log: [],
              summary: null,
              started_at: '2026-06-12T09:00:00.000Z',
              completed_at: null,
              created_at: '2026-06-12T08:59:00.000Z',
            },
            sync_history: [],
            data_flows: [],
          },
        }}
        available
        isSellerAdmin
        onOpenWizard={vi.fn()}
        onDisconnect={vi.fn()}
        onSyncNow={vi.fn()}
        onSyncPhase={vi.fn()}
        onStopSync={vi.fn()}
        onRefresh={vi.fn()}
        onRetryWebhooks={vi.fn()}
      />,
    );

    expect(screen.getByText('80 / 80')).toBeInTheDocument();
  });

  it('falls back to phase-based progress when item totals are unavailable', () => {
    render(
      <ConnectedIntegrationCard
        integration={{
          id: 'zoho_books',
          display_name: 'Zoho Books',
          description: 'Sync orders and invoices with Zoho Books.',
          family_flag: 'ZOHO_INTEGRATION',
          connectivity_mode: 'cloud',
          auth_schema: { fields: [] },
          capabilities: {
            inbound_reference: ['brands', 'products', 'customers'],
            inbound_transactional: ['estimates', 'orders', 'invoices'],
          },
          tenant_integration: {
            id: 'tenant-int-1',
            status: 'syncing',
            health_status: 'ok',
            connected_at: '2026-06-10T11:00:00.000Z',
            last_health_check_at: '2026-06-12T08:50:00.000Z',
            config: { org_id: 'org-123' },
            active_job: {
              id: 'job-manual',
              job_type: 'manual',
              status: 'running',
              progress: {
                phase: 'customers',
                phase_label: 'Importing customers...',
                phases_total: 7,
                phase_current: 4,
                items_total: 0,
                items_processed: 1200,
                items_failed: 0,
                pages_processed: 6,
                counts: {
                  locations: { entity_type: 'locations', processed: 9, failed: 0, pages: 1 },
                  products: { entity_type: 'products', processed: 447, failed: 0, pages: 1 },
                  pricelists: { entity_type: 'pricelists', processed: 3, failed: 0, pages: 1 },
                  customers: { entity_type: 'customers', processed: 1200, failed: 0, pages: 6 },
                },
              },
              error_log: [],
              summary: null,
              started_at: '2026-06-12T09:00:00.000Z',
              completed_at: null,
              created_at: '2026-06-12T08:59:00.000Z',
            },
            sync_history: [],
            data_flows: [],
          },
        }}
        available
        isSellerAdmin
        onOpenWizard={vi.fn()}
        onDisconnect={vi.fn()}
        onSyncNow={vi.fn()}
        onSyncPhase={vi.fn()}
        onStopSync={vi.fn()}
        onRefresh={vi.fn()}
        onRetryWebhooks={vi.fn()}
      />,
    );

    expect(screen.getByText('4 / 7')).toBeInTheDocument();
  });

  it('only marks the selected phase as syncing while a phase sync is pending', () => {
    render(
      <ConnectedIntegrationCard
        integration={{
          id: 'zoho_books',
          display_name: 'Zoho Books',
          description: 'Sync orders and invoices with Zoho Books.',
          family_flag: 'ZOHO_INTEGRATION',
          connectivity_mode: 'cloud',
          auth_schema: { fields: [] },
          capabilities: {
            inbound_reference: ['brands', 'products', 'customers'],
            inbound_transactional: ['estimates', 'orders', 'invoices'],
          },
          tenant_integration: {
            id: 'tenant-int-1',
            status: 'syncing',
            health_status: 'ok',
            connected_at: '2026-06-10T11:00:00.000Z',
            last_health_check_at: '2026-06-12T08:50:00.000Z',
            config: { org_id: 'org-123' },
            active_job: {
              id: 'job-2',
              job_type: 'manual',
              status: 'running',
              progress: {
                phase: 'customers',
                phase_label: 'Importing customers...',
                phases_total: 1,
                phase_current: 1,
                items_total: 0,
                items_processed: 0,
                items_failed: 0,
                pages_processed: 0,
                counts: {
                  customers: { entity_type: 'customers', processed: 0, failed: 0, pages: 0 },
                },
              },
              error_log: [],
              summary: null,
              started_at: '2026-06-12T09:00:00.000Z',
              completed_at: null,
              created_at: '2026-06-12T08:59:00.000Z',
            },
            sync_history: [],
            data_flows: [],
          },
        }}
        available
        isSellerAdmin
        onOpenWizard={vi.fn()}
        onDisconnect={vi.fn()}
        onSyncNow={vi.fn()}
        onSyncPhase={vi.fn()}
        onStopSync={vi.fn()}
        onRefresh={vi.fn()}
        onRetryWebhooks={vi.fn()}
        isSyncingNow
        syncTargetPhase="customers"
      />,
    );

    expect(screen.getByRole('button', { name: 'Stop sync' })).toBeInTheDocument();
    const phaseButtons = screen.getAllByRole('button', { name: 'Sync Again' });
    expect(phaseButtons.length).toBeGreaterThan(0);
    expect(phaseButtons.every((button) => button.hasAttribute('disabled'))).toBe(true);
  });

  it('surfaces the latest sync failure reason', () => {
    render(
      <ConnectedIntegrationCard
        integration={{
          id: 'zoho_books',
          display_name: 'Zoho Books',
          description: 'Sync orders and invoices with Zoho Books.',
          family_flag: 'ZOHO_INTEGRATION',
          connectivity_mode: 'cloud',
          auth_schema: { fields: [] },
          capabilities: {
            inbound_reference: ['brands'],
            inbound_transactional: ['orders'],
          },
          tenant_integration: {
            id: 'tenant-int-1',
            status: 'connected',
            health_status: 'ok',
            connected_at: '2026-06-10T11:00:00.000Z',
            last_health_check_at: '2026-06-12T08:50:00.000Z',
            config: { org_id: 'org-123' },
            active_job: null,
            sync_history: [
              {
                id: 'job-1',
                job_type: 'initial_reference',
                status: 'failed',
                progress: {
                  phase: 'products',
                  phase_label: 'Importing products...',
                  phases_total: 2,
                  phase_current: 1,
                  items_total: 1240,
                  items_processed: 812,
                  items_failed: 1,
                },
                error_log: [
                  {
                    timestamp: '2026-06-12T09:07:00.000Z',
                    message: 'Unable to retrieve integration secret.',
                  },
                ],
                summary: null,
                started_at: '2026-06-12T09:00:00.000Z',
                completed_at: '2026-06-12T09:07:00.000Z',
                created_at: '2026-06-12T08:59:00.000Z',
              },
            ],
            data_flows: [],
          },
        }}
        available
        isSellerAdmin
        onOpenWizard={vi.fn()}
        onDisconnect={vi.fn()}
        onSyncNow={vi.fn()}
        onSyncPhase={vi.fn()}
        onStopSync={vi.fn()}
        onRefresh={vi.fn()}
        onRetryWebhooks={vi.fn()}
      />,
    );

    expect(screen.getByText('Last sync failed')).toBeInTheDocument();
    expect(screen.getByText('Unable to retrieve integration secret.')).toBeInTheDocument();
  });
});
