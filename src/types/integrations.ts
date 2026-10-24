import { z } from 'zod';

const IntegrationSinceValueSchema = z.union([
  z.string().datetime({ offset: true }),
  z.string().date(),
]);

export const INTEGRATION_TYPE_IDS = ['zoho_books', 'zoho_inventory', 'tally_prime', 'busy', 'whatsapp_business'] as const;
export const IntegrationTypeIdSchema = z.enum(INTEGRATION_TYPE_IDS);
export type IntegrationTypeId = z.infer<typeof IntegrationTypeIdSchema>;

export const IntegrationRunOriginSchema = z.enum(['manual', 'scheduled', 'webhook']);
export type IntegrationRunOrigin = z.infer<typeof IntegrationRunOriginSchema>;

export const IntegrationConnectivityModeSchema = z.enum(['cloud', 'local']);
export type IntegrationConnectivityMode = z.infer<typeof IntegrationConnectivityModeSchema>;

export const TenantIntegrationStatusSchema = z.enum([
  'pending_setup',
  'connected',
  'syncing',
  'sync_failed',
  'disconnected',
]);
export type TenantIntegrationStatus = z.infer<typeof TenantIntegrationStatusSchema>;

export const TenantIntegrationHealthStatusSchema = z.enum(['ok', 'expired', 'invalid']);
export type TenantIntegrationHealthStatus = z.infer<typeof TenantIntegrationHealthStatusSchema>;

export const INTEGRATION_ENTITY_TYPES = ['locations', 'brands', 'categories', 'products', 'pricelists', 'customers', 'estimates', 'orders', 'invoices'] as const;
export const IntegrationEntityTypeSchema = z.enum(INTEGRATION_ENTITY_TYPES);
export type IntegrationEntityType = z.infer<typeof IntegrationEntityTypeSchema>;

export const INTEGRATION_CAPABILITY_ENTITY_TYPES = INTEGRATION_ENTITY_TYPES;
export const IntegrationCapabilityEntityTypeSchema = z.enum(INTEGRATION_CAPABILITY_ENTITY_TYPES);
export type IntegrationCapabilityEntityType = z.infer<typeof IntegrationCapabilityEntityTypeSchema>;

export const IntegrationFlowDirectionSchema = z.enum(['inbound', 'outbound', 'bidirectional']);
export type IntegrationFlowDirection = z.infer<typeof IntegrationFlowDirectionSchema>;

export const IntegrationFlowTriggerSchema = z.enum(['webhook', 'scheduled', 'event']);
export type IntegrationFlowTrigger = z.infer<typeof IntegrationFlowTriggerSchema>;

export const IntegrationSyncJobTypeSchema = z.enum([
  'initial_reference',
  'initial_transactional',
  'incremental',
  'manual',
]);
export type IntegrationSyncJobType = z.infer<typeof IntegrationSyncJobTypeSchema>;

// Orchestration-policy tag for "why this run started" — additive alongside
// job_type (kept for rebuild-window sizing and UI labels). See
// src/lib/integrations/sync-orchestration.ts's RunKind for the canonical type.
export const IntegrationRunKindSchema = z.enum([
  'initial_sync',
  'manual_full',
  'manual_phase',
  'daily_incremental',
]);
export type IntegrationRunKind = z.infer<typeof IntegrationRunKindSchema>;

export const IntegrationSyncJobStatusSchema = z.enum(['pending', 'queued', 'running', 'paused', 'completed', 'failed', 'cancelled']);
export type IntegrationSyncJobStatus = z.infer<typeof IntegrationSyncJobStatusSchema>;

export const IntegrationEntitySyncStatusSchema = z.enum(['synced', 'pending_push', 'conflict', 'error']);
export type IntegrationEntitySyncStatus = z.infer<typeof IntegrationEntitySyncStatusSchema>;

export const IntegrationAuthFieldTypeSchema = z.enum(['text', 'password', 'select', 'textarea', 'number', 'url']);
export type IntegrationAuthFieldType = z.infer<typeof IntegrationAuthFieldTypeSchema>;

export const IntegrationAuthFieldOptionSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    value: z.string().trim().min(1).max(120),
  })
  .strict();
export type IntegrationAuthFieldOption = z.infer<typeof IntegrationAuthFieldOptionSchema>;

