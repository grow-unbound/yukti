'use client';

import { useState } from 'react';
import { CalendarRange } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { addDays, type PulsePeriod, type PulsePeriodInput, type PulsePeriodKey } from '@/lib/pulse/period';

const PRESETS: Array<{ key: Exclude<PulsePeriodKey, 'custom'>; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'mtd', label: 'This month' },
  { key: 'qtd', label: 'This quarter' },
  { key: 'last_month', label: 'Last month' },
];

const fmt = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const range = (from: string, toExcl: string) => (toExcl === addDays(from, 1) ? fmt(from) : `${fmt(from)} – ${fmt(addDays(toExcl, -1))}`);

export function PulsePeriodBar({
  period,
  input,
  error,
  onChange,
}: {
  period: PulsePeriod | null;
  input: PulsePeriodInput;
  error?: string | null;
  onChange: (next: PulsePeriodInput) => void;
}) {
  const [customOpen, setCustomOpen] = useState(input.period === 'custom');
  const [from, setFrom] = useState(input.from ?? '');
  const [to, setTo] = useState(input.to ?? '');
  const compare = input.compare !== false;
  const activeKey = period?.key ?? 'mtd';

  return (
    <div className="mb-5 space-y-3">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Period">
        {PRESETS.map((preset) => (
          <Button
            key={preset.key}
            type="button"
            size="sm"
            variant={activeKey === preset.key ? 'primary' : 'secondary'}
            aria-pressed={activeKey === preset.key}
            onClick={() => {
              setCustomOpen(false);
              onChange({ period: preset.key, compare });
            }}
          >
            {preset.label}
          </Button>
        ))}
        <Button
          type="button"
          size="sm"
          variant={activeKey === 'custom' ? 'primary' : 'secondary'}
          aria-pressed={activeKey === 'custom'}
          onClick={() => setCustomOpen((open) => !open)}
        >
          <CalendarRange size={16} aria-hidden="true" />
          Custom
        </Button>
        <label className="ml-auto flex items-center gap-2 text-sm font-medium text-cream-700">
          <Switch
            checked={compare}
            onCheckedChange={(checked) => onChange({ ...input, period: activeKey, compare: checked })}
            aria-label="Compare with the previous period"
          />
          Compare
        </label>
      </div>

      {customOpen ? (
        <div className="flex flex-wrap items-end gap-3 rounded-[8px] border border-cream-200 bg-cream-50 p-3">
          <label className="text-sm font-medium text-cream-700">
            From
            <Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="mt-1 w-44" />
          </label>
          <label className="text-sm font-medium text-cream-700">
            To
            <Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="mt-1 w-44" />
          </label>
          <Button type="button" size="sm" disabled={!from || !to} onClick={() => onChange({ period: 'custom', from, to, compare })}>
            Apply
          </Button>
        </div>
      ) : null}

      <p className="text-sm text-cream-700" aria-live="polite">
        {error === 'range_too_long'
          ? 'Choose a range of one year or less.'
          : error
            ? 'Choose a valid date range.'
            : period
              ? (
                <>
                  <span className="font-medium text-cream-900">{period.label}: {range(period.window.from, period.window.toExcl)}</span>
                  {period.compare ? ` · compared with ${range(period.compare.from, period.compare.toExcl)}` : null}
                  {period.thin && compare ? ' · too early in the period to compare' : null}
                </>
              )
              : null}
      </p>
    </div>
  );
}
