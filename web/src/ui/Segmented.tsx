import './Forms.css';
import './Segmented.css';
type SegmentedProps<V extends string> = {
  label: string;
  value: V;
  options: readonly (readonly [V, string])[];
  onChange(value: V): void;
  disabled?: boolean;
};

export function Segmented<V extends string>({ label, value, options, onChange, disabled }: SegmentedProps<V>) {
  return (
    <div className="setrow">
      <span>{label}</span>
      <div className="seg" role="group" aria-label={label}>
        {options.map(([v, text]) => <button key={v} type="button" disabled={disabled} aria-pressed={v === value} onClick={() => onChange(v)}>{text}</button>)}
      </div>
    </div>
  );
}
