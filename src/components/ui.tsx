/**
 * Interface primitives.
 *
 * Every control here responds on pointer-down rather than on release, and every
 * transition uses a spring-like curve rather than a linear one, so pressing
 * something feels like moving an object instead of waiting for a state change.
 */

import { forwardRef, useId, type ReactNode } from 'react';
import { CaretDownIcon } from '@phosphor-icons/react';

export function cx(
  ...parts: (string | false | 0 | null | undefined)[]
): string {
  return parts.filter(Boolean).join(' ');
}

/* -------------------------------------------------------------------------- */
/* Button                                                                     */
/* -------------------------------------------------------------------------- */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  /** Rendered in its own circular well at the trailing edge. */
  trailingIcon?: ReactNode;
}

const BUTTON_BASE =
  'group relative inline-flex items-center justify-center gap-2 font-medium ' +
  'select-none whitespace-nowrap transition-[transform,background-color,border-color,box-shadow,color] ' +
  'duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.975] ' +
  'disabled:pointer-events-none disabled:opacity-45';

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px] rounded-[var(--radius-control)]',
  md: 'h-9.5 px-4 text-[13.5px] rounded-full',
  lg: 'h-11 pl-5 pr-2 text-[15px] rounded-full',
};

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--accent)] text-white shadow-[var(--shadow-sm)] ' +
    'hover:bg-[var(--accent-hover)] active:bg-[var(--accent-press)]',
  secondary:
    'bg-[var(--surface)] text-[var(--text)] border border-[var(--border-strong)] ' +
    'shadow-[var(--shadow-sm)] hover:bg-[var(--surface-2)] hover:border-[var(--accent)]',
  ghost:
    'bg-transparent text-[var(--text-2)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent)]',
  danger:
    'bg-[var(--danger-soft)] text-[var(--danger)] border border-transparent ' +
    'hover:border-[var(--danger)]',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, trailingIcon, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cx(BUTTON_BASE, BUTTON_SIZES[size], BUTTON_VARIANTS[variant], className)}
      {...rest}
    >
      {icon}
      {children}
      {trailingIcon ? (
        // The icon sits in its own well, and shifts on hover so the button has
        // internal movement rather than only changing colour.
        <span
          className={cx(
            'ml-1 grid size-7 place-items-center rounded-full',
            'bg-white/18 transition-transform duration-300',
            'ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:translate-x-0.5',
            variant !== 'primary' && 'bg-[var(--accent-soft)]',
          )}
        >
          {trailingIcon}
        </span>
      ) : null}
    </button>
  );
});

/* -------------------------------------------------------------------------- */
/* Text field                                                                 */
/* -------------------------------------------------------------------------- */

interface FieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label: string;
  hint?: string;
  error?: string;
  /** Shown when several selected tracks disagree on this field. */
  mixed?: boolean;
  adornment?: ReactNode;
}

const CONTROL_SURFACE =
  'w-full rounded-[var(--radius-control)] border border-[var(--border)] ' +
  'bg-[var(--surface-2)] px-2.5 text-[13.5px] text-[var(--text)] ' +
  'placeholder:text-[var(--text-3)] transition-colors duration-150 ' +
  'hover:border-[var(--border-strong)] focus:border-[var(--accent)] ' +
  'focus:bg-[var(--surface)] focus:outline-none ' +
  'focus:ring-[3px] focus:ring-[var(--accent-ring)]';

export function Field({
  label, hint, error, mixed, adornment, className, ...rest
}: FieldProps) {
  const id = useId();

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="label-tiny">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          className={cx(
            CONTROL_SURFACE,
            'h-9',
            Boolean(adornment) && 'pr-9',
            error && 'border-[var(--danger)]',
            className,
          )}
          placeholder={mixed ? 'Multiple values' : rest.placeholder}
          {...rest}
        />
        {adornment ? (
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-3)]">
            {adornment}
          </span>
        ) : null}
      </div>
      {error ? (
        <p className="text-[11.5px] text-[var(--danger)]">{error}</p>
      ) : hint ? (
        <p className="text-[11.5px] leading-snug text-[var(--text-3)]">{hint}</p>
      ) : null}
    </div>
  );
}

interface NumberFieldProps extends Omit<FieldProps, 'value' | 'onChange'> {
  value: number;
  onValueChange: (value: number) => void;
  /** Render 0 as an empty box, for fields where 0 means "unset". */
  blankZero?: boolean;
}

export function NumberField({
  value, onValueChange, blankZero = true, ...rest
}: NumberFieldProps) {
  return (
    <Field
      type="number"
      inputMode="numeric"
      value={blankZero && value === 0 ? '' : String(value)}
      onChange={(event) => onValueChange(Number.parseInt(event.target.value, 10) || 0)}
      className="numeric"
      {...rest}
    />
  );
}

interface TextAreaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  hint?: string;
}

export function TextArea({ label, hint, className, ...rest }: TextAreaProps) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="label-tiny">
        {label}
      </label>
      <textarea
        id={id}
        className={cx(CONTROL_SURFACE, 'resize-y py-2 leading-relaxed', className)}
        {...rest}
      />
      {hint ? <p className="text-[11.5px] text-[var(--text-3)]">{hint}</p> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Select                                                                     */
/* -------------------------------------------------------------------------- */

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  hint?: string;
  options: { value: string; label: string }[];
}