export const IntegrationAuthFieldSchema = z
  .object({
    key: z.string().trim().regex(/^[a-z][a-z0-9_]*$/, 'Field keys must be snake_case identifiers'),
    label: z.string().trim().min(1).max(120),
    type: IntegrationAuthFieldTypeSchema,
    required: z.boolean().default(true),
    help: z.string().trim().min(1).max(500).optional(),
    placeholder: z.string().trim().min(1).max(160).optional(),
    secret: z.boolean().optional(),
    options: z.array(IntegrationAuthFieldOptionSchema).min(1).optional(),
  })
  .strict()
  .superRefine((field, ctx) => {
    if (field.type === 'select' && !field.options?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'Select auth fields must declare at least one option',
      });
    }

    if (field.type !== 'select' && field.options) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'Only select auth fields may define options',
      });
    }
  });
export type IntegrationAuthField = z.infer<typeof IntegrationAuthFieldSchema>;

const ManualIntegrationAuthSchema = z
  .object({
    oauth: z.literal(false).default(false),
    // Empty is valid: integrations with no credentials to collect (e.g.
    // email_forwarding) — min(1) crashed /settings/integrations (YUKTI-APP-1F).
    fields: z.array(IntegrationAuthFieldSchema).default([]),
  })
  .strict();

const OAuthIntegrationAuthSchema = z
  .object({
    oauth: z.literal(true),
    authorize_url: z.string().url().optional(),
    token_url: z.string().url().optional(),
    scopes: z.array(z.string().trim().min(1)).default([]),
    fields: z.array(IntegrationAuthFieldSchema).default([]),
  })
  .strict()
  .superRefine((schema, ctx) => {
    if (!schema.authorize_url && !schema.token_url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authorize_url'],
        message: 'OAuth auth schemas must declare an authorization or token endpoint',
      });
    }
  });

export const IntegrationAuthSchemaSchema = z.union([ManualIntegrationAuthSchema, OAuthIntegrationAuthSchema]);
export type IntegrationAuthSchema = z.infer<typeof IntegrationAuthSchemaSchema>;

const IntegrationCapabilityEntityListSchema = z.array(IntegrationCapabilityEntityTypeSchema);

export const IntegrationCapabilitiesSchema = z
  .object({
    inbound_reference: IntegrationCapabilityEntityListSchema.default([]),
    inbound_transactional: IntegrationCapabilityEntityListSchema.default([]),
    outbound_reference: IntegrationCapabilityEntityListSchema.default([]),
    outbound_transactional: IntegrationCapabilityEntityListSchema.default([]),
    webhooks: z.boolean().default(false),
    scheduled_sync: z.boolean().default(false),
    manual_sync: z.boolean().default(true),
    health_check: z.boolean().default(true),
  })
  .strict();
export type IntegrationCapabilities = z.infer<typeof IntegrationCapabilitiesSchema>;

export const IntegrationSyncPhaseStatsSchema = z
  .object({
    entity_type: z.string().trim().min(1).max(120),
    processed: z.number().int().min(0),
    failed: z.number().int().min(0),
    pages: z.number().int().min(0),
  })
  .strict();
export type IntegrationSyncPhaseStats = z.infer<typeof IntegrationSyncPhaseStatsSchema>;

export const IntegrationProgressCursorSchema = z
  .object({
    phase: z.string().trim().min(1).max(120),
    entity_type: z.string().trim().min(1).max(120),
    page: z.number().int().min(1),
    per_page: z.number().int().min(1),
    has_more: z.boolean(),
    since: IntegrationSinceValueSchema.nullable(),
  })
  .strict();
export type IntegrationProgressCursor = z.infer<typeof IntegrationProgressCursorSchema>;

