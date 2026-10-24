import { beforeEach, describe, expect, it, vi } from 'vitest';

// source_payload is written to R2 (not inline jsonb) by batchUpsertEntityMap
// — mock the R2 write so tests don't need a real S3 client / Deno env.
const { putObjectJsonMock } = vi.hoisted(() => ({ putObjectJsonMock: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../supabase/functions/_shared/r2.ts', () => ({
  putObjectJson: putObjectJsonMock,
}));

import { persistZohoEntityPage } from '../../../supabase/functions/_shared/integrations-persist';

function createAdminStub(options?: {
  tableRows?: Record<string, Array<Record<string, unknown>>>;
  fieldMappings?: Array<Record<string, unknown>>;
  authUsers?: Array<{ id: string; email: string | null }>;
  tenantUsers?: Array<{ user_id: string }>;
}) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown>; result?: unknown }> = [];
  const updateCalls: Array<{ table: string; payload: Record<string, unknown>; filters: Record<string, unknown> }> = [];
  const operationLog: string[] = [];
  const tableRows = options?.tableRows ?? {};
  const fieldMappings = options?.fieldMappings ?? [];
  const authUsers = options?.authUsers ?? [];
  const tenantUsers = options?.tenantUsers ?? [];

  function filterRows(tableName: string, state: {
    eq: Record<string, unknown>;
    neq: Record<string, unknown>;
    in: { column: string; values: string[] } | null;
    is: Record<string, unknown>;
    like: { column: string; pattern: string } | null;
    gt: { column: string; value: unknown } | null;
  }) {
    return (tableRows[tableName] ?? []).filter((row) => {
      for (const [column, value] of Object.entries(state.eq)) {
        if (row[column] !== value) return false;
      }

      for (const [column, value] of Object.entries(state.neq)) {
        if (row[column] === value) return false;
      }

      if (state.in) {
        const currentValue = row[state.in.column];
        if (!state.in.values.includes(String(currentValue ?? ''))) return false;
      }

      for (const [column, value] of Object.entries(state.is)) {
        if (value === null && row[column] !== null && row[column] !== undefined) return false;
      }

      if (state.like) {
        const value = String(row[state.like.column] ?? '');
        const regex = new RegExp(`^${state.like.pattern.replace(/[%]/g, '.*')}$`);
        if (!regex.test(value)) return false;
      }

      if (state.gt) {
        const currentValue = row[state.gt.column];
        if (currentValue === null || currentValue === undefined || currentValue <= state.gt.value) return false;
      }

      return true;
    });
  }

  function queryChain(tableName: string) {
    const state: {
      eq: Record<string, unknown>;
      neq: Record<string, unknown>;
      in: { column: string; values: string[] } | null;
      is: Record<string, unknown>;
      like: { column: string; pattern: string } | null;
      gt: { column: string; value: unknown } | null;
    } = {
      eq: {},
      neq: {},
      in: null,
      is: {},
      like: null,
      gt: null,
    };

    let updatePayload: Record<string, unknown> = {};

    const chain: any = {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        state.eq[column] = value;
        return chain;
      },
      neq: (column: string, value: unknown) => {
        state.neq[column] = value;
        return chain;
      },
      in: (column: string, values: string[]) => {
        state.in = { column, values };
        return chain;
      },
      is: (column: string, value: unknown) => {
        state.is[column] = value;
        return chain;
      },
      like: (column: string, pattern: string) => {
        state.like = { column, pattern };
        return chain;
      },
      gt: (column: string, value: unknown) => {
        state.gt = { column, value };
        return chain;
      },
      maybeSingle: async () => {
        const rows = tableName === 'tenant_field_mappings'
          ? fieldMappings.filter((row) => {
            for (const [column, value] of Object.entries(state.eq)) {
              if (row[column] !== value) return false;
            }
            return true;
          })
          : filterRows(tableName, state);
        return { data: rows[0] ?? null, error: null };
      },
      update: (payload: Record<string, unknown>) => {
        updatePayload = payload;
        return chain;
      },
      then: (resolve: (result: { data: Array<Record<string, unknown>>; error: null }) => void) => {
        if (Object.keys(updatePayload).length > 0) {
          operationLog.push(`update:${tableName}`);
          updateCalls.push({
            table: tableName,
            payload: updatePayload,
            filters: { ...state.eq, in: state.in, is: state.is, like: state.like },
          });
        }
        const rows = tableName === 'tenant_field_mappings'
          ? fieldMappings.filter((row) => {
            for (const [column, value] of Object.entries(state.eq)) {
              if ((row as Record<string, unknown>)[column] !== value) return false;
            }
            return true;
          })
          : tableName === 'tenant_users'
            ? tenantUsers.filter((row) => {
              for (const [column, value] of Object.entries(state.eq)) {
                if ((row as Record<string, unknown>)[column] !== value) return false;
              }
              return true;
            })
          : filterRows(tableName, state);
        resolve({ data: rows, error: null });
      },
    };

    return chain;
  }

  return {
    rpcCalls,
    updateCalls,
    operationLog,
    client: {
      auth: {
        admin: {
          listUsers: async () => ({
            data: {
              users: authUsers,
            },
          }),
        },
      },
      schema: () => ({
        rpc: async (fn: string, args: Record<string, unknown>) => {
          const entry: { fn: string; args: Record<string, unknown>; result?: unknown } = { fn, args };
          rpcCalls.push(entry);
          if (fn === 'bulk_persist_jsonb_records' && typeof args.p_table === 'string') {
            operationLog.push(`rpc:${args.p_table}`);
          }

          if (fn === 'bulk_persist_jsonb_records') {
            const rows = Array.isArray(args.p_rows) ? args.p_rows as Array<Record<string, unknown>> : [];

            const data = rows.map((row, index) => ({
              id: typeof row.id === 'string' ? row.id : `${String(args.p_table)}-${index + 1}`,
              ...row,
            }));
            entry.result = data;
            return { data, error: null };
          }

          // Mirrors app.persist_with_natural_key_lock: resolve each row by
          // external_ref OR the natural key against pre-seeded tableRows,
          // assign the matched id, then persist (same id-assignment shape
          // as the bulk_persist_jsonb_records branch above). Resolution now
          // happens inside the RPC, not beforehand — args.p_rows no longer
          // carries a pre-resolved id, only entry.result (the RPC's return
          // value) does.
          if (fn === 'persist_with_natural_key_lock') {
            const table = String(args.p_table);
            const rows = Array.isArray(args.p_rows) ? args.p_rows as Array<Record<string, unknown>> : [];
            const naturalKeyCol = String(args.p_natural_key_col);
            const existing = tableRows[table] ?? [];

            operationLog.push(`rpc:${table}`);

            const resolvedRows = rows.map((row) => {
              const match = existing.find((r) => r.external_ref === row.external_ref)
                ?? existing.find((r) => r[naturalKeyCol] === row[naturalKeyCol]);
              return match ? { ...row, id: match.id } : row;
            });

            const persisted = resolvedRows.map((row, index) => ({
              id: typeof row.id === 'string' ? row.id : `${table}-${index + 1}`,
              ...row,
            }));

            const data = { rows: persisted, conflicts: [] };
            entry.result = data;
            return { data, error: null };
          }

          return { data: null, error: null };
        },
        from: (tableName: string) => queryChain(tableName),
      }),
    },
  };
}

