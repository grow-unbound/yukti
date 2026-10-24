export type DigestRollupRow = {
  tenant_id: string | null;
  estimates_enabled: boolean;
  orders_enabled: boolean;
  invoices_enabled: boolean;
  primary_demand_kind: string;
  estimate_count: number;
  estimate_value: number;
  estimate_buyer_count: number;
  estimate_void_count: number;
  order_count: number;
  order_value: number;
  order_buyer_count: number;
  order_cancelled_count: number;
  invoice_count: number;
  invoice_value: number;
  invoice_buyer_count: number;
  invoice_excluded_count: number;
  app_estimate_count: number;
  app_estimate_value: number;
  app_estimate_buyer_count: number;
  app_order_count: number;
  app_order_value: number;
  app_order_buyer_count: number;
  app_invoice_count: number;
  app_invoice_value: number;
  app_invoice_buyer_count: number;
  app_user_count: number;
  app_demand_buyer_count: number;
  repeat_app_demand_buyer_count: number;
  first_time_app_user_count: number;
  new_customer_record_count: number;
  webhook_event_count: number;
  webhook_failed_event_count: number;
  webhook_error_count: number;
  webhook_retryable_error_count: number;
  webhook_error_critical_count: number;
  sync_job_success_count: number;
  sync_job_failure_count: number;
  stale_integration_count: number;
  post_sync_rebuild_failure_count: number;
  active_tenant_count: number;
  computed_at: string;
  calculation_version: number;
};

export type DigestFlagRow = {
  tenant_id: string | null;
  metric: string;
  severity: 'critical' | 'warning' | 'info';
  current_value: number;
  baseline_value: number | null;
  delta_pct: number | null;
  message: string;
};

export type DigestTenant = { id: string; business_name: string };
export type SlackBlock = Record<string, unknown>;

export type DigestMessage = {
  text: string;
  blocks: SlackBlock[];
};

function finiteNumber(value: number | null | undefined): number {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

export function formatInr(value: number): string {
  return `₹${Math.round(finiteNumber(value)).toLocaleString('en-IN')}`;
}

function plural(count: number, singular: string): string {
  return `${count.toLocaleString('en-IN')} ${singular}${count === 1 ? '' : 's'}`;
}

export function formatDocumentMetric(
  value: number,
  count: number,
  buyers: number,
  documentLabel: string,
): string {
  return `${formatInr(value)} · ${plural(count, documentLabel)} · ${plural(buyers, 'buyer')}`;
}

export function formatComputedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown time';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date) + ' IST';
}

function contribution(value: number, total: number): string {
  if (finiteNumber(total) <= 0) return '0% of value';
  return `${Math.round((finiteNumber(value) / finiteNumber(total)) * 100)}% of value`;
}

function severityEmoji(severity: string): string {
  if (severity === 'critical') return '🔴';
  if (severity === 'warning') return '🟡';
  return 'ℹ️';
}

export function tenantActivityScore(row: DigestRollupRow): number {
  if (row.estimates_enabled) return finiteNumber(row.estimate_value);
  if (row.orders_enabled) return finiteNumber(row.order_value);
  if (row.invoices_enabled) return finiteNumber(row.invoice_value);
  return Math.max(
    finiteNumber(row.estimate_value),
    finiteNumber(row.order_value),
    finiteNumber(row.invoice_value),
  );
}

export function formatTenantActivity(row: DigestRollupRow, tenantName: string): string {
  const lines = [`*${tenantName}*`];
  if (row.estimates_enabled) {
    lines.push(`Estimates: ${formatDocumentMetric(row.estimate_value, row.estimate_count, row.estimate_buyer_count, 'estimate')}`);
  }
  if (row.orders_enabled) {
    lines.push(`Orders: ${formatDocumentMetric(row.order_value, row.order_count, row.order_buyer_count, 'order')}`);
  }
  if (row.invoices_enabled) {
    lines.push(`Invoices: ${formatDocumentMetric(row.invoice_value, row.invoice_count, row.invoice_buyer_count, 'invoice')}`);
  }
  if (lines.length === 1) {
    lines.push(`Invoices: ${formatDocumentMetric(row.invoice_value, row.invoice_count, row.invoice_buyer_count, 'invoice')}`);
  }
  return lines.join('\n');
}