export const IntegrationJobProgressSchema = z
  .object({
    mode: z.enum(['initial_import', 'incremental', 'manual']).optional(),
    version: z.number().int().min(1).optional(),
    provider: z.string().trim().min(1).max(40).optional(),
    scope: z.enum(['reference', 'transactional', 'full']).optional(),
    since: IntegrationSinceValueSchema.nullable().optional(),
    phases: z.array(z.string().trim().min(1).max(120)).default([]),
    phases_total: z.number().int().min(0).optional(),
    phase_current: z.number().int().min(0).optional(),
    phase: z.string().trim().min(1).max(120).nullable().optional(),
    phase_label: z.string().trim().min(1).max(200).optional(),
    current_entity: z.string().trim().min(1).max(120).optional(),
    current_page: z.number().int().min(1).optional(),
    total_pages_estimate: z.number().int().min(1).nullable().optional(),
    items_total: z.number().int().min(0).nullable().optional(),
    items_processed: z.number().int().min(0).optional(),
    items_failed: z.number().int().min(0).optional(),
    last_batch_size: z.number().int().min(0).optional(),
    pages_processed: z.number().int().min(0).optional(),
    cursor: z.union([IntegrationProgressCursorSchema, z.string().trim().min(1).max(2000)]).nullable().optional(),
    eta_seconds_remaining: z.number().int().min(0).nullable().optional(),
    percent: z.number().min(0).max(100).optional(),
    last_entity_type: z.string().trim().min(1).max(120).optional(),
    last_external_id: z.string().trim().min(1).max(200).optional(),
    message: z.string().trim().min(1).max(200).nullable().optional(),
    started_at: z.string().datetime({ offset: true }).optional(),
    updated_at: z.string().datetime({ offset: true }).optional(),
    counts: z.record(z.string().trim().min(1).max(120), IntegrationSyncPhaseStatsSchema).optional(),
    last_page: z
      .object({
        phase: z.string().trim().min(1).max(120),
        count: z.number().int().min(0),
        next_page: z.number().int().min(0).nullable(),
        completed_at: z.string().datetime({ offset: true }),
        sample_ids: z.array(z.string().trim().min(1).max(200)).optional(),
      })
      .strict()
      .optional(),
    note: z.string().trim().min(1).max(500).optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
    phases_in_run: z.array(z.string().trim().min(1).max(120)).optional(),
  })
  .passthrough()
  .superRefine((progress, ctx) => {
    if (
      progress.phases_total !== undefined &&
      progress.phase_current !== undefined &&
      progress.phase_current > progress.phases_total
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['phase_current'],
        message: 'phase_current cannot exceed phases_total',
      });
    }

    if (
      progress.items_total != null &&
      progress.items_processed !== undefined &&
      progress.items_processed > progress.items_total
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items_processed'],
        message: 'items_processed cannot exceed items_total',
      });
    }

    if (
      progress.items_total != null &&
      progress.items_failed !== undefined &&
      progress.items_failed > progress.items_total
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items_failed'],
        message: 'items_failed cannot exceed items_total',
      });
    }
  });
export type IntegrationJobProgress = z.infer<typeof IntegrationJobProgressSchema>;
export const IntegrationProgressSchema = IntegrationJobProgressSchema;
export type IntegrationProgress = IntegrationJobProgress;
export const IntegrationStatusSchema = TenantIntegrationStatusSchema;
export type IntegrationStatus = TenantIntegrationStatus;

const IntegrationJobSummaryCountSchema = z.number().int().min(0);

export const IntegrationJobSummarySchema = z
  .object({
    provider: z.string().trim().min(1).max(40).optional(),
    scope: z.enum(['reference', 'transactional', 'full']).optional(),
    since: IntegrationSinceValueSchema.nullable().optional(),
    run_origin: IntegrationRunOriginSchema.optional(),
    sync_window: z.string().trim().min(1).max(200).nullable().optional(),
    phases_completed: z.array(z.string().trim().min(1).max(120)).optional(),
    counts: z.record(z.string().trim().min(1).max(120), IntegrationSyncPhaseStatsSchema).optional(),
    last_synced_at: z.string().datetime({ offset: true }).optional(),
    note: z.string().trim().min(1).max(500).optional(),
    brands: IntegrationJobSummaryCountSchema.optional(),
    products: IntegrationJobSummaryCountSchema.optional(),
    customers: IntegrationJobSummaryCountSchema.optional(),
    estimates: IntegrationJobSummaryCountSchema.optional(),
    orders: IntegrationJobSummaryCountSchema.optional(),
    invoices: IntegrationJobSummaryCountSchema.optional(),
    total_processed: IntegrationJobSummaryCountSchema.optional(),
    total_failed: IntegrationJobSummaryCountSchema.optional(),
    duration_ms: z.number().int().min(0).optional(),
    warnings: z.array(z.string().trim().min(1).max(200)).optional(),
  })
  .passthrough();
export type IntegrationJobSummary = z.infer<typeof IntegrationJobSummarySchema>;

export interface IntegrationCoverageTotals {
  locations: number;
  customers: number;
  products: number;
  brands: number;
  categories: number;
  pricelists: number;
  inventory: number;
  estimates: number;
  orders: number;
  invoices: number;
  transactions: number;
}

export interface IntegrationWebhookTelemetryEntity {
  active: boolean;
  create: boolean;
  update: boolean;
  delete: boolean;
  processed_last_24h: number;
  failed_last_24h: number;
  last_received_at?: string | null;
  last_verified_at?: string | null;
}

export interface IntegrationWebhookTelemetry {
  status: 'active' | 'pending' | 'failed' | 'missing';
  total_processed_last_24h: number;
  total_failed_last_24h: number;
  entities: Record<'locations' | 'customers' | 'products' | 'transactions', IntegrationWebhookTelemetryEntity>;
}

