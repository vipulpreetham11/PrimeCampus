import { useState, type ReactNode } from 'react';
import type { Control, FieldPath, FieldValues } from 'react-hook-form';
import { DateInput } from '@/components/shared/DateInput';
import { MoneyInput } from '@/components/shared/MoneyInput';
import { Checkbox } from '@/components/ui/checkbox';
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

// Thin RHF wrappers over shadcn Form so every M1 form gets the same label / error / aria wiring.

interface BaseProps<T extends FieldValues> {
  control: Control<T>;
  name: FieldPath<T>;
  label: ReactNode;
  description?: ReactNode;
  className?: string;
  disabled?: boolean;
}

export function TextField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  className,
  disabled,
  type = 'text',
  inputMode,
  autoComplete = 'off',
  placeholder,
}: BaseProps<T> & {
  type?: 'text' | 'email' | 'tel' | 'number' | 'time' | 'password';
  inputMode?: 'text' | 'numeric' | 'tel' | 'email' | 'decimal';
  autoComplete?: string;
  placeholder?: string;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              type={type}
              inputMode={inputMode}
              autoComplete={autoComplete}
              placeholder={placeholder}
              disabled={disabled}
              {...field}
              value={(field.value as string | number | null | undefined) ?? ''}
            />
          </FormControl>
          {description && <FormDescription>{description}</FormDescription>}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

export function TextAreaField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  className,
  disabled,
}: BaseProps<T>) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Textarea
              disabled={disabled}
              {...field}
              value={(field.value as string | null | undefined) ?? ''}
            />
          </FormControl>
          {description && <FormDescription>{description}</FormDescription>}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

export interface Option {
  value: string;
  label: string;
}

export function SelectField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  className,
  disabled,
  options,
  placeholder = 'Choose…',
}: BaseProps<T> & { options: readonly Option[]; placeholder?: string }) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <FormLabel>{label}</FormLabel>
          <Select
            value={(field.value as string | undefined) ?? ''}
            onValueChange={field.onChange}
            disabled={disabled}
          >
            <FormControl>
              <SelectTrigger className="w-full" onBlur={field.onBlur} ref={field.ref}>
                <SelectValue placeholder={placeholder} />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {description && <FormDescription>{description}</FormDescription>}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

export function DateField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  className,
  disabled,
  min,
  max,
}: BaseProps<T> & { min?: string; max?: string }) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <FormItem className={className}>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <DateInput
              value={(field.value as string | null | undefined) ?? ''}
              onChange={field.onChange}
              min={min}
              max={max}
              disabled={disabled}
              invalid={!!fieldState.error}
            />
          </FormControl>
          {description && <FormDescription>{description}</FormDescription>}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

export function CheckboxField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  className,
  disabled,
}: BaseProps<T>) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className={cn('flex flex-row items-start gap-2 space-y-0', className)}>
          <FormControl>
            <Checkbox
              checked={!!field.value}
              onCheckedChange={(v) => field.onChange(v === true)}
              disabled={disabled}
              ref={field.ref}
            />
          </FormControl>
          <div className="grid gap-1 leading-none">
            <FormLabel className="font-normal">{label}</FormLabel>
            {description && <FormDescription>{description}</FormDescription>}
            <FormMessage />
          </div>
        </FormItem>
      )}
    />
  );
}

/** Rupee amount stored in the form as integer paise (or null when empty). Shows MoneyInput's parse error. */
export function MoneyField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  className,
  disabled,
}: BaseProps<T>) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <MoneyFieldItem
          className={className}
          label={label}
          description={description}
          disabled={disabled}
          value={(field.value as number | null | undefined) ?? null}
          onChange={field.onChange}
          invalid={!!fieldState.error}
        />
      )}
    />
  );
}

function MoneyFieldItem({
  className,
  label,
  description,
  disabled,
  value,
  onChange,
  invalid,
}: {
  className?: string;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  value: number | null;
  onChange: (paise: number | null) => void;
  invalid: boolean;
}) {
  const [parseError, setParseError] = useState<string | null>(null);
  return (
    <FormItem className={className}>
      <FormLabel>{label}</FormLabel>
      <FormControl>
        <MoneyInput
          value={value}
          onChange={(paise, error) => {
            setParseError(error);
            onChange(paise);
          }}
          disabled={disabled}
          invalid={invalid || parseError !== null}
        />
      </FormControl>
      {description && <FormDescription>{description}</FormDescription>}
      {parseError ? <p className="text-destructive text-sm">{parseError}</p> : <FormMessage />}
    </FormItem>
  );
}
