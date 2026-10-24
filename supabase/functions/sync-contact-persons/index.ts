/**
 * sync-contact-persons — fetches /contacts/contactpersons, persists
 * app.buyer_users for all contact persons. Runs as its own orchestrated
 * reference phase, right after `customers` (needs contacts already synced).
 *
 * Previously a bespoke self-dispatched sub-step of sync-customers
 * (dispatchContactPersonsStep/scheduleBackground), with its own job rows
 * that never set master_job_id — invisible to the reaper, the coordinator,
 * and the cancel RPC, so a stalled run here had no recovery path. Now a
 * plain phase worker like every other sync-{phase} function: sync-coordinator
 * creates and dispatches its slave row the same way it does for every
 * other phase, and runPhaseSync's budget/heartbeat/resume handling applies.
 *
 * Incremental mode (since is set):
 *   Zoho's /contacts/contactpersons endpoint does not support last_modified_time
 *   filtering, so a full paginated fetch (10,470 records at WineYard) runs on
 *   every incremental sync. Instead, we scope the fetch to buyers that changed
 *   in the since window — query app.buyers for external_refs with
 *   updated_at >= since, then call /contacts/{id}/contactpersons per buyer.
 *   Typically 10-50 buyers per day versus 10,470 records full-scan.
 */
import {
  createAdminClient,
  loadTenantIntegration,
  loadIntegrationCredentials,
  runPhaseSync,
  parseSyncRequest,
  jsonResponse,
  errorResponse,
  assertZohoIntegration,
  createDbTokenCache,
  resolveSyncImportActorId,
  updatePhaseJob,
} from '../_shared/sync-utils.ts';
import {
  attachParentContactId,
  createZohoAdapter,
  ZOHO_DETAIL_FETCH_CONCURRENCY,
  ZOHO_DETAIL_FETCH_BATCH_PACE_MS,
} from '../_shared/integrations-zoho.ts';
import { persistZohoEntityPage } from '../_shared/integrations-persist.ts';

type AdminClient = ReturnType<typeof createAdminClient>;

const CONTACT_PERSONS_PHASE = {
  id: 'contact_persons',
  label: 'Importing contact persons from Zoho',
  entityType: 'contact_persons',
  path: '/contacts/contactpersons',
  itemKey: 'contact_persons',
} as const;