export const IntegrationAggregateFreshnessStatusSchema = z.enum(['fresh', 'warning', 'stale', 'failed', 'unknown']);
export type IntegrationAggregateFreshnessStatus = z.infer<typeof IntegrationAggregateFreshnessStatusSchema>;

export const IntegrationAggregateFreshnessSchema = z
  .object({
    status: IntegrationAggregateFreshnessStatusSchema,
    latest_snapshot_refreshed_at: z.string().datetime({ offset: true }).nullable().optional(),
    latest_kpi_updated_at: z.string().datetime({ offset: true }).nullable().optional(),
    latest_analysis_at: z.string().datetime({ offset: true }).nullable().optional(),
    latest_sync_completed_at: z.string().datetime({ offset: true }).nullable().optional(),
    latest_aggregate_at: z.string().datetime({ offset: true }).nullable().optional(),
    repair_job_id: z.string().uuid().nullable().optional(),
    repair_rebuild_days: z.number().int().min(1).nullable().optional(),
    repair_in_progress: z.boolean().optional(),
    last_retried_at: z.string().datetime({ offset: true }).nullable().optional(),
    warning_message: z.string().trim().min(1).max(500).nullable().optional(),
  })
  .strict();
export type IntegrationAggregateFreshness = z.infer<typeof IntegrationAggregateFreshnessSchema>;

const IntegrationJobErrorEntrySchema = z.record(z.string(), z.unknown());
const IntegrationJobErrorLogSchema = z.union([
  z.array(IntegrationJobErrorEntrySchema),
  z
    .object({
      entries: z.array(IntegrationJobErrorEntrySchema),
    })
    .passthrough(),
]);