function getEntityMapRows(
  admin: ReturnType<typeof createAdminStub>,
  entityType: string,
): Array<Record<string, unknown>> {
  return admin.rpcCalls
    .filter((call) => (call.fn === 'bulk_persist_jsonb_records' || call.fn === 'persist_with_natural_key_lock') && call.args.p_table === 'integration_entity_map')
    .flatMap((call) => (call.args.p_rows as Array<Record<string, unknown>>) ?? [])
    .filter((row) => row.entity_type === entityType);
}

describe('zoho customer and transaction persistence', () => {
  beforeEach(() => {
    putObjectJsonMock.mockClear();
  });

  it('persists contact persons by buyer external_ref when the customer map is missing', async () => {
    const admin = createAdminStub({
      tableRows: {
        buyers: [{ id: 'buyer-1', tenant_id: 'tenant-1', external_ref: 'CUST-1', deleted_at: null }],
      },
    });

    const result = await persistZohoEntityPage(
      admin.client as never,
      'tenant-1',
      'user-1',
      'integration-1',
      'contact_persons',
      'zoho_books',
      [{ contact_id: 'CUST-1', contact_person_id: 'CP-1', first_name: 'Asha' }],
    );

    expect(result.created).toBe(1);
    const buyerUsersCall = admin.rpcCalls.find((call) => (
      call.fn === 'bulk_persist_jsonb_records' && call.args.p_table === 'buyer_users'
    ));
    expect(buyerUsersCall?.args.p_rows).toEqual([
      expect.objectContaining({ buyer_id: 'buyer-1', external_ref: 'CP-1' }),
    ]);
  });

  it('dedupes customer, contact person, and price list assignment upserts within a single page', async () => {
    const admin = createAdminStub({
      tableRows: {
        price_lists: [
          {
            tenant_id: 'tenant-1',
            external_ref: 'PB-1',
            id: 'price-list-1',
            deleted_at: null,
          },
        ],
      },
    });

    await persistZohoEntityPage(
      admin.client as never,
      'tenant-1',
      'user-1',
      'integration-1',
      'customers',
      'zoho_books',
      [
        {
          contact_id: 'CUST-1',
          company_name: 'Acme Retail',
          contact_name: 'Asha',
          pricebook_id: 'PB-1',
          contact_persons: [
            {
              contact_person_id: 'CP-1',
              first_name: 'Asha',
              email: 'asha@example.com',
            },
          ],
        },
        {
          contact_id: 'CUST-1',
          company_name: 'Acme Retail Updated',
          contact_name: 'Asha',
          pricebook_id: 'PB-1',
          contact_persons: [
            {
              contact_person_id: 'CP-1',
              first_name: 'Asha',
              email: 'asha@example.com',
            },
          ],
        },
      ],
    );

    const buyersCall = admin.rpcCalls.find((call) => (
      (call.fn === 'bulk_persist_jsonb_records' || call.fn === 'persist_with_natural_key_lock') && call.args.p_table === 'buyers'
    ));
    const buyerUsersCall = admin.rpcCalls.find((call) => (
      (call.fn === 'bulk_persist_jsonb_records' || call.fn === 'persist_with_natural_key_lock') && call.args.p_table === 'buyer_users'
    ));
    const assignmentsCall = admin.rpcCalls.find((call) => (
      (call.fn === 'bulk_persist_jsonb_records' || call.fn === 'persist_with_natural_key_lock') && call.args.p_table === 'price_list_assignments'
    ));

    expect(Array.isArray(buyersCall?.args.p_rows)).toBe(true);
    expect(buyersCall?.args.p_rows as unknown[]).toHaveLength(1);
    expect(Array.isArray(buyerUsersCall?.args.p_rows)).toBe(true);
    expect(buyerUsersCall?.args.p_rows as unknown[]).toHaveLength(1);
    expect(Array.isArray(assignmentsCall?.args.p_rows)).toBe(true);
    expect(assignmentsCall?.args.p_rows as unknown[]).toHaveLength(1);
  });

  it.each([
    {
      label: 'estimate number collision',
      entityType: 'estimates',
      idField: 'estimate_id',
      numberField: 'estimate_number',
      existingRows: {
        estimates: [
          {
            id: 'estimate-existing',
            tenant_id: 'tenant-1',
            external_ref: 'EST-legacy',
            estimate_number: 'EST-2026-0001',
            deleted_at: null,
          },
        ],
      },
      records: [
        {
          estimate_id: 'EST-A',
          estimate_number: 'EST-2026-0001',
          status: 'draft',
          date: '2026-06-25',
          line_items: [],
        },
        {
          estimate_id: 'EST-B',
          estimate_number: 'EST-2026-0001',
          status: 'draft',
          date: '2026-06-25',
          line_items: [],
        },
      ],
      expectedId: 'estimate-existing',
    },
    {
      label: 'order number collision',
      entityType: 'orders',
      idField: 'salesorder_id',
      numberField: 'salesorder_number',
      existingRows: {
        orders: [
          {
            id: 'order-existing',
            tenant_id: 'tenant-1',
            external_ref: 'SO-legacy',
            order_number: 'SO-2026-0001',
            deleted_at: null,
          },
        ],
      },
      records: [
        {
          salesorder_id: 'SO-A',
          salesorder_number: 'SO-2026-0001',
          status: 'open',
          date: '2026-06-25',
          line_items: [],
        },
        {
          salesorder_id: 'SO-B',
          salesorder_number: 'SO-2026-0001',
          status: 'open',
          date: '2026-06-25',
          line_items: [],
        },
      ],
      expectedId: 'order-existing',
    },
    {
      label: 'invoice number collision',
      entityType: 'invoices',
      idField: 'invoice_id',
      numberField: 'invoice_number',
      existingRows: {
        invoices: [
          {
            id: 'invoice-existing',
            tenant_id: 'tenant-1',
            external_ref: 'INV-legacy',
            invoice_number: 'INV-2026-0001',
            deleted_at: null,
          },
        ],
      },
      records: [
        {
          invoice_id: 'INV-A',
          invoice_number: 'INV-2026-0001',
          status: 'sent',
          date: '2026-06-25',
          line_items: [],
        },
        {
          invoice_id: 'INV-B',
          invoice_number: 'INV-2026-0001',
          status: 'sent',
          date: '2026-06-25',
          line_items: [],
        },
      ],
      expectedId: 'invoice-existing',
    },
  ] as const)('reuses the existing row for $label', async ({ existingRows, records, entityType, expectedId }) => {
    const admin = createAdminStub({
      tableRows: existingRows,
    });

    await persistZohoEntityPage(
      admin.client as never,
      'tenant-1',
      'user-1',
      'integration-1',
      entityType,
      'zoho_books',
      records as Array<Record<string, unknown>>,
    );

    const persistedCall = admin.rpcCalls.find((call) => (call.fn === 'bulk_persist_jsonb_records' || call.fn === 'persist_with_natural_key_lock') && call.args.p_table === entityType);
    expect(persistedCall).toBeTruthy();
    const submittedRows = Array.isArray(persistedCall?.args.p_rows) ? persistedCall?.args.p_rows as Array<Record<string, unknown>> : [];
    expect(submittedRows).toHaveLength(1);
    // Natural-key resolution now happens inside the RPC — the resolved id
    // shows up in its return value, not the submitted args, when the call
    // went through persist_with_natural_key_lock.
    const resultRows = persistedCall?.fn === 'persist_with_natural_key_lock'
      ? ((persistedCall?.result as { rows?: Array<Record<string, unknown>> } | undefined)?.rows ?? [])
      : submittedRows;
    expect(resultRows[0]?.id).toBe(expectedId);
  });

  it.each([
    ['estimates', 'estimate_id', 'EST-1'],
    ['orders', 'salesorder_id', 'SO-1'],
    ['invoices', 'invoice_id', 'INV-1'],
  ] as const)('omits place_of_supply when Zoho payload has no POS fields for %s', async (entityType, idField, externalId) => {
    const admin = createAdminStub();

    await persistZohoEntityPage(
      admin.client as never,
      'tenant-1',
      'user-1',
      'integration-1',
      entityType,
      'zoho_books',
      [
        {
          [idField]: externalId,
          date: '2026-06-25',
          total: 1500,
          status: 'open',
          line_items: [],
        },
      ],
    );

    const persistCall = admin.rpcCalls.find((call) => (
      (call.fn === 'bulk_persist_jsonb_records' || call.fn === 'persist_with_natural_key_lock') && call.args.p_table === entityType
    ));

    expect(persistCall).toBeTruthy();
    expect((persistCall?.args.p_rows as Array<Record<string, unknown>>)[0]?.place_of_supply).toBeUndefined();
  });

  it('dedupes repeated product and inventory rows within the same sync page', async () => {
    const admin = createAdminStub({
      tableRows: {
        warehouses: [
          {
            tenant_id: 'tenant-1',
            external_ref: 'LOC-1',
            id: 'warehouse-1',
            deleted_at: null,
          },
        ],
      },
    });

    await persistZohoEntityPage(
      admin.client as never,
      'tenant-1',
      'user-1',
      'integration-1',
      'products',
      'zoho_books',
      [
        {
          item_id: 'ITEM-1',
          name: 'Switch',
          brand: 'Acme',
          category_id: 'CAT-1',
          category_name: 'Switches',
          item_locations: [
            { location_id: 'LOC-1', quantity: 4 },
            { location_id: 'LOC-1', quantity: 4 },
          ],
        },
        {
          item_id: 'ITEM-1',
          name: 'Switch Updated',
          brand: 'Acme',
          category_id: 'CAT-1',
          category_name: 'Switches',
          item_locations: [
            { location_id: 'LOC-1', quantity: 7 },
          ],
        },
      ],
    );

    const brandsCall = admin.rpcCalls.find((call) => (
      (call.fn === 'bulk_persist_jsonb_records' || call.fn === 'persist_with_natural_key_lock') && call.args.p_table === 'tenant_brands'
    ));
    const productsCall = admin.rpcCalls.find((call) => (
      (call.fn === 'bulk_persist_jsonb_records' || call.fn === 'persist_with_natural_key_lock') && call.args.p_table === 'tenant_products'
    ));
    const inventoryCall = admin.rpcCalls.find((call) => (
      (call.fn === 'bulk_persist_jsonb_records' || call.fn === 'persist_with_natural_key_lock') && call.args.p_table === 'tenant_inventory'
    ));

    expect(brandsCall?.args.p_rows as unknown[]).toHaveLength(2);
    expect(productsCall?.args.p_rows as unknown[]).toHaveLength(1);
    expect(inventoryCall?.args.p_rows as unknown[]).toHaveLength(1);
  });

  it('dedupes repeated pricelist and pricelist item rows within the same sync page', async () => {
    const admin = createAdminStub({
      tableRows: {
        tenant_products: [
          {
            tenant_id: 'tenant-1',
            external_ref: 'ITEM-1',
            id: 'product-1',
            deleted_at: null,
          },
        ],
      },
    });

    await persistZohoEntityPage(
      admin.client as never,
      'tenant-1',
      'user-1',
      'integration-1',
      'pricelists',
      'zoho_books',
      [
        {
          pricebook_id: 'PB-1',
          name: 'Retail',
          pricebook_type: 'sales',
          pricebook_items: [
            { item_id: 'ITEM-1', min_quantity: 1, price: 100 },
            { item_id: 'ITEM-1', min_quantity: 1, price: 100 },
          ],
        },
        {
          pricebook_id: 'PB-1',
          name: 'Retail Updated',
          pricebook_type: 'sales',
          pricebook_items: [
            { item_id: 'ITEM-1', min_quantity: 1, price: 105 },
          ],
        },
      ],
    );

    const priceListsCall = admin.rpcCalls.find((call) => (
      (call.fn === 'bulk_persist_jsonb_records' || call.fn === 'persist_with_natural_key_lock') && call.args.p_table === 'price_lists'
    ));
    const priceListItemsCall = admin.rpcCalls.find((call) => (
      (call.fn === 'bulk_persist_jsonb_records' || call.fn === 'persist_with_natural_key_lock') && call.args.p_table === 'price_list_items'
    ));

    expect(priceListsCall?.args.p_rows as unknown[]).toHaveLength(1);
    expect(priceListItemsCall?.args.p_rows as unknown[]).toHaveLength(1);
  });

  it.each([
    ['estimates', 'estimate_id', 'EST-1', 'estimate_items'],
    ['orders', 'salesorder_id', 'SO-1', 'order_items'],
    ['invoices', 'invoice_id', 'INV-1', 'invoice_items'],
  ] as const)('persists %s line items when product mappings resolve', async (entityType, idField, externalId, childTable) => {
    const admin = createAdminStub({
      tableRows: {
        tenant_products: [
          {
            tenant_id: 'tenant-1',
            external_ref: 'ITEM-1',
            id: 'product-1',
            deleted_at: null,
          },
        ],
      },
    });

    await persistZohoEntityPage(
      admin.client as never,
      'tenant-1',
      'user-1',
      'integration-1',
      entityType,
      'zoho_books',
      [
        {
          [idField]: externalId,
          customer_id: 'CUST-1',
          status: 'sent',
          total: 100,
          line_items: [
            {
              item_id: 'ITEM-1',
              quantity: 1,
              rate: 100,
              item_total: 100,
            },
          ],
        },
      ],
    );

    const childCall = admin.rpcCalls.find((call) => (
      (call.fn === 'bulk_persist_jsonb_records' || call.fn === 'persist_with_natural_key_lock') && call.args.p_table === childTable
    ));

    expect(Array.isArray(childCall?.args.p_rows)).toBe(true);
    expect(childCall?.args.p_rows as unknown[]).toHaveLength(1);
  });

  it('fails fast and records an error reason when a transactional line item cannot resolve a product', async () => {
    const admin = createAdminStub();

    await expect(
      persistZohoEntityPage(
        admin.client as never,
        'tenant-1',
        'user-1',
        'integration-1',
        'orders',
        'zoho_books',
        [
          {
            salesorder_id: 'SO-1',
            customer_id: 'CUST-1',
            status: 'open',
            total: 100,
            line_items: [
              {
                item_id: 'ITEM-404',
                quantity: 1,
                rate: 100,
                item_total: 100,
              },
            ],
          },
        ],
      ),
    ).rejects.toThrow('Unable to resolve product ITEM-404 for order SO-1.');

    const errorMapCall = admin.rpcCalls
      .filter((call) => (call.fn === 'bulk_persist_jsonb_records' || call.fn === 'persist_with_natural_key_lock') && call.args.p_table === 'integration_entity_map')
      .at(-1);

    expect(errorMapCall).toBeTruthy();
    expect(Array.isArray(errorMapCall?.args.p_rows)).toBe(true);
    expect((errorMapCall?.args.p_rows as Array<Record<string, unknown>>)[0]).toMatchObject({
      sync_status: 'error',
    });
    expect(String((errorMapCall?.args.p_rows as Array<Record<string, unknown>>)[0]?.error_reason ?? '')).toContain(
      'Unable to resolve product ITEM-404 for order SO-1.',
    );
  });

  it.each([
    {
      label: 'YES string',
      customFieldValue: 'YES',
      expected: true,
    },
    {
      label: 'NO string',
      customFieldValue: 'NO',
      expected: false,
    },
    {
      label: 'native boolean true',
      customFieldValue: true,
      expected: true,
    },
    {
      label: 'missing custom field',
      customFieldValue: undefined,
      expected: false,
    },
  ])('maps cf_online_catalogue_access to buyer_app_enabled ($label)', async ({ customFieldValue, expected }) => {
    const admin = createAdminStub({
      fieldMappings: [
        {
          tenant_integration_id: 'integration-1',
          entity_type: 'customers',
          is_active: true,
          zoho_field_name: 'cf_online_catalogue_access',
          target_column: 'buyer_app_enabled',
          transform_type: 'boolean_from_zoho',
        },
      ],
    });

    const customFields = customFieldValue === undefined
      ? []
      : [{ api_name: 'cf_online_catalogue_access', value: customFieldValue }];

    await persistZohoEntityPage(
      admin.client as never,
      'tenant-1',
      'user-1',
      'integration-1',
      'customers',
      'zoho_books',
      [
        {
          contact_id: 'CUST-2',
          company_name: 'Beta Retail',
          custom_fields: customFields,
          contact_persons: [],
        },
      ],
    );

    const buyersCall = admin.rpcCalls.find((call) => (
      (call.fn === 'bulk_persist_jsonb_records' || call.fn === 'persist_with_natural_key_lock') && call.args.p_table === 'buyers'
    ));
    const buyerRow = (buyersCall?.args.p_rows as Array<Record<string, unknown>>)[0];
    expect(buyerRow?.buyer_app_enabled).toBe(expected);
    if (customFieldValue !== undefined) {
      expect((buyerRow?.custom_fields as Record<string, unknown>)?.cf_online_catalogue_access).toEqual(customFieldValue);
    }
  });

  it.each([
    {
      entityType: 'estimates' as const,
      idField: 'estimate_id',
      numberField: 'estimate_number',
      mappingField: 'cf_catalog_estimate',
      targetColumn: 'is_buyer_app_estimate',
      customFieldValue: true,
      expected: true,
    },
    {
      entityType: 'invoices' as const,
      idField: 'invoice_id',
      numberField: 'invoice_number',
      mappingField: 'cf_catalog_invoice',
      targetColumn: 'is_buyer_app_invoice',
      customFieldValue: undefined,
      expected: false,
    },
  ])('maps boolean custom fields for $entityType ($targetColumn)', async ({
    entityType,
    idField,
    numberField,
    mappingField,
    targetColumn,
    customFieldValue,
    expected,
  }) => {
    const admin = createAdminStub({
      fieldMappings: [
        {
          tenant_integration_id: 'integration-1',
          entity_type: entityType,
          is_active: true,
          zoho_field_name: mappingField,
          target_column: targetColumn,
          transform_type: 'boolean_from_zoho',
        },
      ],
    });

    const customFields = customFieldValue === undefined
      ? []
      : [{ api_name: mappingField, value: customFieldValue }];

    await persistZohoEntityPage(
      admin.client as never,
      'tenant-1',
      'user-1',
      'integration-1',
      entityType,
      'zoho_books',
      [
        {
          [idField]: `${entityType.toUpperCase()}-CF`,
          [numberField]: `${entityType.toUpperCase()}-CF-1`,
          status: 'draft',
          date: '2026-06-25',
          custom_fields: customFields,
          line_items: [],
        },
      ],
    );

    const persistCall = admin.rpcCalls.find((call) => (
      (call.fn === 'bulk_persist_jsonb_records' || call.fn === 'persist_with_natural_key_lock') && call.args.p_table === entityType
    ));
    const row = (persistCall?.args.p_rows as Array<Record<string, unknown>>)[0];
    expect(row?.[targetColumn]).toBe(expected);
  });

  it.each([
    {
      label: 'numeric pricebook_id',
      contact: {
        contact_id: 'CUST-NUM-PB',
        company_name: 'Numeric Pricebook Buyer',
        pricebook_id: 12345,
        contact_persons: [],
      },
      priceListExternalRef: '12345',
    },
    {
      label: 'nested pricebook object',
      contact: {
        contact_id: 'CUST-NESTED-PB',
        company_name: 'Nested Pricebook Buyer',
        pricebook: { pricebook_id: 'PB-NESTED' },
        contact_persons: [],
      },
      priceListExternalRef: 'PB-NESTED',
    },
  ])('creates price list assignments from contact list payload ($label)', async ({ contact, priceListExternalRef }) => {
    const admin = createAdminStub({
      tableRows: {
        price_lists: [
          {
            tenant_id: 'tenant-1',
            external_ref: priceListExternalRef,
            id: 'price-list-target',
            deleted_at: null,
          },
        ],
      },
    });

    await persistZohoEntityPage(
      admin.client as never,
      'tenant-1',
      'user-1',
      'integration-1',
      'customers',
      'zoho_books',
      [contact],
    );

    const assignmentsCall = admin.rpcCalls.find((call) => (
      (call.fn === 'bulk_persist_jsonb_records' || call.fn === 'persist_with_natural_key_lock') && call.args.p_table === 'price_list_assignments'
    ));
    expect(assignmentsCall).toBeTruthy();
    expect((assignmentsCall?.args.p_rows as Array<Record<string, unknown>>)[0]?.price_list_id).toBe('price-list-target');
  });

  it('upserts price list assignments before soft-deleting stale rows', async () => {
    const admin = createAdminStub({
      tableRows: {
        price_lists: [
          {
            tenant_id: 'tenant-1',
            external_ref: 'PB-1',
            id: 'price-list-1',
            deleted_at: null,
          },
        ],
      },
    });

    await persistZohoEntityPage(
      admin.client as never,
      'tenant-1',
      'user-1',
      'integration-1',
      'customers',
      'zoho_books',
      [
        {
          contact_id: 'CUST-ORDER',
          company_name: 'Ordering Buyer',
          pricebook_id: 'PB-1',
          contact_persons: [],
        },
      ],
    );

    const assignmentRpcIndex = admin.operationLog.findIndex((entry) => entry === 'rpc:price_list_assignments');
    const assignmentUpdateIndex = admin.operationLog.findIndex((entry) => entry === 'update:price_list_assignments');
    expect(assignmentRpcIndex).toBeGreaterThanOrEqual(0);
    expect(assignmentUpdateIndex).toBeGreaterThan(assignmentRpcIndex);
  });

  it('writes source_payload to R2 for customer and product entity map upserts', async () => {
    const admin = createAdminStub({
      tableRows: {
        tenant_brands: [
          {
            id: 'brand-1',
            tenant_id: 'tenant-1',
            external_ref: 'zoho_brand:acme',
            display_name_override: 'Acme',
            slug: 'acme',
            deleted_at: null,
          },
        ],
      },
    });

    await persistZohoEntityPage(
      admin.client as never,
      'tenant-1',
      'user-1',
      'integration-1',
      'customers',
      'zoho_books',
      [
        {
          contact_id: 'CUST-MAP',
          company_name: 'Map Buyer',
          contact_persons: [],
        },
      ],
    );

    const customerMapRow = getEntityMapRows(admin, 'customers')[0];
    expect(customerMapRow?.source_payload).toBeUndefined();
    expect(putObjectJsonMock).toHaveBeenCalledWith(
      expect.stringMatching(/^integrations\/tenant-1\/entity-map\/.+\.json$/),
      expect.objectContaining({ contact_id: 'CUST-MAP', company_name: 'Map Buyer' }),
    );

    await persistZohoEntityPage(
      admin.client as never,
      'tenant-1',
      'user-1',
      'integration-1',
      'products',
      'zoho_books',
      [
        {
          item_id: 'ITEM-MAP',
          name: 'Mapped Product',
          brand: 'Acme',
          sku: 'ITEM-MAP',
        },
      ],
    );

    const productMapRow = getEntityMapRows(admin, 'products').find((row) => row.external_id === 'ITEM-MAP');
    expect(productMapRow?.source_payload).toBeUndefined();
    expect(putObjectJsonMock).toHaveBeenCalledWith(
      expect.stringMatching(/^integrations\/tenant-1\/entity-map\/.+\.json$/),
      expect.objectContaining({ item_id: 'ITEM-MAP', name: 'Mapped Product' }),
    );
  });

  it('writes source_payload to R2 for location entity map upserts', async () => {
    const admin = createAdminStub();

    await persistZohoEntityPage(
      admin.client as never,
      'tenant-1',
      'user-1',
      'integration-1',
      'locations',
      'zoho_books',
      [
        {
          location_id: 'LOC-MAP',
          location_name: 'Main Warehouse',
          status: 'active',
        },
      ],
    );

    const locationPersistCall = admin.rpcCalls.find((call) => (
      call.fn === 'bulk_persist_jsonb_records' && call.args.p_table === 'locations'
    ));
    const persistedRows = locationPersistCall?.args.p_rows as Array<Record<string, unknown>> | undefined;
    expect(persistedRows?.[0]?.status).toBe('active');

    const locationMapRow = getEntityMapRows(admin, 'locations')[0];
    expect(locationMapRow?.source_payload).toBeUndefined();
    expect(putObjectJsonMock).toHaveBeenCalledWith(
      expect.stringMatching(/^integrations\/tenant-1\/entity-map\/.+\.json$/),
      expect.objectContaining({ location_id: 'LOC-MAP', location_name: 'Main Warehouse' }),
    );
  });

  it('persists Zoho location status inactive when payload says inactive', async () => {
    const admin = createAdminStub();

    await persistZohoEntityPage(
      admin.client as never,
      'tenant-1',
      'user-1',
      'integration-1',
      'locations',
      'zoho_books',
      [
        {
          location_id: 'LOC-OFF',
          location_name: 'Closed Branch',
          status: 'inactive',
        },
      ],
    );

    const locationPersistCall = admin.rpcCalls.find((call) => (
      call.fn === 'bulk_persist_jsonb_records' && call.args.p_table === 'locations'
    ));
    const persistedRows = locationPersistCall?.args.p_rows as Array<Record<string, unknown>> | undefined;
    expect(persistedRows?.[0]?.status).toBe('inactive');
  });

  it('does not soft-delete price list assignments when contact has no pricebook', async () => {
    const admin = createAdminStub();

    await persistZohoEntityPage(
      admin.client as never,
      'tenant-1',
      'user-1',
      'integration-1',
      'customers',
      'zoho_books',
      [
        {
          contact_id: 'CUST-3',
          company_name: 'No Pricebook Buyer',
          contact_persons: [],
        },
      ],
    );

    expect(admin.updateCalls.filter((call) => call.table === 'price_list_assignments')).toHaveLength(0);
    const assignmentsCall = admin.rpcCalls.find((call) => (
      (call.fn === 'bulk_persist_jsonb_records' || call.fn === 'persist_with_natural_key_lock') && call.args.p_table === 'price_list_assignments'
    ));
    expect(assignmentsCall).toBeUndefined();
  });

  it('hydrates contact persons when list payload omits them', async () => {
    const admin = createAdminStub();
    let fetchContactPersonsCalled = false;
    const adapter = {
      fetchContactById: async () => ({
        contact_id: 'CUST-4',
        company_name: 'Gamma Retail',
        contact_persons: [
          {
            contact_person_id: 'CP-2',
            first_name: 'Ravi',
            last_name: 'Kumar',
            email: 'ravi@example.com',
          },
        ],
      }),
      fetchContactPersons: async () => {
        fetchContactPersonsCalled = true;
        return [];
      },
      fetchUsers: async () => [],
    };

    await persistZohoEntityPage(
      admin.client as never,
      'tenant-1',
      'user-1',
      'integration-1',
      'customers',
      'zoho_books',
      [
        {
          contact_id: 'CUST-4',
          company_name: 'Gamma Retail',
        },
      ],
      adapter as never,
    );

    expect(fetchContactPersonsCalled).toBe(false);
    const buyerUsersCall = admin.rpcCalls.find((call) => (
      (call.fn === 'bulk_persist_jsonb_records' || call.fn === 'persist_with_natural_key_lock') && call.args.p_table === 'buyer_users'
    ));
    const buyerUserRow = (buyerUsersCall?.args.p_rows as Array<Record<string, unknown>>)[0];
    expect(buyerUserRow?.first_name).toBe('Ravi');
    expect(buyerUserRow?.last_name).toBe('Kumar');
  });

  it('skips contact enrichment on full_sync list_only policy', async () => {
    const admin = createAdminStub();
    let fetchContactByIdCalled = false;
    const adapter = {
      fetchContactById: async () => {
        fetchContactByIdCalled = true;
        return null;
      },
      fetchUsers: async () => [],
    };

    await persistZohoEntityPage(
      admin.client as never,
      'tenant-1',
      'user-1',
      'integration-1',
      'customers',
      'zoho_books',
      [
        {
          contact_id: 'CUST-5',
          company_name: 'List Only Buyer',
        },
      ],
      adapter as never,
      { enrichmentPolicy: 'full_sync', customerEnrichmentMode: 'list_only' },
    );

    expect(fetchContactByIdCalled).toBe(false);
  });

  it('omits attributes_override when updating an existing product', async () => {
    const admin = createAdminStub({
      tableRows: {
        tenant_products: [
          {
            id: 'product-existing',
            tenant_id: 'tenant-1',
            external_ref: 'ITEM-9',
            internal_sku: 'ITEM-9',
            deleted_at: null,
            attributes_override: { colour: 'red' },
          },
        ],
        tenant_brands: [
          {
            id: 'brand-1',
            tenant_id: 'tenant-1',
            external_ref: 'zoho_brand:acme',
            display_name_override: 'Acme',
            slug: 'acme',
            deleted_at: null,
          },
        ],
      },
    });

    await persistZohoEntityPage(
      admin.client as never,
      'tenant-1',
      'user-1',
      'integration-1',
      'products',
      'zoho_books',
      [
        {
          item_id: 'ITEM-9',
          name: 'Updated Switch',
          brand: 'Acme',
          sku: 'ITEM-9',
        },
      ],
    );

    const productsCall = admin.rpcCalls.find((call) => (
      (call.fn === 'bulk_persist_jsonb_records' || call.fn === 'persist_with_natural_key_lock') && call.args.p_table === 'tenant_products'
    ));
    // attributes_override omission is decided in JS before the RPC call, so
    // it's still visible on the submitted args; the resolved id only shows
    // up in the RPC's return value now.
    const submittedRow = (productsCall?.args.p_rows as Array<Record<string, unknown>>)[0];
    expect(submittedRow?.attributes_override).toBeUndefined();
    const resultRow = productsCall?.fn === 'persist_with_natural_key_lock'
      ? ((productsCall?.result as { rows?: Array<Record<string, unknown>> } | undefined)?.rows ?? [])[0]
      : submittedRow;
    expect(resultRow?.id).toBe('product-existing');
  });

  it('persists estimate_url, financials, and buyer-app flag from detail payload', async () => {
    const admin = createAdminStub({
      fieldMappings: [
        {
          tenant_integration_id: 'integration-1',
          entity_type: 'estimates',
          is_active: true,
          zoho_field_name: 'cf_catalog_estimate',
          target_column: 'is_buyer_app_estimate',
          transform_type: 'boolean_from_zoho',
        },
      ],
    });

    await persistZohoEntityPage(
      admin.client as never,
      'tenant-1',
      'user-actor',
      'integration-1',
      'estimates',
      'zoho_books',
      [
        {
          estimate_id: 'EST-DETAIL',
          estimate_number: 'EST-2026-0099',
          status: 'sent',
          date: '2026-06-25',
          sub_total: 1000,
          tax_total: 180,
          place_of_supply: 'Maharashtra',
          estimate_url: 'https://books.zoho.in/portal/estimate/EST-DETAIL',
          custom_fields: [
            { api_name: 'cf_catalog_estimate', value: 'yes' },
          ],
          line_items: [],
        },
      ],
    );

    const persistCall = admin.rpcCalls.find((call) => (
      (call.fn === 'bulk_persist_jsonb_records' || call.fn === 'persist_with_natural_key_lock') && call.args.p_table === 'estimates'
    ));
    const row = (persistCall?.args.p_rows as Array<Record<string, unknown>>)[0];
    expect(row?.estimate_url).toBe('https://books.zoho.in/portal/estimate/EST-DETAIL');
    expect(row?.subtotal).toBe(1000);
    expect(row?.tax_amount).toBe(180);
    expect(row?.place_of_supply).toBe('Maharashtra');
    expect(row?.is_buyer_app_estimate).toBe(true);
    expect(row?.created_by).toBe('user-actor');
  });

  it('preserves an existing estimate buyer-app source and flag during Zoho upserts', async () => {
    const admin = createAdminStub({
      tableRows: {
        estimates: [
          {
            id: 'estimate-existing',
            tenant_id: 'tenant-1',
            external_ref: 'EST-DETAIL',
            estimate_number: 'EST-2026-0099',
            source: 'buyer_app',
            is_buyer_app_estimate: true,
            deleted_at: null,
          },
        ],
      },
      fieldMappings: [
        {
          tenant_integration_id: 'integration-1',
          entity_type: 'estimates',
          is_active: true,
          zoho_field_name: 'cf_catalog_estimate',
          target_column: 'is_buyer_app_estimate',
          transform_type: 'boolean_from_zoho',
        },
      ],
    });

    await persistZohoEntityPage(
      admin.client as never,
      'tenant-1',
      'user-actor',
      'integration-1',
      'estimates',
      'zoho_books',
      [
        {
          estimate_id: 'EST-DETAIL',
          estimate_number: 'EST-2026-0099',
          status: 'sent',
          custom_fields: [],
          line_items: [],
        },
      ],
    );

    const persistCall = admin.rpcCalls.find((call) => (
      call.fn === 'persist_with_natural_key_lock' && call.args.p_table === 'estimates'
    ));
    const row = (persistCall?.args.p_rows as Array<Record<string, unknown>>)[0];
    expect(row?.source).toBe('buyer_app');
    expect(row?.is_buyer_app_estimate).toBe(true);
  });

  it('applies order buyer-app field mappings and preserves existing source/flag during Zoho upserts', async () => {
    const admin = createAdminStub({
      tableRows: {
        orders: [
          {
            id: 'order-existing',
            tenant_id: 'tenant-1',
            external_ref: 'SO-DETAIL',
            order_number: 'SO-2026-0009',
            source: 'buyer_app',
            is_buyer_app_order: true,
            deleted_at: null,
          },
        ],
      },
      fieldMappings: [
        {
          tenant_integration_id: 'integration-1',
          entity_type: 'orders',
          is_active: true,
          zoho_field_name: 'cf_catalog_order',
          target_column: 'is_buyer_app_order',
          transform_type: 'boolean_from_zoho',
        },
      ],
    });

    await persistZohoEntityPage(
      admin.client as never,
      'tenant-1',
      'user-actor',
      'integration-1',
      'orders',
      'zoho_books',
      [
        {
          salesorder_id: 'SO-DETAIL',
          salesorder_number: 'SO-2026-0009',
          status: 'open',
          custom_fields: [],
          line_items: [],
        },
      ],
    );

    const persistCall = admin.rpcCalls.find((call) => (
      call.fn === 'persist_with_natural_key_lock' && call.args.p_table === 'orders'
    ));
    const row = (persistCall?.args.p_rows as Array<Record<string, unknown>>)[0];
    expect(row?.source).toBe('buyer_app');
    expect(row?.is_buyer_app_order).toBe(true);
  });

  it('resolves salesperson_id to a tenant user for transactional imports', async () => {
    const admin = createAdminStub({
      tenantUsers: [{ user_id: 'seller-user-1', tenant_id: 'tenant-1', is_active: true }],
      authUsers: [{ id: 'seller-user-1', email: 'seller@example.com' }],
    });
    const adapter = {
      fetchUsers: async () => ([
        { user_id: 'ZOHO-SP-1', email: 'seller@example.com' },
      ]),
    };

    await persistZohoEntityPage(
      admin.client as never,
      'tenant-1',
      'connected-user',
      'integration-1',
      'orders',
      'zoho_books',
      [
        {
          salesorder_id: 'SO-SP',
          salesorder_number: 'SO-SP-1',
          status: 'open',
          date: '2026-06-25',
          salesperson_id: 'ZOHO-SP-1',
          line_items: [],
        },
      ],
      adapter as never,
    );

    const persistCall = admin.rpcCalls.find((call) => (
      (call.fn === 'bulk_persist_jsonb_records' || call.fn === 'persist_with_natural_key_lock') && call.args.p_table === 'orders'
    ));
    const row = (persistCall?.args.p_rows as Array<Record<string, unknown>>)[0];
    expect(row?.created_by).toBe('seller-user-1');
    expect(row?.updated_by).toBe('seller-user-1');
  });
});
