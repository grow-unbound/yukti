'use client';

import { FileText, Loader2, Send, Trash2, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { FeatureDisabledState } from '@/components/FeatureGate';
import { PermissionDenied } from '@/components/auth/PermissionDenied';
import {
  DocumentBasicsStrip,
  DocumentComposerFooterRow,
} from '@/components/seller/composer/DocumentBasicsStrip';
import { DocumentComposerShell } from '@/components/seller/composer/DocumentComposerShell';
import { DocumentComposerLoadingSkeleton as SharedDocumentComposerLoadingSkeleton } from '@/components/seller/loading/SellerLoadingSkeletons';
import {
  BuyerCardEmpty,
  BuyerCardLoading,
  DocumentCustomerStrip,
  LinesTable,
  TotalsCard,
  type EstimateComposerLineRow,
} from '@/components/seller/document-composer';
import { FEATURE_FLAGS } from '@/constants';
import { useAuth } from '@/contexts/AuthContext';
import { useFlagState } from '@/hooks/useFeatureFlag';
import { useTenantSettings } from '@/hooks/useTenantSettings';
import { useTenantLocations } from '@/hooks/useTenantLocations';
import { composerSubmitFooterLabel, useComposerLeaveGuard } from '@/hooks/useComposerLeaveGuard';
import { useDocumentBuyerPicker } from '@/hooks/useDocumentBuyerPicker';
import {
  useBuyerDocumentSendState,
  useBuyerEstimateContext,
  useEstimateComposer,
  useEstimatePriceListOptions,
  useNextEstimateNumber,
  useEstimateProductPricing,
  useEstimateProductSearch,
  useSaveEstimateComposer,
} from '@/hooks/useEstimates';
import { SendDocumentWhatsAppDialog } from '@/components/seller/shared/SendDocumentWhatsAppDialog';
import { Button } from '@/components/ui/button';
import { DiscardChangesDialog, useDirtyCloseGuard } from '@/components/ui/form-overlay';
import { apiPatch, apiPost } from '@/lib/api-fetch';
import { clearComposerDraft, loadComposerDraft, saveComposerDraft } from '@/lib/composer-session-draft';
import type { 
  EstimateComposerBuyerContext,
  EstimateComposerDocument,
  EstimateComposerProductSearchRow,
  EstimateComposerSavePayload,
} from '@/types/estimate-composer';
import type { WhatsAppDocumentSendState } from '@/types/whatsapp-document-send';
import { bumpSecondDateAfterFirst } from '@/lib/date-utils';
import { SELLER_ROUTES } from '@/lib/seller-routes';
import {
  buildComposerStagedChanges,
  stagedSliceFromEstimate,
} from '@/lib/documents/composer-staged-changes';
import {
  computeTotals,
  defaultPaymentTerms,
} from '@/lib/documents/composer-math';
import { computeLineTaxableAmount } from '@/lib/gst';
import { isoDateInTimeZone, offsetIsoDateInTimeZone } from '@/lib/date-utils';
import { formatNumberValue } from '@/lib/utils';

const BASE_PRICING_OPTION = '__base__';

const WHATSAPP_SEND_UNAVAILABLE: WhatsAppDocumentSendState = {
  can_send: false,
  block_reason: 'unavailable',
  block_message: null,
  credits_balance: 0,
  required_credits: 1,
  recipient_phone: null,
  template_name: 'request_update_buyer',
  seller_name: null,
  seller_phone_display: null,
};

function buildNewEstimateDraft(estimateNumber = 'Estimating next number...'): EstimateComposerDocument {
  return {
    id: '',
    estimate_number: estimateNumber,
    status: 'draft',
    buyer_id: null,
    location_id: null,
    location_name: null,
    available_locations: [],
    estimate_date: isoDateInTimeZone(new Date()),
    valid_until: offsetIsoDateInTimeZone(new Date(), 14),
    buyer_po_ref: '',
    place_of_supply: '',
    seller_note: '',
    freight: 0,
    discount_flat: 0,
    round_off: 0,
    sent_at: null,
    sent_channel: null,
    items: [],
    buyer_context: null,
    estimate_version: 1,
    viewed_at: null,
    viewed_by_name: null,
    voided_at: null,
    converted_to_order_id: null,
    linked_order_number: null,
    is_buyer_app: false,
  };
}

function snapshotPayload(document: EstimateComposerDocument, lines: EstimateComposerLineRow[]) {
  return JSON.stringify({
    estimate_number: document.estimate_number,
    buyer_id: document.buyer_id,
    location_id: document.location_id,
    estimate_date: document.estimate_date,
    valid_until: document.valid_until,
    buyer_po_ref: document.buyer_po_ref,
    place_of_supply: document.place_of_supply,
    seller_note: document.seller_note,
    freight: document.freight,
    discount_flat: document.discount_flat,
    round_off: document.round_off,
    items: lines.map((line) => ({
      id: line.id,
      tenant_product_id: line.tenant_product_id,
      qty: line.qty,
      unit_price: line.unit_price,
      disc_pct: line.disc_pct,
      tax_pct: line.tax_pct,
      diff: line.diff,
    })),
  });
}

function mapDiffLines(current: EstimateComposerLineRow[], original: EstimateComposerLineRow[]) {
  const originalByKey = new Map(original.map((line) => [line.id, line]));
  return current.map((line) => {
    const originalLine = originalByKey.get(line.id);
    if (!originalLine) return { ...line, diff: 'added' as const };
    if (
      originalLine.qty !== line.qty
      || originalLine.unit_price !== line.unit_price
      || originalLine.disc_pct !== line.disc_pct
      || originalLine.tax_pct !== line.tax_pct
      || line.diff === 'removed'
    ) {
      return { ...line, diff: line.diff === 'removed' ? 'removed' as const : 'changed' as const };
    }
    return { ...line, diff: 'clean' as const };
  });
}

function toSavePayload(document: EstimateComposerDocument, lines: EstimateComposerLineRow[]): EstimateComposerSavePayload {
  return {
    estimate_number: document.estimate_number,
    buyer_id: document.buyer_id,
    location_id: document.location_id,
    estimate_date: document.estimate_date,
    valid_until: document.valid_until,
    buyer_po_ref: document.buyer_po_ref,
    place_of_supply: document.place_of_supply,
    seller_note: document.seller_note,
    freight: document.freight,
    discount_flat: document.discount_flat,
    round_off: document.round_off,
    items: lines
      .filter((line) => line.diff !== 'removed')
      .map((line) => ({
        id: line.id.startsWith('draft-line-') ? undefined : line.id,
        tenant_product_id: line.tenant_product_id,
        qty: line.qty,
        unit_price: line.unit_price,
        disc_pct: line.disc_pct,
        tax_pct: line.tax_pct,
        scheme_tag: line.scheme_tag,
      })),
  };
}

export function DocComposerEstimate({
  mode,
  estimateId,
}: {
  mode: 'create' | 'edit';
  estimateId?: string;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const { isLeavingRef, beginLeaving, resetLeaving, shouldBlockComposer, isSubmitting, submitAction } = useComposerLeaveGuard();
  const { user } = useAuth();
  const orderManagement = useFlagState('ORDER_MANAGEMENT');
  const estimatesFlag = useFlagState('ESTIMATES');
  const { data: tenantSettings } = useTenantSettings();
  const tenantLocationsQuery = useTenantLocations();
  const gstInclusive = tenantSettings?.unified.business_policy.gst_inclusive ?? false;

  const [workingId, setWorkingId] = useState<string | null>(estimateId ?? null);
  const { data, isLoading, isError, error } = useEstimateComposer(workingId);
  const nextEstimateNumberQuery = useNextEstimateNumber(mode === 'create' && !estimateId);

  const [documentState, setDocumentState] = useState<EstimateComposerDocument | null>(() => {
    if (mode !== 'create' || estimateId) return null;
    return loadComposerDraft<EstimateComposerDocument, EstimateComposerLineRow>('estimate')?.document
      ?? buildNewEstimateDraft();
  });
  const [lineState, setLineState] = useState<EstimateComposerLineRow[]>(() => {
    if (mode !== 'create' || estimateId) return [];
    return loadComposerDraft<EstimateComposerDocument, EstimateComposerLineRow>('estimate')?.lines ?? [];
  });
  const [buyerQuery, setBuyerQuery] = useState('');
  const [buyerSearchOpen, setBuyerSearchOpen] = useState(false);
  const [productQuery, setProductQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [paymentTermsLabel, setPaymentTermsLabel] = useState('Not defined');
  const [sendOpen, setSendOpen] = useState(false);
  const [autoSaveMeta, setAutoSaveMeta] = useState<{ label: string; tone: 'draft' | 'saved' | 'warning' }>({
    label: mode === 'create' ? 'Not saved yet' : 'Ready to save',
    tone: 'draft',
  });
  const [selectedPriceListId, setSelectedPriceListId] = useState<string | null>(null);
  const [autoFocusLineId, setAutoFocusLineId] = useState<string | null>(null);

  const originalDocumentRef = useRef<EstimateComposerDocument | null>(null);
  const originalLinesRef = useRef<EstimateComposerLineRow[]>([]);
  const initializedForIdRef = useRef<string | null>(null);
  const lastAppliedPricingKeyRef = useRef<string | null>(null);
  const salesAgentPinnedRef = useRef<string | null>(null);

  const saveMutation = useSaveEstimateComposer(workingId);
  const buyerContextQuery = useBuyerEstimateContext(documentState?.buyer_id ?? null);
  const composerBuyerMatches = data?.buyer_id === documentState?.buyer_id;
  const buyerSendStateQuery = useBuyerDocumentSendState(documentState?.buyer_id ?? null, 'estimate', {
    enabled: Boolean(documentState?.buyer_id) && (!composerBuyerMatches || !data?.whatsapp_send),
  });
  const productSearchQuery = useEstimateProductSearch(productQuery, documentState?.buyer_id ?? null, searchOpen, selectedPriceListId);
  const buyerPickerQuery = useDocumentBuyerPicker(buyerQuery, buyerSearchOpen);
  const priceListOptionsQuery = useEstimatePriceListOptions(Boolean(documentState));
  const pricingQuery = useEstimateProductPricing(
    documentState?.buyer_id ?? null,
    lineState.filter((line) => line.diff !== 'removed').map((line) => line.tenant_product_id),
    selectedPriceListId,
  );
  const closeTarget = mode === 'edit' && estimateId ? `${SELLER_ROUTES.sales.estimates}/${estimateId}` : SELLER_ROUTES.sales.estimates;

  const prevEditEstimateIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (mode !== 'edit' || !estimateId) return;
    if (prevEditEstimateIdRef.current === estimateId) return;
    prevEditEstimateIdRef.current = estimateId;
    setWorkingId(estimateId);
    initializedForIdRef.current = null;
    originalDocumentRef.current = null;
    originalLinesRef.current = [];
    setDocumentState(null);
    setLineState([]);
    setBuyerQuery('');
    setBuyerSearchOpen(false);
    setProductQuery('');
    setSearchOpen(false);
    setAutoSaveMeta({ label: 'Ready to save', tone: 'draft' });
  }, [mode, estimateId]);

  useEffect(() => {
    if (mode !== 'create' || estimateId || !nextEstimateNumberQuery.data) return;
    setDocumentState((current) => current ? { ...current, estimate_number: nextEstimateNumberQuery.data } : current);
  }, [estimateId, mode, nextEstimateNumberQuery.data]);

  useEffect(() => {
    if (!data) return;
    if (initializedForIdRef.current === data.id) return;

    if (mode === 'edit') {
      salesAgentPinnedRef.current = data.buyer_context?.sales_agent_name ?? null;
    }

    setDocumentState(data);
    const mappedLines = (data.items ?? []).map((line) => ({
      ...line,
      diff: 'clean' as const,
      line_total: computeLineTaxableAmount(line),
    }));
    setLineState(mappedLines);
    setPaymentTermsLabel(defaultPaymentTerms(data.buyer_context?.payment_terms_days ?? 0));
    setSelectedPriceListId(data.buyer_context?.active_pricelist?.id ?? null);
    originalDocumentRef.current = data;
    originalLinesRef.current = mappedLines;
    initializedForIdRef.current = data.id;
    setAutoSaveMeta({
      label: mode === 'create' ? 'Saved draft' : 'Saved changes',
      tone: 'saved',
    });
  }, [data, mode]);

  useEffect(() => {
    if (mode !== 'create' || estimateId || originalDocumentRef.current) return;
    if (!documentState) return;

    originalDocumentRef.current = documentState;
    originalLinesRef.current = [];
  }, [documentState, estimateId, mode]);

  useEffect(() => {
    const nextContext = buyerContextQuery.data;
    if (!nextContext || !documentState) return;
    if (documentState.buyer_id !== nextContext.id) return;
    if (
      documentState.buyer_context?.id === nextContext.id
      && documentState.buyer_context?.credit_available === nextContext.credit_available
    ) {
      return;
    }

    setDocumentState((current) => {
      if (!current) return current;
      return {
        ...current,
        // Auto-populate from buyer's state when the field is still blank
        place_of_supply: current.place_of_supply || nextContext.place_of_supply || '',
        buyer_context: {
          ...nextContext,
          sales_agent_name:
            mode === 'edit'
              ? (salesAgentPinnedRef.current ?? nextContext.sales_agent_name)
              : (user?.displayName ?? nextContext.sales_agent_name),
        },
      };
    });
    setPaymentTermsLabel(defaultPaymentTerms(nextContext.payment_terms_days));
    setSelectedPriceListId((current) => current ?? nextContext.active_pricelist?.id ?? null);
  }, [buyerContextQuery.data, documentState, mode, user?.displayName]);

  useEffect(() => {
    if (!pricingQuery.data || lineState.length === 0) return;

    const pricingKey = `${documentState?.buyer_id ?? ''}:${selectedPriceListId ?? BASE_PRICING_OPTION}:${Object.entries(pricingQuery.data)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, price]) => `${id}:${price}`)
      .join('|')}`;

    if (lastAppliedPricingKeyRef.current === pricingKey) return;

    setLineState((current) =>
      current.map((line) => {
        if (line.diff === 'removed') return line;
        const nextPrice = pricingQuery.data[line.tenant_product_id];
        if (nextPrice == null || nextPrice === line.unit_price) return line;
        const next = { ...line, unit_price: nextPrice };
        return { ...next, line_total: computeLineTaxableAmount(next) };
      }),
    );
    lastAppliedPricingKeyRef.current = pricingKey;
  }, [documentState?.buyer_id, lineState.length, pricingQuery.data, selectedPriceListId]);

  const diffLines = useMemo(() => mapDiffLines(lineState, originalLinesRef.current), [lineState]);
  const totals = useMemo(
    () => computeTotals(diffLines, documentState?.discount_flat ?? 0, documentState?.freight ?? 0, documentState?.round_off ?? 0, gstInclusive),
    [diffLines, documentState?.discount_flat, documentState?.freight, documentState?.round_off, gstInclusive],
  );
  const dirty = useMemo(() => {
    if (!documentState) return false;
    return snapshotPayload(documentState, diffLines) !== snapshotPayload(originalDocumentRef.current ?? documentState, originalLinesRef.current);
  }, [diffLines, documentState]);
  const originalTotalsSnapshot = useMemo(
    () => {
      if (!originalDocumentRef.current) return null;
      return computeTotals(
        originalLinesRef.current,
        originalDocumentRef.current.discount_flat,
        originalDocumentRef.current.freight,
        originalDocumentRef.current.round_off,
        gstInclusive,
      );
    },
    [documentState?.id],
  );
  const stagedChangesRows = useMemo(() => {
    if (!documentState) return undefined;
    const orig = originalDocumentRef.current;
    const origTotals = originalTotalsSnapshot;
    if (!orig || !origTotals) return undefined;
    return buildComposerStagedChanges({
      mode,
      dirty,
      originalDoc: stagedSliceFromEstimate(orig),
      currentDoc: stagedSliceFromEstimate(documentState),
      diffLines,
      originalTotals: origTotals,
      currentTotals: totals,
    });
  }, [mode, dirty, documentState, diffLines, totals, originalTotalsSnapshot]);
  const activeProductIds = useMemo(
    () => new Set(diffLines.filter((line) => line.diff !== 'removed').map((line) => line.tenant_product_id)),
    [diffLines],
  );
  const filteredProductSearchResults = useMemo(
    () => (productSearchQuery.data ?? []).filter((row) => !activeProductIds.has(row.tenant_product_id)),
    [productSearchQuery.data, activeProductIds],
  );
  const createModeLocationOptions = useMemo(
    () =>
      (tenantLocationsQuery.data?.locations ?? [])
        .filter((location) => location.deleted_at == null)
        .map((location) => ({
          id: location.id,
          name: location.name,
          is_default: location.is_default,
        })),
    [tenantLocationsQuery.data],
  );
  const availableLocationOptions = mode === 'create'
    ? createModeLocationOptions
    : (documentState?.available_locations ?? []);
  const dirtyGuard = useDirtyCloseGuard({
    isDirty: dirty,
    onConfirmClose: () => { clearComposerDraft('estimate'); router.push(closeTarget); },
  });

  // Persist in-progress draft to sessionStorage while no DB record exists yet.
  // Cleared when the user explicitly saves (which creates the DB record) or discards.
  useEffect(() => {
    if (mode !== 'create' || workingId || !documentState) return;
    saveComposerDraft('estimate', documentState, lineState);
  }, [documentState, lineState, mode, workingId]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);

  useEffect(() => {
    setAutoSaveMeta(dirty
      ? { label: 'Unsaved changes', tone: 'warning' }
      : { label: workingId ? 'Saved changes' : 'Not saved yet', tone: dirty ? 'warning' : 'saved' });
  }, [dirty, workingId]);

async function saveDocumentNow(nextDocument: EstimateComposerDocument, nextLines: EstimateComposerLineRow[]) {
    if (!workingId) {
      // New estimate: POST with full payload so the INSERT is complete and the
      // Zoho webhook fires against a record that already has buyer + line items.
      const payload = toSavePayload(nextDocument, nextLines);
      const res = await apiPost('/api/tenant/estimates', payload);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? 'Failed to create estimate');
      }
      const json = await res.json() as { data: EstimateComposerDocument };
      const created = json.data;
      qc.setQueryData(['tenant-estimate-composer', created.id], created);
      clearComposerDraft('estimate');
      if (!isLeavingRef.current) {
        setWorkingId(created.id);
      }
      return created;
    }

    const payload = toSavePayload(nextDocument, nextLines);
    return new Promise<EstimateComposerDocument>((resolve, reject) => {
      saveMutation.mutate(payload, {
        onSuccess: ({ data: saved }) => resolve(saved),
        onError: (mutationError) => reject(mutationError),
      });
    });
  }

  if (orderManagement === false || estimatesFlag === false) {
    return <FeatureDisabledState />;
  }

  if (isError) {
    if (error instanceof Error && error.message === 'forbidden') {
      return <PermissionDenied />;
    }
    return (
      <div className="max-w-[1920px] mx-auto w-full px-8 pt-7 pb-6">
        <p className="text-base text-danger-700">{error instanceof Error ? error.message : 'Failed to load estimate composer.'}</p>
      </div>
    );
  }

  if (shouldBlockComposer(workingId, isLoading, Boolean(documentState))) {
    return <SharedDocumentComposerLoadingSkeleton />;
  }

  if (!documentState) {
    return <SharedDocumentComposerLoadingSkeleton />;
  }

  const buyer = documentState.buyer_context ?? buyerContextQuery.data ?? null;
  const activeLines = diffLines.filter((line) => line.diff !== 'removed');
  const primaryDisabled = mode === 'edit' && documentState.status === 'sent'
    ? !dirty || activeLines.length === 0
    : !documentState.buyer_id || activeLines.length === 0;
  const overLimitBy = buyer ? totals.grand_total - buyer.credit_available : 0;
  const creditWarning = buyer && overLimitBy > 0
    ? `Over limit by ${formatNumberValue(overLimitBy, 'CURRENCY_EXACT')}. Estimate can still be sent — converting to SO needs approval.`
    : null;
  const isInterState = Boolean(
    buyer?.seller_state
    && buyer?.place_of_supply
    && buyer.seller_state.toLowerCase() !== buyer.place_of_supply.toLowerCase(),
  );
  const whatsappSend = composerBuyerMatches && data?.whatsapp_send
    ? data.whatsapp_send
    : buyerSendStateQuery.data ?? WHATSAPP_SEND_UNAVAILABLE;

  function setDocumentPatch(patch: Partial<EstimateComposerDocument>) {
    setDocumentState((current) => current ? { ...current, ...patch } : current);
  }

  function handleSelectBuyer(buyerId: string) {
    setDocumentPatch({
      buyer_id: buyerId,
      buyer_context: null,
    });
    setSelectedPriceListId(null);
    setBuyerQuery('');
    setProductQuery('');
    setBuyerSearchOpen(false);
    setSearchOpen(false);
  }

  function handleAddProduct(product: EstimateComposerProductSearchRow) {
    const lineId = `draft-line-${Date.now()}-${product.tenant_product_id}`;
    setLineState((current) => [
      ...current,
      {
        id: lineId,
        tenant_product_id: product.tenant_product_id,
        product_name: product.product_name,
        sku: product.sku,
        brand_name: product.brand_name,
        brand_initials: product.brand_initials,
        brand_hue: product.brand_hue,
        hsn_code: product.hsn_code,
        on_hand: product.on_hand,
        qty: 1,
        unit_price: product.unit_price,
        mrp: product.mrp,
        base_selling_price: product.base_selling_price,
        disc_pct: 0,
        tax_pct: product.tax_pct ?? 0,
        line_total: computeLineTaxableAmount({ qty: 1, unit_price: product.unit_price, disc_pct: 0 }),
        scheme_tag: null,
        diff: 'added',
      },
    ]);
    setAutoFocusLineId(lineId);
  }

  function handleLineChange(lineId: string, patch: Partial<EstimateComposerLineRow>) {
    setLineState((current) =>
      current.map((line) => {
        if (line.id !== lineId) return line;
        const next = { ...line, ...patch };
        return {
          ...next,
          line_total: computeLineTaxableAmount(next),
        };
      }),
    );
  }

  function handleRemoveLine(lineId: string) {
    setLineState((current) =>
      current
        .map((line) => (line.id === lineId ? { ...line, diff: 'removed' as const } : line))
        .filter((line) => !(line.id === lineId && line.id.startsWith('draft-line-'))),
    );
  }

  function handleResetOverrides() {
    setLineState((current) =>
      current.map((line) => {
        if (line.diff === 'removed') return line;
        const original = originalLinesRef.current.find((item) => item.id === line.id);
        const nextUnitPrice = original?.unit_price ?? pricingQuery.data?.[line.tenant_product_id] ?? line.unit_price;
        const nextDiscPct = original?.disc_pct ?? 0;
        const nextTaxPct = original?.tax_pct ?? line.tax_pct;
        const next = {
          ...line,
          unit_price: nextUnitPrice,
          disc_pct: nextDiscPct,
          tax_pct: nextTaxPct,
        };
        return {
          ...next,
          line_total: computeLineTaxableAmount(next),
        };
      }),
    );
  }

  function handleDiscard() {
    dirtyGuard.handleOpenChange(false);
  }

  async function handleSaveAndClose() {
    if (!documentState || isLeavingRef.current) return;
    beginLeaving('save');
    try {
      const saved = await saveDocumentNow(documentState, diffLines);
      router.push(`${SELLER_ROUTES.sales.estimates}/${saved.id}`);
    } catch (mutationError) {
      resetLeaving();
      toast.error(mutationError instanceof Error ? mutationError.message : 'Failed to save estimate');
    }
  }

  async function handleSend() {
    if (!documentState || isLeavingRef.current) return;
    beginLeaving('send');
    try {
      const saved = await saveDocumentNow(documentState, diffLines);
      const targetId = saved.id;

      const res = await apiPatch(`/api/tenant/estimates/${targetId}/send`, {});
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? 'Failed to send estimate');
      }

      qc.setQueryData<EstimateComposerDocument>(['tenant-estimate-composer', targetId], {
        ...saved,
        status: saved.status === 'draft' ? 'sent' : saved.status,
        sent_at: new Date().toISOString(),
        sent_channel: 'whatsapp',
      });
      void qc.invalidateQueries({ queryKey: ['tenant-estimate-detail', targetId] });
      void qc.invalidateQueries({ queryKey: ['tenant-estimate-composer', targetId] });
      void qc.invalidateQueries({ queryKey: ['inbox-entry-enquiry'] });
      void qc.invalidateQueries({ queryKey: ['tenant-estimates'] });
      void qc.invalidateQueries({ queryKey: ['tenant-estimates-infinite'] });
      toast.success('Estimate sent');

      setSendOpen(false);
      router.push(`${SELLER_ROUTES.sales.estimates}/${targetId}`);
    } catch (mutationError) {
      resetLeaving();
      toast.error(mutationError instanceof Error ? mutationError.message : 'Failed to send estimate');
    }
  }

  const footerLabel = composerSubmitFooterLabel(submitAction) ?? autoSaveMeta.label;
  const footerTone = submitAction ? 'pending' as const : autoSaveMeta.tone;
  const sendPrimaryLabel = mode === 'edit' ? 'Save & resend' : 'Send estimate';

  return (
    <>
      <DocumentComposerShell
        mode={mode === 'edit' ? 'edit' : 'create'}
        kind="estimate"
        title={mode === 'edit' ? 'Edit estimate' : 'Add an estimate'}
        subtitle={buyer ? `${buyer.business_name}` : 'Pick a buyer to begin composing this estimate.'}
        status={
          mode === 'edit' && documentState.status === 'sent'
            ? { label: 'Editing live draft', tone: 'live' }
            : { label: 'Draft', tone: 'draft' }
        }
        titleActions={(
          <>
            <Button type="button" variant="ghost" className="gap-2" disabled={isSubmitting} onClick={() => dirtyGuard.handleOpenChange(false)}>
              <X className="h-3.5 w-3.5" />
              Close
            </Button>
          </>
        )}
        onRequestClose={() => dirtyGuard.handleOpenChange(false)}
        body={(
          <div className="flex min-h-0 flex-1 flex-col gap-4">
            {documentState.buyer_id && buyerContextQuery.isLoading && !buyer ? (
              <BuyerCardLoading />
            ) : buyer ? (
              <DocumentCustomerStrip
                buyer={buyer}
                previewTotal={totals.grand_total}
                paymentTermsValue={paymentTermsLabel}
                mode="edit"
                placeOfSupplyValue={documentState.place_of_supply}
                onPlaceOfSupplyChange={(value) => setDocumentPatch({ place_of_supply: value })}
                priceListOptions={priceListOptionsQuery.data ?? []}
                selectedPriceListId={selectedPriceListId}
                onPriceListChange={setSelectedPriceListId}
                onChangeBuyer={() => {
                  setSelectedPriceListId(null);
                  setDocumentPatch({ buyer_id: null, buyer_context: null });
                }}
              />
            ) : (
              <BuyerCardEmpty
                query={buyerQuery}
                results={buyerPickerQuery.data ?? []}
                searchOpen={buyerSearchOpen}
                searchLoading={buyerPickerQuery.isLoading}
                onQueryChange={setBuyerQuery}
                onSearchOpenChange={setBuyerSearchOpen}
                onSelectBuyer={handleSelectBuyer}
              />
            )}
            <DocumentBasicsStrip
              kind="estimate"
              docNumber={documentState.estimate_number}
              locationId={documentState.location_id}
              locationName={documentState.location_name}
              availableLocations={availableLocationOptions}
              dateIssued={documentState.estimate_date}
              secondDate={documentState.valid_until}
              buyerPoRef={documentState.buyer_po_ref}
              onDateIssuedChange={(value) => {
                setDocumentState((current) => {
                  if (!current) return current;
                  const bumped = bumpSecondDateAfterFirst(value, current.valid_until);
                  return bumped
                    ? { ...current, estimate_date: value, valid_until: bumped }
                    : { ...current, estimate_date: value };
                });
              }}
              onSecondDateChange={(value) => setDocumentPatch({ valid_until: value })}
              onBuyerPoRefChange={(value) => setDocumentPatch({ buyer_po_ref: value })}
              onLocationChange={(value) => setDocumentPatch({ location_id: value })}
            />
            <LinesTable
              buyerSelected={Boolean(documentState.buyer_id)}
              readOnly={false}
              lines={diffLines}
              productQuery={productQuery}
              productResults={filteredProductSearchResults}
              searchOpen={searchOpen}
              productSearchLoading={productSearchQuery.isLoading}
              productSearchFetchingNextPage={productSearchQuery.isFetchingNextPage}
              productSearchHasMore={productSearchQuery.hasNextPage}
              onProductSearchLoadMore={() => {
                if (productSearchQuery.hasNextPage && !productSearchQuery.isFetchingNextPage) {
                  void productSearchQuery.fetchNextPage();
                }
              }}
              notesExpanded={false}
              freightExpanded={false}
              internalExpanded={false}
              singleNoteMode
              title="Estimate lines"
              description="Search and add Products to this estimate"
              autoFocusLineId={autoFocusLineId}
              onAutoFocusHandled={() => setAutoFocusLineId(null)}
              showNotesControls={false}
              showFreightControls={false}
              notesValue={documentState.seller_note}
              freightValue={String(documentState.freight || '')}
              internalValue=""
              onProductQueryChange={setProductQuery}
              onSearchOpenChange={setSearchOpen}
              onAddProduct={handleAddProduct}
              onResetOverrides={handleResetOverrides}
              resetEnabled={mode === 'edit' || dirty}
              onLineChange={handleLineChange}
              onRemoveLine={handleRemoveLine}
              onNotesValueChange={(value) => setDocumentPatch({ seller_note: value })}
              onFreightValueChange={(value) => setDocumentPatch({ freight: Number(value || 0) })}
              onInternalValueChange={(value) => setDocumentPatch({ seller_note: value })}
              onToggleNotes={() => {}}
              onToggleFreight={() => {}}
              onToggleInternal={() => {}}
            />
            <TotalsCard
              title="Estimate summary"
              totals={totals}
              previousTotals={null}
              creditWarning={creditWarning}
              isInterState={isInterState}
              lineCount={activeLines.length}
              stagedChanges={stagedChangesRows}
              stagedCallout={
                mode === 'edit' && dirty && documentState.status === 'sent' ? (
                  <span>Saving these edits stages a new version before the estimate is re-sent.</span>
                ) : undefined
              }
            />
          </div>
        )}
        footer={(
          <DocumentComposerFooterRow autoSaveLabel={footerLabel} autoSaveTone={footerTone}>
            <Button type="button" variant="ghost" className="gap-2" disabled={isSubmitting} onClick={handleDiscard}>
              <Trash2 className="h-4 w-4" />
              Discard draft
            </Button>
            <Button
              type="button"
              variant="primary"
              className="gap-2"
              disabled={isSubmitting && submitAction !== 'save'}
              onClick={() => void handleSaveAndClose()}
            >
              {submitAction === 'save' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
              {submitAction === 'save' ? 'Saving…' : 'Save as draft'}
            </Button>
            <Button
              type="button"
              variant="accent"
              className={primaryDisabled && submitAction !== 'send' ? 'btn-disabled gap-2' : 'gap-2'}
              disabled={(primaryDisabled || isSubmitting) && submitAction !== 'send'}
              onClick={() => setSendOpen(true)}
            >
              {submitAction === 'send' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {submitAction === 'send' ? 'Sending…' : sendPrimaryLabel}
            </Button>
          </DocumentComposerFooterRow>
        )}
      />

      <DiscardChangesDialog
        open={dirtyGuard.discardOpen}
        onOpenChange={dirtyGuard.setDiscardOpen}
        onDiscard={dirtyGuard.confirmDiscard}
      />

      <SendDocumentWhatsAppDialog
        open={sendOpen}
        onOpenChange={setSendOpen}
        title="Send estimate"
        confirmLabel={sendPrimaryLabel}
        isPending={submitAction === 'send'}
        sendState={whatsappSend}
        buyerName={buyer?.business_name ?? '—'}
        phoneNumber={whatsappSend.recipient_phone}
        documentNumberLabel="Estimate Number"
        documentNumber={documentState.estimate_number}
        amount={totals.grand_total}
        itemCount={activeLines.length}
        onConfirm={() => {
          void handleSend();
        }}
      />
    </>
  );
}

export { DocumentComposerLoadingSkeleton as EstimateComposerLoadingSkeleton } from '@/components/seller/composer/DocumentComposerShell';
