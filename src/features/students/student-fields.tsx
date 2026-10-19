import type { Control, FieldValues, Path } from 'react-hook-form';
import { z } from '@/lib/zod';
import { CheckboxField, DateField, SelectField, TextField } from '@/components/shared/form-fields';
import { BLOOD_GROUPS, type StudentCore } from '@/contracts/students';
import { compareIsoDates } from '@/lib/dates';
import { blankToNull } from '@/lib/save-feedback';

// Student profile fields (UDISE+ 4.1 general profile layout), shared by edit and admit.
// Rules mirror the app.students CHECK constraints so the server rarely has to refuse.

const opt = (re: RegExp, msg: string) =>
  z
    .string()
    .trim()
    .refine((v) => v === '' || re.test(v), msg);
const maxLen = (n: number) => z.string().trim().max(n, `At most ${n} characters`);

export const NO_BLOOD = 'unknown';

export const studentFieldsShape = {
  full_name: z.string().trim().min(1, 'Enter the student’s name').max(200),
  gender: z.enum(['female', 'male', 'transgender'], { message: 'Choose a gender' }),
  date_of_birth: z
    .string()
    .min(1, 'Enter the date of birth')
    .refine((d) => !d || compareIsoDates(d, '1990-01-01') > 0, 'Date of birth must be after 1 Jan 1990'),
  mother_name: maxLen(200),
  father_name: maxLen(200),
  guardian_name: maxLen(200),
  address_line: maxLen(500),
  pincode: opt(/^[0-9]{6}$/, 'Pincode is 6 digits'),
  mobile: opt(/^[0-9]{10}$/, '10-digit mobile number'),
  alt_mobile: opt(/^[0-9]{10}$/, '10-digit mobile number'),
  email: opt(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'Enter a valid email'),
  mother_tongue: maxLen(60),
  is_indian_national: z.boolean(),
  nationality: maxLen(60),
  blood_group: z.string(),
  previous_school: maxLen(200),
  previous_class: maxLen(40),
};

export const nationalityRule = (v: { is_indian_national: boolean; nationality: string }) =>
  v.is_indian_national || v.nationality.trim() !== '';
export const nationalityIssue = { path: ['nationality'], message: 'Enter the nationality' };

export type StudentFieldValues = {
  [K in keyof typeof studentFieldsShape]: z.infer<(typeof studentFieldsShape)[K]>;
};

export function emptyStudentFields(): StudentFieldValues {
  return {
    full_name: '',
    gender: '' as unknown as StudentFieldValues['gender'],
    date_of_birth: '',
    mother_name: '',
    father_name: '',
    guardian_name: '',
    address_line: '',
    pincode: '',
    mobile: '',
    alt_mobile: '',
    email: '',
    mother_tongue: '',
    is_indian_national: true,
    nationality: '',
    blood_group: NO_BLOOD,
    previous_school: '',
    previous_class: '',
  };
}

export function studentFieldsFrom(s: StudentCore): StudentFieldValues {
  return {
    full_name: s.full_name,
    gender: s.gender,
    date_of_birth: s.date_of_birth,
    mother_name: s.mother_name ?? '',
    father_name: s.father_name ?? '',
    guardian_name: s.guardian_name ?? '',
    address_line: s.address_line ?? '',
    pincode: s.pincode ?? '',
    mobile: s.mobile ?? '',
    alt_mobile: s.alt_mobile ?? '',
    email: s.email ?? '',
    mother_tongue: s.mother_tongue ?? '',
    is_indian_national: s.is_indian_national,
    nationality: s.nationality ?? '',
    blood_group: s.blood_group ?? NO_BLOOD,
    previous_school: s.previous_school ?? '',
    previous_class: s.previous_class ?? '',
  };
}

/** Form values → RPC payload (blank → null; nationality cleared for Indian nationals). */
export function studentPayload(v: StudentFieldValues): Record<string, string | boolean | null> {
  return {
    full_name: v.full_name.trim(),
    gender: v.gender,
    date_of_birth: v.date_of_birth,
    mother_name: blankToNull(v.mother_name),
    father_name: blankToNull(v.father_name),
    guardian_name: blankToNull(v.guardian_name),
    address_line: blankToNull(v.address_line),
    pincode: blankToNull(v.pincode),
    mobile: blankToNull(v.mobile),
    alt_mobile: blankToNull(v.alt_mobile),
    email: blankToNull(v.email),
    mother_tongue: blankToNull(v.mother_tongue),
    is_indian_national: v.is_indian_national,
    nationality: v.is_indian_national ? blankToNull(v.nationality) : v.nationality.trim(),
    blood_group: v.blood_group === NO_BLOOD ? null : v.blood_group,
    previous_school: blankToNull(v.previous_school),
    previous_class: blankToNull(v.previous_class),
  };
}

const GENDER_OPTIONS = [
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
  { value: 'transgender', label: 'Transgender' },
];
const BLOOD_OPTIONS = [
  { value: NO_BLOOD, label: 'Not recorded' },
  ...BLOOD_GROUPS.map((b) => ({ value: b, label: b })),
];

/** The grouped field set; `T` must contain all StudentFieldValues keys. */
export function StudentFieldsSections<T extends FieldValues>({
  control,
  isIndian,
}: {
  control: Control<T>;
  isIndian: boolean;
}) {
  const n = (k: keyof StudentFieldValues) => k as unknown as Path<T>;
  return (
    <>
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">Student</legend>
        <TextField control={control} name={n('full_name')} label="Full name" className="sm:col-span-2" />
        <SelectField control={control} name={n('gender')} label="Gender" options={GENDER_OPTIONS} />
        <DateField control={control} name={n('date_of_birth')} label="Date of birth" min="1990-01-02" />
        <TextField control={control} name={n('mother_tongue')} label="Mother tongue" />
        <SelectField control={control} name={n('blood_group')} label="Blood group" options={BLOOD_OPTIONS} />
        <CheckboxField control={control} name={n('is_indian_national')} label="Indian national" />
        {!isIndian && <TextField control={control} name={n('nationality')} label="Nationality" />}
      </fieldset>
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">Family names (as on records)</legend>
        <TextField control={control} name={n('mother_name')} label="Mother’s name" />
        <TextField control={control} name={n('father_name')} label="Father’s name" />
        <TextField control={control} name={n('guardian_name')} label="Guardian’s name" />
      </fieldset>
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">Contact</legend>
        <TextField control={control} name={n('address_line')} label="Address" className="sm:col-span-2" />
        <TextField control={control} name={n('pincode')} label="Pincode" inputMode="numeric" />
        <TextField control={control} name={n('mobile')} label="Mobile" type="tel" inputMode="numeric" />
        <TextField
          control={control}
          name={n('alt_mobile')}
          label="Alternate mobile"
          type="tel"
          inputMode="numeric"
        />
        <TextField control={control} name={n('email')} label="Email" type="email" />
      </fieldset>
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">Previous school</legend>
        <TextField control={control} name={n('previous_school')} label="School" />
        <TextField control={control} name={n('previous_class')} label="Class" />
      </fieldset>
    </>
  );
}