export function Select({ label, hint, options, className, ...rest }: SelectProps) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      {label ? (
        <label htmlFor={id} className="label-tiny">
          {label}
        </label>
      ) : null}
      <div className="relative">
        <select
          id={id}
          className={cx(CONTROL_SURFACE, 'h-9 appearance-none pr-8', className)}
          {...rest}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <CaretDownIcon
          size={13}
          weight="bold"
          className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)]"
        />
      </div>
      {hint ? (
        <p className="text-[11.5px] leading-snug text-[var(--text-3)]">{hint}</p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Segmented control                                                          */
/* -------------------------------------------------------------------------- */

interface SegmentedProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string; title?: string }[];
  label?: string;
}

export function Segmented<T extends string>({
  value, onChange, options, label,
}: SegmentedProps<T>) {
  return (
    <div className="flex flex-col gap-1.5">
      {label ? <span className="label-tiny">{label}</span> : null}
      <div
        role="radiogroup"
        className="inline-flex gap-0.5 rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface-sunken)] p-0.5"
      >
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              title={option.title}
              onPointerDown={() => onChange(option.value)}
              className={cx(
                'flex-1 rounded-[6px] px-3 py-1.5 text-[12.5px] font-medium',
                'transition-all duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]',
                active
                  ? 'bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-sm)]'
                  : 'text-[var(--text-2)] hover:text-[var(--text)]',
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Toggle                                                                     */
/* -------------------------------------------------------------------------- */

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export function Toggle({ checked, onChange, label, hint, disabled }: ToggleProps) {
  return (
    <label
      className={cx(
        'flex cursor-pointer items-start justify-between gap-4 py-1',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <span className="flex flex-col gap-0.5">
        <span className="text-[13px] font-medium text-[var(--text)]">{label}</span>
        {hint ? (
          <span className="text-[11.5px] leading-snug text-[var(--text-3)]">{hint}</span>
        ) : null}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onPointerDown={() => !disabled && onChange(!checked)}
        className={cx(
          'relative mt-0.5 h-[22px] w-[38px] shrink-0 rounded-full',
          'transition-colors duration-250 ease-[cubic-bezier(0.32,0.72,0,1)]',
          checked ? 'bg-[var(--accent)]' : 'bg-[var(--border-strong)]',
        )}
      >
        <span
          className={cx(
            'absolute top-[3px] size-4 rounded-full bg-white shadow-sm',
            'transition-transform duration-250 ease-[cubic-bezier(0.32,0.72,0,1)]',
            checked ? 'translate-x-[19px]' : 'translate-x-[3px]',
          )}
        />
      </button>
    </label>
  );
}

/* -------------------------------------------------------------------------- */
/* Badges and readouts                                                        */
/* -------------------------------------------------------------------------- */

type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'bad';

const TONE_STYLES: Record<Tone, string> = {
  neutral: 'bg-[var(--surface-3)] text-[var(--text-2)]',
  accent: 'bg-[var(--accent-soft)] text-[var(--accent)]',
  ok: 'bg-[var(--success-soft)] text-[var(--success)]',
  warn: 'bg-[var(--warning-soft)] text-[var(--warning)]',
  bad: 'bg-[var(--danger-soft)] text-[var(--danger)]',
};

export function Badge({
  tone = 'neutral', children, className, title,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5',
        'text-[10.5px] font-semibold tracking-[0.01em]',
        TONE_STYLES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A labelled number, sized for scanning down a column. */
export function Stat({
  label, value, unit, tone = 'neutral', hint,
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: Tone;
  hint?: string;
}) {
  const valueTone =
    tone === 'neutral'
      ? 'text-[var(--text)]'
      : tone === 'ok'
        ? 'text-[var(--success)]'
        : tone === 'warn'
          ? 'text-[var(--warning)]'
          : tone === 'bad'
            ? 'text-[var(--danger)]'
            : 'text-[var(--accent)]';

  return (
    <div className="flex flex-col gap-0.5" title={hint}>
      <span className="label-tiny">{label}</span>
      <span className={cx('numeric text-[17px] font-semibold', valueTone)}>
        {value}
        {unit ? (
          <span className="ml-0.5 text-[11px] font-medium text-[var(--text-3)]">
            {unit}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/**
 * A horizontal scale showing where a value sits between two bounds.
 *
 * Used for loudness, where the useful information is the distance from target
 * rather than the absolute number.
 */
export function ScaleMeter({
  value, min, max, target, tone = 'accent',
}: {
  value: number;
  min: number;
  max: number;
  target?: number;
  tone?: Tone;
}) {
  if (!Number.isFinite(value)) {
    return <div className="h-1.5 rounded-full bg-[var(--surface-3)]" />;
  }

  const clamp = (input: number) =>
    Math.max(0, Math.min(100, ((input - min) / (max - min)) * 100));

  const fillColor =
    tone === 'ok'
      ? 'var(--success)'
      : tone === 'warn'
        ? 'var(--warning)'
        : tone === 'bad'
          ? 'var(--danger)'
          : 'var(--accent)';

  return (
    <div className="relative h-1.5 rounded-full bg-[var(--surface-3)]">
      <div
        className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-[cubic-bezier(0.32,0.72,0,1)]"
        style={{ width: `${clamp(value)}%`, background: fillColor }}
      />
      {target !== undefined ? (
        <div
          className="absolute -top-0.5 h-2.5 w-0.5 rounded-full bg-[var(--text-2)]"
          style={{ left: `${clamp(target)}%` }}
          title={`Target ${target}`}
        />
      ) : null}
    </div>
  );
}

/** Section heading used inside the inspector panels. */
export function SectionTitle({
  children, action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h3 className="text-[12.5px] font-semibold tracking-[-0.005em] text-[var(--text)]">
        {children}
      </h3>
      {action}
    </div>
  );
}

/** Thin divider that reads as a hairline rather than a border. */
export function Divider({ className }: { className?: string }) {
  return <div className={cx('h-px bg-[var(--hairline)]', className)} />;
}
