import { useId, useState } from 'react';
import { Input } from '@/components/ui/input';
import { parseRupeesToPaise, paiseToRupeesString, type Paise, type ParseOptions } from '@/lib/money';
import { cn } from '@/lib/utils';

interface MoneyInputProps extends ParseOptions {
  /** Current value in paise; null = empty/invalid. */
  value: Paise | null;
  onChange: (paise: Paise | null, error: string | null) => void;
  id?: string;
  name?: string;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
  'aria-describedby'?: string;
}

/** Rupee text input → integer paise via string parsing (never floats). */
export function MoneyInput({
  value,
  onChange,
  allowNegative,
  allowZero,
  id,
  name,
  disabled,
  invalid,
  className,
  ...aria
}: MoneyInputProps) {
  const autoId = useId();
  const [text, setText] = useState(() => (value === null ? '' : paiseToRupeesString(value)));
  const [error, setError] = useState<string | null>(null);

  return (
    <div className={cn('relative', className)}>
      <span
        aria-hidden="true"
        className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
      >
        ₹
      </span>
      <Input
        id={id ?? autoId}
        name={name}
        inputMode="decimal"
        autoComplete="off"
        disabled={disabled}
        aria-invalid={invalid || error !== null || undefined}
        aria-describedby={aria['aria-describedby']}
        className="pl-7 tabular-nums"
        value={text}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          if (next.trim() === '') {
            setError(null);
            onChange(null, null);
            return;
          }
          const r = parseRupeesToPaise(next, { allowNegative, allowZero });
          setError(r.ok ? null : r.error);
          onChange(r.ok ? r.paise : null, r.ok ? null : r.error);
        }}
        onBlur={() => {
          const r = parseRupeesToPaise(text, { allowNegative, allowZero });
          if (r.ok) setText(paiseToRupeesString(r.paise));
        }}
      />
    </div>
  );
}
