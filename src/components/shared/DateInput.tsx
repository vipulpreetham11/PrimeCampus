import { Input } from '@/components/ui/input';
import { isIsoDate, type IsoDate } from '@/lib/dates';

interface DateInputProps {
  /** School-local business date 'YYYY-MM-DD', or '' when not chosen. */
  value: IsoDate | '';
  onChange: (value: IsoDate | '') => void;
  min?: IsoDate;
  max?: IsoDate;
  id?: string;
  name?: string;
  disabled?: boolean;
  invalid?: boolean;
  'aria-describedby'?: string;
}

/**
 * Native date input: its value is already a calendar date string, so there is no
 * time-zone conversion. Defaults (e.g. "today") must come from schoolToday(), never toISOString().
 */
export function DateInput({ value, onChange, invalid, ...rest }: DateInputProps) {
  return (
    <Input
      type="date"
      value={value}
      aria-invalid={invalid || undefined}
      onChange={(e) => onChange(isIsoDate(e.target.value) ? e.target.value : '')}
      {...rest}
    />
  );
}