async function loadModifiedBuyerExternalRefs(
  admin: AdminClient,
  tenantId: string,
  since: string,
): Promise<string[]> {
  const { data, error } = await admin
    .schema('app')
    .from('buyers')
    .select('external_ref')
    .eq('tenant_id', tenantId)
    .not('external_ref', 'is', null)
    .is('deleted_at', null)
    .gte('updated_at', since);

  if (error) throw new Error(`Could not load modified buyers: ${error.message}`);
  return (data ?? [])
    .map((row) => (row as { external_ref: unknown }).external_ref as string)
    .filter(Boolean);
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405);

  try {
    const input = await parseSyncRequest(req);
    const admin = createAdminClient();
    const integration = await loadTenantIntegration(admin, input.tenant_integration_id);
    const credentials = await loadIntegrationCredentials(admin, integration.id, integration.integration_type_id);

    // Incremental: fetch only for buyers modified in the since window.
    if (input.since) {
      const jobId = input.job_id;
      const startedAt = new Date().toISOString();

      if (jobId) {
        await updatePhaseJob(admin, jobId, { status: 'running', started_at: startedAt });
      }

      const modifiedBuyerIds = await loadModifiedBuyerExternalRefs(
        admin, integration.tenant_id, input.since,
      );

      if (modifiedBuyerIds.length === 0) {
        const completedAt = new Date().toISOString();
        if (jobId) {
          await updatePhaseJob(admin, jobId, {
            status: 'completed',
            records_synced: 0,
            completed_at: completedAt,
            progress: {
              phase: 'contact_persons',
              records_synced: 0,
              counts: { contact_persons: { entity_type: 'contact_persons', processed: 0, failed: 0, pages: 0 } },
            },
            summary: { note: 'No buyers modified since last sync; contact persons skipped.', last_synced_at: completedAt },
          });
        }
        return jsonResponse({ ok: true, phase: 'contact_persons', records_synced: 0, has_more: false, next_cursor: null });
      }

      const zohoTypeId = assertZohoIntegration(integration.integration_type_id);
      const tokenCache = createDbTokenCache(admin, integration.id);
      const adapter = createZohoAdapter(zohoTypeId, credentials, tokenCache);
      const importActorId = resolveSyncImportActorId(integration);

      const allContactPersons: Record<string, unknown>[] = [];
      let fetchErrors = 0;

      for (let i = 0; i < modifiedBuyerIds.length; i += ZOHO_DETAIL_FETCH_CONCURRENCY) {
        const batchStart = Date.now();
        const batch = modifiedBuyerIds.slice(i, i + ZOHO_DETAIL_FETCH_CONCURRENCY);

        const results = await Promise.allSettled(
          batch.map((contactId) =>
            adapter.request<{ contact_persons: Record<string, unknown>[] }>({
              path: `/contacts/${contactId}/contactpersons`,
            })
          ),
        );

        for (let j = 0; j < results.length; j++) {
          const result = results[j];
          if (result.status === 'rejected') {
            console.warn(`[sync-contact-persons] fetch failed for contact ${batch[j]}:`, result.reason);
            fetchErrors++;
            continue;
          }
          const persons = result.value?.contact_persons;
          if (Array.isArray(persons)) {
            allContactPersons.push(...attachParentContactId(persons, batch[j]));
          }
        }

        const isLastBatch = i + ZOHO_DETAIL_FETCH_CONCURRENCY >= modifiedBuyerIds.length;
        if (!isLastBatch) {
          const elapsed = Date.now() - batchStart;
          await sleep(ZOHO_DETAIL_FETCH_BATCH_PACE_MS - elapsed);
        }
      }

      let persisted = 0;
      if (allContactPersons.length > 0) {
        const result = await persistZohoEntityPage(
          admin, integration.tenant_id, importActorId, integration.id,
          'contact_persons', zohoTypeId, allContactPersons, undefined,
        );
        persisted = result.created + result.updated;
      }

      const completedAt = new Date().toISOString();
      const pages = Math.ceil(modifiedBuyerIds.length / ZOHO_DETAIL_FETCH_CONCURRENCY);
      if (jobId) {
        await updatePhaseJob(admin, jobId, {
          status: 'completed',
          records_synced: persisted,
          completed_at: completedAt,
          progress: {
            phase: 'contact_persons',
            records_synced: persisted,
            counts: {
              contact_persons: {
                entity_type: 'contact_persons',
                processed: persisted,
                failed: fetchErrors,
                pages,
              },
            },
          },
          summary: {
            note: `Incremental: ${modifiedBuyerIds.length} modified buyer${modifiedBuyerIds.length === 1 ? '' : 's'}, ${allContactPersons.length} contact persons fetched, ${persisted} upserted${fetchErrors > 0 ? `, ${fetchErrors} fetch errors` : ''}.`,
            last_synced_at: completedAt,
            modified_buyers: modifiedBuyerIds.length,
            contact_persons_fetched: allContactPersons.length,
          },
        });
      }

      return jsonResponse({
        ok: true,
        phase: 'contact_persons',
        records_synced: persisted,
        has_more: false,
        next_cursor: null,
      });
    }

    // Full refresh: paginated /contacts/contactpersons via runPhaseSync.
    const result = await runPhaseSync(admin, integration, credentials, CONTACT_PERSONS_PHASE, {
      jobId: input.job_id,
      pageFrom: input.page_from,
      perPage: input.per_page,
      since: input.since,
    });

    return jsonResponse(result);
  } catch (err) {
    console.error('[sync-contact-persons]', err);
    return errorResponse(err instanceof Error ? err.message : 'Sync failed');
  }
});