export function buildDigestMessage(input: {
  day: string;
  globalRow: DigestRollupRow;
  tenantRows: DigestRollupRow[];
  flags: DigestFlagRow[];
  tenants: DigestTenant[];
}): DigestMessage {
  const { day, globalRow } = input;
  const tenantNameById = new Map(input.tenants.map((tenant) => [tenant.id, tenant.business_name]));
  const totalTenants = input.tenants.length;
  const severityRank: Record<string, number> = { critical: 0, warning: 1, info: 2 };
  const sortedFlags = [...input.flags].sort(
    (a, b) => (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9),
  );
  const criticalCount = sortedFlags.filter((flag) => flag.severity === 'critical').length;

  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `📊 Yukti Daily Digest — ${day}`, emoji: true },
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `Computed ${formatComputedAt(globalRow.computed_at)} · calculation v${globalRow.calculation_version} · ${globalRow.active_tenant_count}/${totalTenants} tenants active`,
      }],
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Estimates*\n${formatDocumentMetric(globalRow.estimate_value, globalRow.estimate_count, globalRow.estimate_buyer_count, 'estimate')}` },
        { type: 'mrkdwn', text: `*Orders*\n${formatDocumentMetric(globalRow.order_value, globalRow.order_count, globalRow.order_buyer_count, 'order')}` },
        { type: 'mrkdwn', text: `*Invoices*\n${formatDocumentMetric(globalRow.invoice_value, globalRow.invoice_count, globalRow.invoice_buyer_count, 'invoice')}` },
      ],
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*App users*\n${globalRow.app_user_count.toLocaleString('en-IN')}` },
        { type: 'mrkdwn', text: `*Demand submitters*\n${plural(globalRow.app_demand_buyer_count, 'buyer')}` },
        { type: 'mrkdwn', text: `*Repeat demand buyers*\n${globalRow.repeat_app_demand_buyer_count.toLocaleString('en-IN')}` },
        { type: 'mrkdwn', text: `*First-time app users*\n${globalRow.first_time_app_user_count.toLocaleString('en-IN')}` },
        { type: 'mrkdwn', text: `*New customer records*\n${globalRow.new_customer_record_count.toLocaleString('en-IN')}` },
        { type: 'mrkdwn', text: `*App estimates*\n${formatDocumentMetric(globalRow.app_estimate_value, globalRow.app_estimate_count, globalRow.app_estimate_buyer_count, 'estimate')} · ${contribution(globalRow.app_estimate_value, globalRow.estimate_value)}` },
        { type: 'mrkdwn', text: `*App orders*\n${formatDocumentMetric(globalRow.app_order_value, globalRow.app_order_count, globalRow.app_order_buyer_count, 'order')} · ${contribution(globalRow.app_order_value, globalRow.order_value)}` },
        { type: 'mrkdwn', text: `*App invoices*\n${formatDocumentMetric(globalRow.app_invoice_value, globalRow.app_invoice_count, globalRow.app_invoice_buyer_count, 'invoice')} · ${contribution(globalRow.app_invoice_value, globalRow.invoice_value)}` },
      ],
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Sync jobs*\n${globalRow.sync_job_success_count} succeeded · ${globalRow.sync_job_failure_count} failed · ${globalRow.stale_integration_count} stale` },
        { type: 'mrkdwn', text: `*Webhooks*\n${globalRow.webhook_event_count} events · ${globalRow.webhook_error_count} errors · ${globalRow.webhook_error_critical_count} non-retryable` },
      ],
    },
    { type: 'divider' },
  ];

  if (sortedFlags.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `✅ *No alerts triggered across ${totalTenants} tenants* — data checks passed.` },
    });
  } else {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `⚠️ *${sortedFlags.length} alert${sortedFlags.length === 1 ? '' : 's'}* · ${criticalCount} critical` },
    });
    for (const flag of sortedFlags.slice(0, 15)) {
      const scope = flag.tenant_id ? (tenantNameById.get(flag.tenant_id) ?? 'Unknown tenant') : 'Platform-wide';
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `${severityEmoji(flag.severity)} *${scope}* — ${flag.message}` },
      });
    }
    if (sortedFlags.length > 15) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `…and ${sortedFlags.length - 15} more alerts.` }],
      });
    }
  }

  const topTenants = [...input.tenantRows]
    .filter((row) => tenantActivityScore(row) > 0)
    .sort((a, b) => tenantActivityScore(b) - tenantActivityScore(a))
    .slice(0, 5);

  if (topTenants.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*Leading tenant activity*' },
    });
    for (const row of topTenants) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: formatTenantActivity(row, tenantNameById.get(row.tenant_id ?? '') ?? 'Unknown tenant'),
        },
      });
    }
  }

  const exclusions = [
    globalRow.estimate_void_count > 0 ? plural(globalRow.estimate_void_count, 'void estimate') : null,
    globalRow.order_cancelled_count > 0 ? plural(globalRow.order_cancelled_count, 'cancelled order') : null,
    globalRow.invoice_excluded_count > 0 ? plural(globalRow.invoice_excluded_count, 'excluded invoice') : null,
  ].filter(Boolean);
  if (exclusions.length > 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Excluded from headline totals: ${exclusions.join(' · ')}` }],
    });
  }

  return {
    text: criticalCount > 0
      ? `Yukti Daily Digest ${day}: ${criticalCount} critical alert(s)`
      : `Yukti Daily Digest ${day}: ${globalRow.estimate_count} estimates, ${sortedFlags.length} alert(s)`,
    blocks,
  };
}