export const IntegrationEntityErrorSchema = z
  .object({
    entity_type: z.string().trim().min(1).max(120),
    external_id: z.string().trim().min(1).max(200).nullable().optional(),
    error_reason: z.string().trim().min(1).max(1000),
    updated_at: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();
export type IntegrationEntityError = z.infer<typeof IntegrationEntityErrorSchema>;

export const IntegrationTypeRecordSchema = z
  .object({
    id: IntegrationTypeIdSchema,
    display_name: z.string().trim().min(1).max(120),
    description: z.string().nullable(),
    logo_url: z.string().url().nullable(),
    auth_schema: IntegrationAuthSchemaSchema,
    capabilities: IntegrationCapabilitiesSchema,
    connectivity_mode: IntegrationConnectivityModeSchema,
    is_active: z.boolean(),
  })
  .strict();
export type IntegrationTypeRecord = z.infer<typeof IntegrationTypeRecordSchema>;

export const TenantIntegrationRecordSchema = z
  .object({
    id: z.string().uuid(),
    tenant_id: z.string().uuid(),
    integration_type_id: IntegrationTypeIdSchema,
    status: TenantIntegrationStatusSchema,
    config: z.record(z.string(), z.unknown()),
    last_health_check_at: z.string().datetime({ offset: true }).nullable(),
    health_status: TenantIntegrationHealthStatusSchema.nullable(),
    connected_at: z.string().datetime({ offset: true }).nullable(),
    connected_by: z.string().uuid().nullable(),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type TenantIntegrationRecord = z.infer<typeof TenantIntegrationRecordSchema>;

export const IntegrationJobRecordSchema = z
  .object({
    id: z.string().uuid(),
    tenant_integration_id: z.string().uuid(),
    job_type: IntegrationSyncJobTypeSchema,
    phase: z.string().trim().min(1).max(120).nullable().optional(),
    status: IntegrationSyncJobStatusSchema,
    run_origin: IntegrationRunOriginSchema.nullable().optional(),
    sync_window: z.string().trim().min(1).max(200).nullable().optional(),
    since_date: z.string().datetime({ offset: true }).nullable().optional(),
    progress: IntegrationJobProgressSchema,
    error_log: IntegrationJobErrorLogSchema.nullable().optional(),
    summary: IntegrationJobSummarySchema.nullable().optional(),
    started_at: z.string().datetime({ offset: true }).nullable(),
    completed_at: z.string().datetime({ offset: true }).nullable(),
    created_at: z.string().datetime({ offset: true }),
    master_job_id: z.string().uuid().nullable().optional(),
    heartbeat_at: z.string().datetime({ offset: true }).nullable().optional(),
    records_synced: z.number().int().min(0).nullable().optional(),
  })
  .strict();
export type IntegrationJobRecord = z.infer<typeof IntegrationJobRecordSchema>;

// Database functions may return the full integration_sync_jobs composite.
// Strip persistence-only columns at the server boundary before validating the
// strict payload DTO exposed to seller-app clients.
export const IntegrationJobRecordProjectionSchema = IntegrationJobRecordSchema.strip();

export const IntegrationDataFlowRecordSchema = z
  .object({
    id: z.string().uuid(),
    tenant_integration_id: z.string().uuid(),
    entity_type: IntegrationEntityTypeSchema,
    direction: IntegrationFlowDirectionSchema,
    trigger_type: IntegrationFlowTriggerSchema,
    schedule: z.string().trim().min(1).nullable(),
    webhook_id: z.string().uuid().nullable(),
    field_mappings: z.record(z.string(), z.unknown()),
    filters: z.record(z.string(), z.unknown()),
    is_active: z.boolean(),
    last_run_at: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type IntegrationDataFlowRecord = z.infer<typeof IntegrationDataFlowRecordSchema>;

export const IntegrationCatalogItemSchema = z
  .object({
    type: IntegrationTypeRecordSchema,
    integration: TenantIntegrationRecordSchema.nullable(),
    latest_job: IntegrationJobRecordSchema.nullable(),
    recent_jobs: z.array(IntegrationJobRecordSchema).default([]),
    active_flows: z.array(IntegrationDataFlowRecordSchema).default([]),
    recent_entity_errors: z.array(IntegrationEntityErrorSchema).default([]),
    coverage_totals: z
      .object({
        locations: z.number().int().min(0),
        customers: z.number().int().min(0),
        products: z.number().int().min(0),
        brands: z.number().int().min(0),
        categories: z.number().int().min(0),
        pricelists: z.number().int().min(0),
        inventory: z.number().int().min(0),
        estimates: z.number().int().min(0),
        orders: z.number().int().min(0),
        invoices: z.number().int().min(0),
        transactions: z.number().int().min(0),
      })
      .nullable()
      .optional(),
    webhook_telemetry: z
      .object({
        status: z.enum(['active', 'pending', 'failed', 'missing']),
        total_processed_last_24h: z.number().int().min(0),
        total_failed_last_24h: z.number().int().min(0),
        entities: z.record(
          z.enum(['locations', 'customers', 'products', 'transactions']),
          z.object({
            active: z.boolean(),
            create: z.boolean(),
            update: z.boolean(),
            delete: z.boolean(),
            processed_last_24h: z.number().int().min(0),
            failed_last_24h: z.number().int().min(0),
            last_received_at: z.string().datetime({ offset: true }).nullable().optional(),
            last_verified_at: z.string().datetime({ offset: true }).nullable().optional(),
          }),
        ),
      })
      .nullable()
      .optional(),
    aggregate_freshness: IntegrationAggregateFreshnessSchema.nullable().optional(),
  })
  .strict();
export type IntegrationCatalogItem = z.infer<typeof IntegrationCatalogItemSchema>;

export const IntegrationSettingsPayloadSchema = z
  .object({
    catalog: z.array(IntegrationCatalogItemSchema),
  })
  .strict();
export type IntegrationSettingsPayload = z.infer<typeof IntegrationSettingsPayloadSchema>;

export const IntegrationCredentialsInputSchema = z.record(z.string(), z.string().trim().min(1));
export type IntegrationCredentialsInput = z.infer<typeof IntegrationCredentialsInputSchema>;

export const IntegrationTestRequestSchema = z
  .object({
    integration_type_id: IntegrationTypeIdSchema,
    credentials: IntegrationCredentialsInputSchema,
  })
  .strict();
export type IntegrationTestRequest = z.infer<typeof IntegrationTestRequestSchema>;

export const IntegrationConnectRequestSchema = z
  .object({
    integration_type_id: IntegrationTypeIdSchema,
    credentials: IntegrationCredentialsInputSchema,
    config: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type IntegrationConnectRequest = z.infer<typeof IntegrationConnectRequestSchema>;

export const IntegrationSyncRequestSchema = z
  .object({
    tenant_integration_id: z.string().uuid(),
    job_type: IntegrationSyncJobTypeSchema.default('manual'),
    run_kind: IntegrationRunKindSchema.optional(),
    mode: z.enum(['initial_import', 'incremental', 'manual']).default('initial_import'),
    scope: z.enum(['reference', 'transactional', 'full']).optional(),
    phase: z.string().trim().min(1).max(120).optional(),
    run_origin: IntegrationRunOriginSchema.optional(),
    sync_window: z.string().trim().min(1).max(200).optional(),
    since: z.string().date().optional(),
    import_orders_since: z.string().date().optional(),
    max_pages: z.number().int().min(1).optional(),
    force_full_refresh: z.boolean().default(false),
  })
  .strict();
export type IntegrationSyncRequest = z.infer<typeof IntegrationSyncRequestSchema>;
